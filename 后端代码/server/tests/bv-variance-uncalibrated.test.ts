/**
 * HON-3（P-7 · 假标准成本停返）回归门禁
 *
 * 背景：ABC「成本差异分析」端点此前用「物料实际」冒充标准成本、据此算出假的 variance/varianceRate
 *   （拿实际算实际）。#86 只加免责声明字段、假数字仍返回。本门禁锁定「停返」不变量：
 *   - standard / variance / varianceRate 一律返回 null（= 未校准不可用），绝不再拿实际冒充标准；
 *   - 真实实际成本（totalActual）照常透出（本页真身=只展示实际、不造假差异）。
 * 变异测试：把端点改回 `totalStandard = materialActual` → 本文件 totalStandard/varianceRate 断言应翻红。
 */

import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { getDatabase } from '../src/database/DatabaseManager.js'
import { v4 as uuidv4 } from 'uuid'
import { createLegacyAbcCompatibilityApp } from './helpers/legacy-abc-compatibility-app.js'

const app = createLegacyAbcCompatibilityApp()

describe('HON-3 成本差异分析：停返假标准成本/差异', () => {
  let token: string
  let db: any
  const month = '2099-03' // 远期专用月，避免与其它测试数据串月

  beforeAll(async () => {
    db = getDatabase()
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'admin123' })
    token = loginRes.body.data.token

    // 造两条真实 ABC 明细（有真实 total_cost / material_cost / activity_cost / sample_count）
    const mk = (id: string, material: number, activity: number, total: number, samples: number) =>
      db.prepare(`
        INSERT INTO outbound_abc_details
          (id, outbound_id, project_id, sample_count, material_cost, activity_cost, total_cost, cost_month, cost_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'costed')
      `).run(id, uuidv4(), 'proj-hon3', samples, material, activity, total, month)
    mk(uuidv4(), 100, 30, 130, 5)
    mk(uuidv4(), 200, 40, 240, 8)
  })

  it('端点返回真实实际成本，但 standard/variance/varianceRate 一律 null（未校准不可用）', async () => {
    const res = await request(app)
      .get('/api/v1/abc/variance-analysis')
      .query({ startDate: `${month}-01`, endDate: `${month}-28`, compareType: 'project' })
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    const { list, summary } = res.body.data

    // summary：实际成本真实（130 + 240 = 370），标准/差异/差异率停返
    expect(summary.totalActual).toBe(370)
    expect(summary.totalStandard).toBeNull()
    expect(summary.totalVariance).toBeNull()
    expect(summary.varianceRate).toBeNull()
    expect(summary.standardCalibrated).toBe(false)

    // 逐行：实际成本真实，标准/差异停返，且**绝不**等于「实际冒充标准」的旧假值
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBeGreaterThan(0)
    for (const item of list) {
      expect(item.standardCalibrated).toBe(false)
      expect(item.totalStandard).toBeNull()
      expect(item.materialStandard).toBeNull()
      expect(item.totalVariance).toBeNull()
      expect(item.varianceRate).toBeNull()
      expect(item.status).toBe('uncalibrated')
      // 真实实际成本仍透出（非 null、非 0）
      expect(typeof item.totalActual).toBe('number')
      expect(item.totalActual).toBeGreaterThan(0)
    }
  })
})
