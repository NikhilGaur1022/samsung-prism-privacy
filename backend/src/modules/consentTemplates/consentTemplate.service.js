import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'

// DPDP §5 notice. A published template is frozen: the notice a principal actually
// read has to still exist, byte-for-byte, years later when they dispute what they
// agreed to. Editing is therefore modelled as supersession, never mutation.

// §5(3): the notice must be available in English and every Eighth Schedule
// language. We do not machine-translate — an unreviewed translation of a legal
// notice is worse than no translation, so a locale is only offered once a human
// has supplied its body.
export const REQUIRED_LOCALE = 'en'
export const EIGHTH_SCHEDULE_LOCALES = [
  'as', 'bn', 'brx', 'doi', 'gu', 'hi', 'kn', 'ks', 'kok', 'mai', 'ml', 'mni',
  'mr', 'ne', 'or', 'pa', 'sa', 'sat', 'sd', 'ta', 'te', 'ur',
]
export const SUPPORTED_LOCALES = [REQUIRED_LOCALE, ...EIGHTH_SCHEDULE_LOCALES]

const TEMPLATE_FIELDS = {
  id: true,
  name: true,
  version: true,
  status: true,
  purpose: true,
  bodyByLocale: true,
  dataTypes: true,
  retention: true,
  grievanceContact: true,
  supersedesId: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
}

function assertLocales(bodyByLocale) {
  if (!bodyByLocale || typeof bodyByLocale !== 'object' || Array.isArray(bodyByLocale)) {
    throw new ApiError(400, 'bodyByLocale must be an object keyed by locale')
  }
  const locales = Object.keys(bodyByLocale)
  if (!locales.includes(REQUIRED_LOCALE)) {
    throw new ApiError(400, `bodyByLocale must include "${REQUIRED_LOCALE}"`)
  }
  const unknown = locales.filter((l) => !SUPPORTED_LOCALES.includes(l))
  if (unknown.length) {
    throw new ApiError(400, `Unsupported locale(s): ${unknown.join(', ')}`)
  }
  for (const [locale, body] of Object.entries(bodyByLocale)) {
    if (typeof body !== 'string' || body.trim().length < 50) {
      throw new ApiError(400, `Notice body for "${locale}" is too short to be a lawful §5 notice`)
    }
  }
}

export async function listTemplates({ status } = {}) {
  return prisma.consentTemplate.findMany({
    where: status ? { status } : {},
    orderBy: [{ name: 'asc' }, { version: 'desc' }],
    select: TEMPLATE_FIELDS,
  })
}

export async function getTemplate(templateId) {
  const template = await prisma.consentTemplate.findUnique({
    where: { id: templateId },
    select: TEMPLATE_FIELDS,
  })
  if (!template) throw new ApiError(404, 'Consent template not found')
  return template
}

export async function createTemplate(input, admin) {
  assertLocales(input.bodyByLocale)

  // A new version of an existing name must point at what it replaces, so the
  // lineage from "the notice signed in 2024" to today is walkable.
  let version = 1
  let supersedesId = null
  if (input.supersedesId) {
    const parent = await getTemplate(input.supersedesId)
    if (parent.name !== input.name) {
      throw new ApiError(400, 'A superseding template must keep the same name')
    }
    version = parent.version + 1
    supersedesId = parent.id
  } else {
    const latest = await prisma.consentTemplate.findFirst({
      where: { name: input.name },
      orderBy: { version: 'desc' },
      select: { id: true, version: true },
    })
    if (latest) {
      version = latest.version + 1
      supersedesId = latest.id
    }
  }

  const template = await prisma.consentTemplate.create({
    data: {
      name: input.name,
      version,
      status: 'DRAFT',
      purpose: input.purpose,
      bodyByLocale: input.bodyByLocale,
      dataTypes: input.dataTypes ?? null,
      retention: input.retention ?? null,
      grievanceContact: input.grievanceContact ?? null,
      supersedesId,
      createdByAdminId: admin.id,
    },
    select: TEMPLATE_FIELDS,
  })

  await writeAuditLog({
    entityType: 'ConsentTemplate',
    entityId: template.id,
    action: 'TEMPLATE_CREATED',
    actorId: admin.id,
    payload: { name: template.name, version: template.version, supersedesId },
  })

  return template
}

export async function updateDraft(templateId, input, admin) {
  const existing = await getTemplate(templateId)
  if (existing.status !== 'DRAFT') {
    throw new ApiError(409, 'Only a DRAFT template can be edited; publish a new version instead')
  }
  if (input.bodyByLocale) assertLocales(input.bodyByLocale)

  const template = await prisma.consentTemplate.update({
    where: { id: templateId },
    data: {
      purpose: input.purpose ?? undefined,
      bodyByLocale: input.bodyByLocale ?? undefined,
      dataTypes: input.dataTypes ?? undefined,
      retention: input.retention ?? undefined,
      grievanceContact: input.grievanceContact ?? undefined,
    },
    select: TEMPLATE_FIELDS,
  })

  await writeAuditLog({
    entityType: 'ConsentTemplate',
    entityId: templateId,
    action: 'TEMPLATE_UPDATED',
    actorId: admin.id,
    payload: { fields: Object.keys(input) },
  })

  return template
}

export async function publishTemplate(templateId, admin) {
  const existing = await getTemplate(templateId)
  if (existing.status !== 'DRAFT') {
    throw new ApiError(409, `Template is ${existing.status} — only a DRAFT can be published`)
  }
  assertLocales(existing.bodyByLocale)
  if (!existing.grievanceContact) {
    throw new ApiError(400, 'A published notice must carry a grievance contact (DPDP §5(1)(c), §13)')
  }

  // Publishing this version retires the one it supersedes in the same transaction:
  // two PUBLISHED versions of one notice would make "which text did they sign"
  // unanswerable.
  const [template] = await prisma.$transaction([
    prisma.consentTemplate.update({
      where: { id: templateId },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
      select: TEMPLATE_FIELDS,
    }),
    ...(existing.supersedesId
      ? [
          prisma.consentTemplate.updateMany({
            where: { id: existing.supersedesId, status: 'PUBLISHED' },
            data: { status: 'SUPERSEDED' },
          }),
        ]
      : []),
  ])

  await writeAuditLog({
    entityType: 'ConsentTemplate',
    entityId: templateId,
    action: 'TEMPLATE_PUBLISHED',
    actorId: admin.id,
    payload: { name: template.name, version: template.version, supersededId: existing.supersedesId },
  })

  return template
}

// The exact artifact shown to a principal before the signature control. Callers
// render this and nothing else — the join flow must never assemble notice text
// of its own, or the text signed stops matching the text stored.
export async function renderNotice(templateId, locale = REQUIRED_LOCALE) {
  const template = await getTemplate(templateId)
  if (template.status === 'DRAFT') {
    throw new ApiError(409, 'An unpublished notice may not be shown to a data principal')
  }

  const bodies = template.bodyByLocale ?? {}
  const resolvedLocale = bodies[locale] ? locale : REQUIRED_LOCALE
  const body = bodies[resolvedLocale]
  if (!body) throw new ApiError(500, 'Template has no renderable notice body')

  return {
    templateId: template.id,
    templateName: template.name,
    templateVersion: template.version,
    policyVersion: `${template.name} v${template.version}`,
    locale: resolvedLocale,
    requestedLocale: locale,
    // True when we fell back to English. The UI must surface this rather than
    // silently pretending the principal read a notice in their own language.
    localeFallback: resolvedLocale !== locale,
    availableLocales: Object.keys(bodies),
    purpose: template.purpose,
    dataTypes: template.dataTypes ?? [],
    retention: template.retention,
    grievanceContact: template.grievanceContact,
    body,
  }
}
