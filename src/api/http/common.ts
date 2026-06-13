import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import type { AppServices } from '../../app.js'

export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message)
  }
}

export const badRequest = (msg: string) => new HttpError(400, 'BAD_REQUEST', msg)
export const unauthorized = (msg = 'Unauthorized') => new HttpError(401, 'UNAUTHORIZED', msg)
export const forbidden = (msg: string) => new HttpError(403, 'FORBIDDEN', msg)
export const notFound = (msg = 'Not found') => new HttpError(404, 'NOT_FOUND', msg)
export const conflict = (msg: string) => new HttpError(409, 'CONFLICT', msg)

export interface AuthedRequest extends FastifyRequest {
  userId: string
  handle: string
}

/** Build a preHandler that validates the Bearer token and attaches userId/handle. */
export function makeRequireAuth(services: AppServices) {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) throw unauthorized()
    try {
      const payload = services.tokens.verifyAccessToken(auth.slice(7))
      ;(req as AuthedRequest).userId = payload.sub
      ;(req as AuthedRequest).handle = payload.handle
    } catch {
      throw unauthorized('Invalid token')
    }
  }
}

export function userId(req: FastifyRequest): string {
  return (req as AuthedRequest).userId
}

/** Consistent error envelope: { error: { code, message } }. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') } })
    }
    // Prisma "record not found" and similar.
    const message = err.message || 'Internal error'
    if (/not found|No .* found|Record to (update|delete) does not exist/i.test(message)) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message } })
    }
    app.log.error(err)
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal error' } })
  })
}
