import 'dotenv/config'
import { Queue } from 'bullmq'
import { prisma } from './src/config/prisma.js'
import { FACE_QUEUE_NAME, faceQueueConnection } from './src/lib/faceQueue.js'

const q = new Queue(FACE_QUEUE_NAME, { connection: faceQueueConnection })
const counts = await q.getJobCounts()
console.log('counts:', counts)

for (const state of ['waiting', 'active', 'delayed', 'failed', 'completed']) {
  const jobs = await q.getJobs([state], 0, 30)
  for (const j of jobs) {
    const jobId = j.data?.jobId
    const sessionId = j.data?.sessionId
    const row = jobId ? await prisma.recognitionJob.findUnique({ where: { id: jobId }, select: { id: true, status: true } }) : null
    const sess = sessionId ? await prisma.session.findUnique({ where: { id: sessionId }, select: { status: true } }) : null
    console.log(`${state.padEnd(10)} bull=${String(j.id).padEnd(6)} attempts=${j.attemptsMade} dbJob=${row ? row.status : 'MISSING'} session=${sess ? sess.status : 'MISSING'} ${sessionId ?? ''}`)
  }
}
await q.close()
await prisma.$disconnect()
process.exit(0)
