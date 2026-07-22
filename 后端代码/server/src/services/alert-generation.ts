import type { DatabaseSync } from 'node:sqlite'
import { v4 as uuidv4 } from 'uuid'
import {
  getDatabase,
  invalidateDatabaseConnection,
} from '../database/DatabaseManager.js'

interface AlertRuleRow {
  threshold_days: number | null
}

interface LowStockCandidate {
  id: string
  name: string
  stock: number
  effective_threshold: number
}

interface ExpiryCandidate {
  id: string
  name: string
  batch_no: string
  expiry_date: string
}

interface PendingCountRow {
  c: number
}

export interface AlertGenerationResult {
  generatedCount: number
  lowStockCount: number
  expiryCount: number
}

export interface AlertGenerationOptions {
  database?: DatabaseSync
  now?: Date
}

function utcDateAfterDays(now: Date, days: number): string {
  const thresholdDate = new Date(now.getTime())
  thresholdDate.setUTCDate(thresholdDate.getUTCDate() + days)
  return thresholdDate.toISOString().slice(0, 10)
}

export function generateAlerts(options: AlertGenerationOptions = {}): AlertGenerationResult {
  const database = options.database ?? getDatabase()
  const ownsSingletonConnection = options.database === undefined
  let transactionStarted = false

  try {
    database.exec('BEGIN IMMEDIATE')
    transactionStarted = true

    let lowStockCount = 0
    let expiryCount = 0
    const pendingCount = database.prepare(
      "SELECT COUNT(*) AS c FROM alerts WHERE material_id = ? AND type = ? AND status = 'pending'"
    )

    const lowStockRule = database.prepare(
      "SELECT threshold_days FROM alert_rules WHERE type = 'low-stock' AND enabled = 1"
    ).get() as AlertRuleRow | undefined
    if (lowStockRule) {
      const lowItems = database.prepare(`
        SELECT m.id, m.name, i.stock,
          COALESCE(NULLIF(m.min_stock, 0), m.safety_stock) AS effective_threshold
        FROM materials m
        JOIN inventory i ON m.id = i.material_id
        WHERE m.status = 1 AND m.is_deleted = 0
        AND i.stock <= COALESCE(NULLIF(m.min_stock, 0), m.safety_stock)
        AND COALESCE(NULLIF(m.min_stock, 0), m.safety_stock) > 0
      `).all() as unknown as LowStockCandidate[]
      const insertLowStock = database.prepare(`
        INSERT INTO alerts
          (id, type, level, material_id, material_name, current_stock, threshold, message, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `)

      for (const item of lowItems) {
        const exists = pendingCount.get(item.id, 'low-stock') as unknown as PendingCountRow
        if (exists.c !== 0) continue
        insertLowStock.run(
          uuidv4(),
          'low-stock',
          'warning',
          item.id,
          item.name,
          item.stock,
          item.effective_threshold,
          `Low stock: current ${item.stock}, threshold ${item.effective_threshold}`,
        )
        lowStockCount += 1
      }
    }

    const expiryRule = database.prepare(
      "SELECT threshold_days FROM alert_rules WHERE type = 'expiry' AND enabled = 1"
    ).get() as AlertRuleRow | undefined
    if (expiryRule && expiryRule.threshold_days != null) {
      const thresholdDays = Number(expiryRule.threshold_days)
      const thresholdDate = utcDateAfterDays(options.now ?? new Date(), thresholdDays)
      const expiryItems = database.prepare(`
        SELECT m.id, m.name, b.batch_no, b.expiry_date
        FROM batches b
        JOIN materials m ON b.material_id = m.id AND m.is_deleted = 0
        WHERE b.status = 1 AND b.expiry_date <= ?
      `).all(thresholdDate) as unknown as ExpiryCandidate[]
      const insertExpiry = database.prepare(`
        INSERT INTO alerts
          (id, type, level, material_id, material_name, threshold, message, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
      `)

      for (const item of expiryItems) {
        const exists = pendingCount.get(item.id, 'expiry') as unknown as PendingCountRow
        if (exists.c !== 0) continue
        insertExpiry.run(
          uuidv4(),
          'expiry',
          'danger',
          item.id,
          item.name,
          thresholdDays,
          `Batch ${item.batch_no} expires at ${item.expiry_date}`,
        )
        expiryCount += 1
      }
    }

    database.exec('COMMIT')
    transactionStarted = false
    return {
      generatedCount: lowStockCount + expiryCount,
      lowStockCount,
      expiryCount,
    }
  } catch (scanError) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK')
      } catch (rollbackError) {
        if (ownsSingletonConnection) invalidateDatabaseConnection()
        throw new AggregateError(
          [scanError, rollbackError],
          'Alert generation rollback failed',
        )
      }
    }
    throw scanError
  }
}
