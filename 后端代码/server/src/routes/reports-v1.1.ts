import { Router, type Request, type Response } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, error } from '../utils/response.js'

type SampleDataSource = 'all' | 'lis' | 'manual'
type SampleCountSource = 'lis' | 'manual' | 'unavailable'

interface DateFilters {
  startDate?: string
  endDate?: string
}

interface ProjectFilters extends DateFilters {
  dataSource: SampleDataSource
  projectType?: string
}

const PROJECT_TYPES = new Set(['he', 'ihc', 'ss', 'mp', 'cyto'])
const SAMPLE_DATA_SOURCES = new Set<SampleDataSource>(['all', 'lis', 'manual'])
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

class InvalidParameterError extends Error {}

function readOptionalString(req: Request, name: string): string | undefined {
  const raw = req.query[name]
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || raw.length === 0 || raw.trim() !== raw) {
    throw new InvalidParameterError(`${name} 必须是单一非空字符串`)
  }
  return raw
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function nextIsoDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

function parseDateFilters(req: Request): DateFilters {
  const startDate = readOptionalString(req, 'startDate')
  const endDate = readOptionalString(req, 'endDate')

  if (startDate && !isValidIsoDate(startDate)) {
    throw new InvalidParameterError('startDate 必须是真实的 YYYY-MM-DD 日期')
  }
  if (endDate && !isValidIsoDate(endDate)) {
    throw new InvalidParameterError('endDate 必须是真实的 YYYY-MM-DD 日期')
  }
  if (startDate && endDate && startDate > endDate) {
    throw new InvalidParameterError('startDate 不能晚于 endDate')
  }

  return { startDate, endDate }
}

function parseProjectFilters(req: Request): ProjectFilters {
  const dates = parseDateFilters(req)
  const source = readOptionalString(req, 'dataSource') || 'all'
  const projectType = readOptionalString(req, 'projectType')

  if (!SAMPLE_DATA_SOURCES.has(source as SampleDataSource)) {
    throw new InvalidParameterError('dataSource 仅支持 all、lis 或 manual')
  }
  if (projectType && !PROJECT_TYPES.has(projectType)) {
    throw new InvalidParameterError('projectType 不是受支持的项目分类')
  }

  return { ...dates, dataSource: source as SampleDataSource, projectType }
}

function parseMaterialFilters(req: Request): DateFilters & { categoryId?: string } {
  const dates = parseDateFilters(req)
  const categoryId = readOptionalString(req, 'categoryId')
  if (categoryId && categoryId.length > 128) {
    throw new InvalidParameterError('categoryId 长度不能超过 128 个字符')
  }
  return { ...dates, categoryId }
}

function addDateConditions(
  where: string[],
  params: unknown[],
  column: string,
  filters: DateFilters,
): void {
  if (filters.startDate) {
    where.push(`${column} >= ?`)
    params.push(filters.startDate)
  }
  if (filters.endDate) {
    where.push(`${column} < ?`)
    params.push(nextIsoDate(filters.endDate))
  }
}

function toFiniteNumber(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function percentage(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((part / total) * 1000) / 10
}

function respondWithError(res: Response, caught: unknown): void {
  if (caught instanceof InvalidParameterError) {
    error(res, caught.message, 'INVALID_PARAMETER', 400)
    return
  }
  error(res, caught instanceof Error ? caught.message : '成本报表查询失败')
}

const router = Router()

router.get('/cost-by-project', (req, res) => {
  try {
    const filters = parseProjectFilters(req)
    const db = getDatabase()
    const costWhere = [
      "r.status = 'completed'",
      'r.is_deleted = 0',
      '(p.is_deleted = 0 OR p.id IS NULL)',
    ]
    const costParams: unknown[] = []
    addDateConditions(costWhere, costParams, 'r.created_at', filters)
    if (filters.projectType) {
      costWhere.push('p.type = ?')
      costParams.push(filters.projectType)
    }

    const costRows = db.prepare(`
      SELECT
        r.project_id,
        p.name,
        p.type,
        SUM(r.total_cost) AS total_cost,
        SUM(COALESCE(r.sample_count, 1)) AS manual_sample_count
      FROM outbound_records r
      LEFT JOIN projects p ON r.project_id = p.id
      WHERE ${costWhere.join(' AND ')}
      GROUP BY r.project_id
      ORDER BY total_cost DESC
    `).all(...costParams) as any[]

    const lisCounts = new Map<string, number>()
    if (filters.dataSource !== 'manual') {
      const lisWhere = ["lc.status = 'normal'", 'lc.project_id IS NOT NULL', 'p.is_deleted = 0']
      const lisParams: unknown[] = []
      addDateConditions(lisWhere, lisParams, 'lc.operate_time', filters)
      if (filters.projectType) {
        lisWhere.push('p.type = ?')
        lisParams.push(filters.projectType)
      }

      const lisRows = db.prepare(`
        SELECT lc.project_id, COUNT(lc.id) AS lis_sample_count
        FROM lis_cases lc
        JOIN projects p ON lc.project_id = p.id
        WHERE ${lisWhere.join(' AND ')}
        GROUP BY lc.project_id
      `).all(...lisParams) as any[]

      for (const row of lisRows) {
        if (row.project_id) lisCounts.set(String(row.project_id), toFiniteNumber(row.lis_sample_count))
      }
    }

    const totalCost = costRows.reduce((sum, row) => sum + toFiniteNumber(row.total_cost), 0)
    const projects = costRows.map(row => {
      const projectId = row.project_id == null ? '' : String(row.project_id)
      const manualCount = Math.max(0, toFiniteNumber(row.manual_sample_count))
      const lisCount = Math.max(0, lisCounts.get(projectId) || 0)

      let sampleCount = 0
      let sampleCountSource: SampleCountSource = 'unavailable'
      if (filters.dataSource === 'manual') {
        sampleCount = manualCount
        sampleCountSource = manualCount > 0 ? 'manual' : 'unavailable'
      } else if (filters.dataSource === 'lis') {
        sampleCount = lisCount
        sampleCountSource = lisCount > 0 ? 'lis' : 'unavailable'
      } else if (lisCount > 0) {
        sampleCount = lisCount
        sampleCountSource = 'lis'
      } else if (manualCount > 0) {
        sampleCount = manualCount
        sampleCountSource = 'manual'
      }

      const totalCostForProject = toFiniteNumber(row.total_cost)
      return {
        id: projectId,
        name: row.name || '未关联项目',
        category: row.type || 'other',
        sampleCount,
        sampleCountSource,
        unitCost: sampleCount > 0 ? totalCostForProject / sampleCount : null,
        totalCost: totalCostForProject,
        ratio: percentage(totalCostForProject, totalCost),
        changeRate: null,
        changeDirection: null,
      }
    })
    const totalSamples = projects.reduce((sum, project) => sum + project.sampleCount, 0)

    success(res, {
      filters: {
        ...(filters.startDate ? { startDate: filters.startDate } : {}),
        ...(filters.endDate ? { endDate: filters.endDate } : {}),
        dataSource: filters.dataSource,
        ...(filters.projectType ? { projectType: filters.projectType } : {}),
      },
      summary: { totalCost, projectCost: totalCost, publicCost: 0, totalSamples },
      projects,
    })
  } catch (caught) {
    respondWithError(res, caught)
  }
})

router.get('/cost-by-material', (req, res) => {
  try {
    const filters = parseMaterialFilters(req)
    const db = getDatabase()
    const where = ["o.status = 'completed'", 'o.is_deleted = 0', 'm.is_deleted = 0']
    const params: unknown[] = []
    addDateConditions(where, params, 'o.created_at', filters)
    if (filters.categoryId) {
      where.push('m.category_id = ?')
      params.push(filters.categoryId)
    }

    const rows = db.prepare(`
      SELECT
        oi.material_id,
        m.name,
        m.spec,
        SUM(oi.quantity) AS consumption,
        m.unit AS consumption_unit,
        SUM(oi.total_cost) AS total_cost
      FROM outbound_items oi
      JOIN outbound_records o ON oi.outbound_id = o.id
      JOIN materials m ON oi.material_id = m.id
      WHERE ${where.join(' AND ')}
      GROUP BY oi.material_id
      ORDER BY total_cost DESC
    `).all(...params) as any[]

    const totalCost = rows.reduce((sum, row) => sum + toFiniteNumber(row.total_cost), 0)
    success(res, {
      filters: {
        ...(filters.startDate ? { startDate: filters.startDate } : {}),
        ...(filters.endDate ? { endDate: filters.endDate } : {}),
        ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      },
      materials: rows.map(row => {
        const rowCost = toFiniteNumber(row.total_cost)
        return {
          id: row.material_id,
          name: row.name,
          spec: row.spec,
          consumption: toFiniteNumber(row.consumption),
          consumptionUnit: row.consumption_unit,
          totalCost: rowCost,
          ratio: percentage(rowCost, totalCost),
          changeRate: null,
          changeDirection: null,
        }
      }),
      trend: [],
    })
  } catch (caught) {
    respondWithError(res, caught)
  }
})

router.get('/cost-by-supplier', (req, res) => {
  try {
    const filters = parseDateFilters(req)
    const db = getDatabase()
    const where = [
      "r.status = 'completed'",
      'r.is_deleted = 0',
      '(s.is_deleted = 0 OR s.id IS NULL)',
      'r.supplier_id IS NOT NULL',
    ]
    const params: unknown[] = []
    addDateConditions(where, params, 'r.created_at', filters)

    const rows = db.prepare(`
      SELECT r.supplier_id, s.name, SUM(r.amount) AS amount, COUNT(r.id) AS order_count
      FROM inbound_records r
      LEFT JOIN suppliers s ON r.supplier_id = s.id
      WHERE ${where.join(' AND ')}
      GROUP BY r.supplier_id
      ORDER BY amount DESC
    `).all(...params) as any[]

    const totalAmount = rows.reduce((sum, row) => sum + toFiniteNumber(row.amount), 0)
    success(res, {
      filters,
      suppliers: rows.map(row => {
        const amount = toFiniteNumber(row.amount)
        return {
          id: row.supplier_id,
          name: row.name || '未关联供应商',
          amount,
          ratio: percentage(amount, totalAmount),
          orderCount: toFiniteNumber(row.order_count),
          status: 'long-term',
        }
      }),
    })
  } catch (caught) {
    respondWithError(res, caught)
  }
})

router.get('/cost-trend', (req, res) => {
  try {
    const filters = parseDateFilters(req)
    const db = getDatabase()
    const where = ["status = 'completed'", 'is_deleted = 0']
    const params: unknown[] = []
    addDateConditions(where, params, 'created_at', filters)

    const rows = db.prepare(`
      SELECT strftime('%Y-%m', created_at) AS month, SUM(total_cost) AS cost
      FROM outbound_records
      WHERE ${where.join(' AND ')}
      GROUP BY month
      ORDER BY month
    `).all(...params) as any[]

    success(res, {
      filters,
      trend: rows.map(row => ({ month: row.month, cost: toFiniteNumber(row.cost) })),
    })
  } catch (caught) {
    respondWithError(res, caught)
  }
})

export default router
