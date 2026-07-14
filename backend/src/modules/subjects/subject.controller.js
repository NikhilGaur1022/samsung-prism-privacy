import * as subjectService from './subject.service.js'
import {
  registerSubjectSchema,
  listSubjectsQuerySchema,
  updateConsentSchema,
  updateStatusSchema,
  updateGroupSchema,
} from './subject.validation.js'

export async function register(req, res, next) {
  try {
    const input = registerSubjectSchema.parse(req.body)
    const subject = await subjectService.registerSubject(input, req.user.id)
    res.status(201).json(subject)
  } catch (err) {
    next(err)
  }
}

export async function getOne(req, res, next) {
  try {
    const subject = await subjectService.getSubject(req.params.id)
    res.json(subject)
  } catch (err) {
    next(err)
  }
}

export async function list(req, res, next) {
  try {
    const query = listSubjectsQuerySchema.parse(req.query)
    const result = await subjectService.listSubjects(query)
    res.json(result)
  } catch (err) {
    next(err)
  }
}

export async function updateConsent(req, res, next) {
  try {
    const body = updateConsentSchema.parse(req.body)
    const subject = await subjectService.updateConsent(req.params.id, body, req.user.id)
    res.json(subject)
  } catch (err) {
    next(err)
  }
}

export async function updateStatus(req, res, next) {
  try {
    const { status } = updateStatusSchema.parse(req.body)
    const subject = await subjectService.updateStatus(req.params.id, status, req.user.id)
    res.json(subject)
  } catch (err) {
    next(err)
  }
}

export async function updateGroup(req, res, next) {
  try {
    const { group } = updateGroupSchema.parse(req.body)
    const subject = await subjectService.updateGroup(req.params.id, group, req.user.id)
    res.json(subject)
  } catch (err) {
    next(err)
  }
}
