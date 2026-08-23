import { PrismaClient } from '@prisma/client'

// One Prisma client per process, with a connection budget that reflects how many
// processes there actually are.
//
// The stack runs ten Node processes against one database — the API plus seven
// queue workers, and each of them constructs this client. `connection_limit=20`
// is set once in DATABASE_URL, so every one of them claimed twenty: up to 200
// connections against a Supabase pooler sized for a fraction of that.
//
// The symptom was not a clean refusal. It was
// `P2024: Timed out fetching a new connection from the connection pool` in
// whichever process lost the race — most visibly the retention worker's startup
// sweep, which fans five deleteMany calls out with Promise.all and stalled all
// five — while ordinary requests got slower and slower as they queued behind a
// pool that had nothing left to hand out.
//
// A worker running one job at a time does not need twenty connections. The API,
// serving concurrent requests, does need more than a worker.
//
// The split is decided from the entrypoint rather than an environment variable,
// because the alternative is `PRISMA_CONNECTION_LIMIT=5 node ...` in ten npm
// scripts — which is not portable to the Windows shell npm actually uses here,
// and which silently does nothing when it fails. argv[1] is the script node was
// given; every worker lives under src/workers/. PRISMA_CONNECTION_LIMIT still
// overrides, for the case where a deployment knows better.
const isWorker = /[\\/]workers[\\/]/.test(process.argv[1] ?? '')
const DEFAULT_LIMIT = isWorker ? 5 : 15

const explicit = Number.parseInt(process.env.PRISMA_CONNECTION_LIMIT ?? '', 10)
const limit = Number.isFinite(explicit) && explicit > 0 ? explicit : DEFAULT_LIMIT

function datasourceUrl() {
  const raw = process.env.DATABASE_URL
  if (!raw) return undefined

  // Rewritten rather than appended: DATABASE_URL already carries
  // connection_limit, and a second copy of the parameter is not an override —
  // node:URL keeps both and the driver reads whichever it finds first.
  try {
    const url = new URL(raw)
    url.searchParams.set('connection_limit', String(limit))
    return url.toString()
  } catch {
    // A URL this cannot parse is one Prisma will reject with a better message
    // than anything thrown here. Leave it alone and let it through.
    return undefined
  }
}

const override = datasourceUrl()

export const prisma = new PrismaClient(
  override ? { datasources: { db: { url: override } } } : undefined,
)
