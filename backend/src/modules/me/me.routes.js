import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireSubjectAuth } from '../../middleware/requireSubjectAuth.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { logAccess } from '../../middleware/logAccess.js'
import * as enrollmentService from '../enrollment/enrollment.service.js'
import * as meService from './me.service.js'
import { readPersonRedactedPhotoForSubject } from '../sessions/session.service.js'
import * as dsarService from '../dsar/dsar.service.js'
import { downloadPackage, issuePackageToken } from '../dsar/export.service.js'
import { getCertificateForRequest, verifyCertificate } from '../dsar/certificate.service.js'

// Subject-facing account state that isn't enrollment CRUD. Shares the /api/v1/me
// mount with selfEnrollmentRoutes; every handler takes the subject id from the
// verified token, never from the request.
export const meRoutes = Router()

meRoutes.use(requireSubjectAuth)

const consentSchema = z.object({ accepted: z.boolean() })

meRoutes.patch('/biometric-consent', async (req, res, next) => {
  try {
    const { accepted } = consentSchema.parse(req.body)
    res.json(await enrollmentService.setBiometricConsent(req.subject.masterUserId, accepted))
  } catch (err) {
    next(err)
  }
})

meRoutes.get('/enrollment-status', async (req, res, next) => {
  try {
    res.json(await enrollmentService.getEnrollmentStatus(req.subject.masterUserId))
  } catch (err) {
    next(err)
  }
})

// Sessions a collection agent has added this subject to. This is the subject's
// own view of "where am I actually being collected" — driven by SessionParticipant,
// the roster the agent builds, not by the project catalogue (which lists every
// project regardless of whether the subject is in a session for it).
meRoutes.get('/participations', async (req, res, next) => {
  try {
    const parts = await prisma.sessionParticipant.findMany({
      where: { subjectId: req.subject.masterUserId },
      orderBy: { addedAt: 'desc' },
      include: {
        session: {
          select: {
            id: true,
            code: true,
            status: true,
            location: true,
            createdAt: true,
            project: { select: { id: true, name: true, purpose: true } },
          },
        },
      },
    })

    res.json({
      items: parts.map((p) => ({
        id: p.id,
        addedAt: p.addedAt,
        session: {
          id: p.session.id,
          code: p.session.code,
          status: p.session.status,
          location: p.session.location,
          createdAt: p.session.createdAt,
        },
        project: p.session.project,
      })),
    })
  } catch (err) {
    next(err)
  }
})

// DPDP §11 — "how many photos am I actually in, and under what purpose". This is
// the access right answered directly rather than through a 30-day DSAR: the
// principal's own link rows, grouped by project, with no other principal named.
meRoutes.get('/photos', async (req, res, next) => {
  try {
    res.json(await meService.listMyPhotos(req.subject.masterUserId))
  } catch (err) {
    next(err)
  }
})

// The principal's own copy of a frame they appear in. Everyone else on it is
// blurred (invariant: same builder as the agent's per-person view) and the read
// is logged before any decryption, exactly like an operator read — a subject
// looking at their own face is still an access to biometric data.
meRoutes.get(
  '/photos/:photoId/redacted',
  logAccess('REDACTED_PHOTO', (req) => req.params.photoId, { purpose: 'SUBJECT_ACCESS' }),
  async (req, res, next) => {
    try {
      const { buffer, mimeType } = await readPersonRedactedPhotoForSubject(
        z.string().uuid().parse(req.params.photoId),
        req.subject.masterUserId,
      )
      res.set('Cache-Control', 'private, no-store')
      res.type(mimeType).send(buffer)
    } catch (err) {
      next(err)
    }
  },
)

// ---------------------------------------------------------------------------
// DPDP §11 / §12 / §13 — the data principal's own rights surface
// ---------------------------------------------------------------------------
// Deliberately on /me rather than /dsar: the subject token is the authorization,
// and every handler takes the subject id from the verified token, so there is no
// id in any path that could be swapped for someone else's.

const dsarTypeSchema = z.enum(['ACCESS', 'CORRECT', 'ERASE', 'GRIEVANCE', 'NOMINATION'])
const raiseSchema = z.object({
  type: dsarTypeSchema,
  description: z.string().trim().max(4000).optional(),
  projectId: z.string().uuid().optional(),
})

meRoutes.post('/dsar', async (req, res, next) => {
  try {
    const body = raiseSchema.parse(req.body)
    const request = await dsarService.createRequest({
      subjectId: req.subject.masterUserId,
      type: body.type,
      description: body.description,
      projectId: body.projectId,
      channel: 'PORTAL',
    })
    res.status(201).json(request)
  } catch (err) {
    next(err)
  }
})

meRoutes.get('/dsar', async (req, res, next) => {
  try {
    res.json({ items: await dsarService.listQueue({ subject: req.subject }) })
  } catch (err) {
    next(err)
  }
})

meRoutes.get('/dsar/:requestId', async (req, res, next) => {
  try {
    const requestId = z.string().uuid().parse(req.params.requestId)
    res.json(await dsarService.getRequest(requestId, { subject: req.subject }))
  } catch (err) {
    next(err)
  }
})

// Single-use, token-bound download of the §11 package. The token is issued once
// when the package is built and is never recoverable from this API.
meRoutes.get('/dsar/:requestId/package', async (req, res, next) => {
  try {
    const requestId = z.string().uuid().parse(req.params.requestId)
    const token = z.string().min(20).parse(req.query.token)
    const { buffer, filename } = await downloadPackage(requestId, token, {
      req,
      subjectId: req.subject.masterUserId,
    })
    res.set('Content-Disposition', `attachment; filename="${filename}"`)
    res.set('Cache-Control', 'private, no-store')
    res.type('application/zip').send(buffer)
  } catch (err) {
    next(err)
  }
})

// Mints the single-use link. Without it the portal had no way to obtain a token
// at all — the only one ever produced went to the operator at build time — and
// SecureInbox.jsx was reduced to asking the principal to paste one in.
meRoutes.post('/dsar/:requestId/package-token', async (req, res, next) => {
  try {
    const requestId = z.string().uuid().parse(req.params.requestId)
    res.json(await issuePackageToken(requestId, req.subject.masterUserId))
  } catch (err) {
    next(err)
  }
})

meRoutes.get('/dsar/:requestId/certificate', async (req, res, next) => {
  try {
    const requestId = z.string().uuid().parse(req.params.requestId)
    // Ownership is re-checked before anything is returned — getRequest throws for
    // a request belonging to another principal.
    await dsarService.getRequest(requestId, { subject: req.subject })
    const certificate = await getCertificateForRequest(requestId)
    if (!certificate) throw new ApiError(404, 'No certificate has been issued yet')
    res.json({ certificate, verification: await verifyCertificate(certificate.id) })
  } catch (err) {
    next(err)
  }
})
