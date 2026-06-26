import type { Request } from 'express'
import { v4 as uuidv4 } from 'uuid'

type Actor = {
  userId?: string | null
  username?: string | null
}

type OperationLogInput = {
  actor?: Actor
  operation: string
  description: string
  requestData?: unknown
  responseData?: unknown
}

type AuthenticatedRequest = Request & {
  user?: { userId: string; username: string; role: string }
}

function stringifyJson(value: unknown) {
  if (value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ unserializable: true })
  }
}

export function logOperation(db: any, req: AuthenticatedRequest, input: OperationLogInput) {
  try {
    const actor = input.actor || req.user || {}
    db.prepare(`
      INSERT INTO operation_logs (id, user_id, username, operation, description, request_data, response_data, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      actor.userId || null,
      actor.username || '',
      input.operation,
      input.description,
      stringifyJson(input.requestData),
      stringifyJson(input.responseData),
      req.ip || req.socket?.remoteAddress || '',
      req.get?.('user-agent') || '',
    )
  } catch (err) {
    console.warn('Failed to write operation log', err)
  }
}
