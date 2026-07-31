import express from 'express'
import publicApp from '../../src/app.js'
import { authenticateToken } from '../../src/middleware/auth.js'
import { auditWrite } from '../../src/middleware/audit-log.js'
import { requirePermission } from '../../src/middleware/permissions.js'
import abcRoutes from '../../src/routes/abc-v1.1.js'

/**
 * Test-only compatibility harness.
 *
 * The production app seals /api/v1/abc with FEATURE_RETIRED. These tests still
 * exercise the retained legacy implementation directly so #70 can decouple
 * shared helpers/tables without reopening the public product surface.
 */
export function createLegacyAbcCompatibilityApp(options: { auditWrites?: boolean } = {}) {
  const compatibilityApp = express()
  compatibilityApp.use(express.json({ limit: '100kb' }))
  compatibilityApp.use(express.urlencoded({ extended: true, limit: '100kb' }))
  if (options.auditWrites) compatibilityApp.use(auditWrite)
  compatibilityApp.use(
    '/api/v1/abc',
    authenticateToken,
    requirePermission('abc_dashboard', 'R'),
    abcRoutes,
  )
  compatibilityApp.use(publicApp)
  return compatibilityApp
}
