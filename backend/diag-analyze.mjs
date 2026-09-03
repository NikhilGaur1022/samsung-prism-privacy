import { prisma } from './src/config/prisma.js'
import { analyzeVideo } from './src/modules/videos/video.service.js'

const v = await prisma.videoAsset.findFirst({ where: { status: 'DEFERRED' }, orderBy: { createdAt: 'desc' } })
console.log('re-analysing', v.id)
const t0 = Date.now()
const result = await analyzeVideo(v.id)
console.log('elapsed_ms', Date.now() - t0)
console.log('result', result ? `tracks=${result.tracks.length}` : 'NULL (deferred again)')
const after = await prisma.videoAsset.findUnique({ where: { id: v.id } })
console.log('status', after.status, 'detected', Boolean(after.detectedPath))
await prisma.$disconnect()
