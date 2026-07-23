import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireSubjectAuth } from '../../middleware/requireSubjectAuth.js'
import * as enrollmentService from '../enrollment/enrollment.service.js'

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
