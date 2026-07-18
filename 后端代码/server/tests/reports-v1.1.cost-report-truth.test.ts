import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
}))

vi.mock('../src/database/DatabaseManager.js', () => ({
  getDatabase: databaseMocks.getDatabase,
}))

import reportsRouter from '../src/routes/reports-v1.1.js'

interface QueryRecord {
  sql: string
  params: unknown[]
}

const queryRecords: QueryRecord[] = []

const costRows = [
  {
    project_id: 'p-lis',
    name: 'LIS项目',
    type: 'he',
    total_cost: 50,
    manual_sample_count: 10,
    sample_count: 10,
  },
  {
    project_id: 'p-manual',
    name: '手工项目',
    type: 'he',
    total_cost: 50,
    manual_sample_count: 4,
    sample_count: 4,
  },
]

const fakeDatabase = {
  prepare(sql: string) {
    return {
      all(...params: unknown[]) {
        queryRecords.push({ sql, params })
        if (sql.includes('FROM lis_cases')) {
          return [{ project_id: 'p-lis', lis_sample_count: 1 }]
        }
        if (sql.includes('FROM outbound_records r') && sql.includes('LEFT JOIN projects')) {
          return costRows
        }
        if (sql.includes('FROM outbound_items')) {
          return [
            { material_id: 'm-1', name: '物料1', spec: '盒', consumption: 1, consumption_unit: '盒', total_cost: 50 },
            { material_id: 'm-2', name: '物料2', spec: '盒', consumption: 1, consumption_unit: '盒', total_cost: 50 },
          ]
        }
        return []
      },
    }
  },
}

function createApp() {
  const app = express()
  app.use('/api/v1/reports', reportsRouter)
  return app
}

describe('reports v1.1 cost truth contract', () => {
  beforeEach(() => {
    queryRecords.length = 0
    databaseMocks.getDatabase.mockReset()
    databaseMocks.getDatabase.mockReturnValue(fakeDatabase)
  })

  it('returns numeric 0-100 ratios and deterministic sample-source semantics', async () => {
    const response = await request(createApp())
      .get('/api/v1/reports/cost-by-project')
      .query({
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        dataSource: 'all',
        projectType: 'he',
      })

    expect(response.status).toBe(200)
    expect(response.body.data.filters).toEqual({
      startDate: '2024-01-01',
      endDate: '2024-12-31',
      dataSource: 'all',
      projectType: 'he',
    })
    expect(response.body.data.projects).toEqual([
      expect.objectContaining({
        id: 'p-lis',
        ratio: 50,
        sampleCount: 1,
        sampleCountSource: 'lis',
        unitCost: 50,
        changeRate: null,
        changeDirection: null,
      }),
      expect.objectContaining({
        id: 'p-manual',
        ratio: 50,
        sampleCount: 4,
        sampleCountSource: 'manual',
        unitCost: 12.5,
        changeRate: null,
        changeDirection: null,
      }),
    ])

    const projectQuery = queryRecords.find(record => record.sql.includes('FROM outbound_records r'))
    const lisQuery = queryRecords.find(record => record.sql.includes('FROM lis_cases'))
    expect(projectQuery?.params).toEqual(['2024-01-01', '2025-01-01', 'he'])
    expect(lisQuery?.params).toEqual(['2024-01-01', '2025-01-01', 'he'])
  })

  it('uses configured outbound sample totals for the manual source', async () => {
    const response = await request(createApp())
      .get('/api/v1/reports/cost-by-project')
      .query({ dataSource: 'manual' })

    expect(response.status).toBe(200)
    expect(response.body.data.projects[0]).toEqual(expect.objectContaining({
      id: 'p-lis',
      sampleCount: 10,
      sampleCountSource: 'manual',
      unitCost: 5,
    }))
    expect(queryRecords.some(record => record.sql.includes('SUM(COALESCE(r.sample_count, 1))'))).toBe(true)
    expect(queryRecords.some(record => record.sql.includes('FROM lis_cases'))).toBe(false)
  })

  it('marks an unavailable LIS denominator as not computable', async () => {
    const response = await request(createApp())
      .get('/api/v1/reports/cost-by-project')
      .query({ dataSource: 'lis' })

    expect(response.status).toBe(200)
    expect(response.body.data.projects[1]).toEqual(expect.objectContaining({
      id: 'p-manual',
      sampleCount: 0,
      sampleCountSource: 'unavailable',
      unitCost: null,
    }))
  })

  it('validates dates, source and project category before touching the database', async () => {
    const invalidQueries = [
      'startDate=2024-02-30',
      'startDate=2024%2F01%2F01',
      'startDate=2024-02-01&endDate=2024-01-01',
      'dataSource=unknown',
      'dataSource=lis&dataSource=manual',
      'projectType=unknown',
    ]

    for (const query of invalidQueries) {
      databaseMocks.getDatabase.mockClear()
      const response = await request(createApp())
        .get(`/api/v1/reports/cost-by-project?${query}`)
      expect(response.status, query).toBe(400)
      expect(response.body.error.code, query).toBe('INVALID_PARAMETER')
      expect(databaseMocks.getDatabase, query).not.toHaveBeenCalled()
    }
  })

  it('keeps material ratios numeric and leaves unavailable change rates explicit', async () => {
    const response = await request(createApp())
      .get('/api/v1/reports/cost-by-material')
      .query({ startDate: '2024-01-01', endDate: '2024-12-31' })

    expect(response.status).toBe(200)
    expect(response.body.data.materials).toEqual([
      expect.objectContaining({ ratio: 50, changeRate: null, changeDirection: null }),
      expect.objectContaining({ ratio: 50, changeRate: null, changeDirection: null }),
    ])
  })
})
