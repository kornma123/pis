/**
 * LOC-015 critical E2E：真实后端 + 真实浏览器 + 真实 DB 种子（不 mock 目标 API）。
 *
 * 通过 node:sqlite 直接向本地 dev 库写入一个「计数证据损坏」的医院月与一个干净医院月，
 * 然后登录并打开院级贡献毛利看板，断言：
 *   - 损坏院行显示「数据不可用」，且不显示 ¥500 成功金额；
 *   - 干净院行照常发布数字（¥280）；
 *   - 合法显式 0 不误伤（干净行含 special_stain_count=0）。
 * 测试结束后删除自建种子行（不碰其他数据）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { apiGet, apiLogin, loginThroughUi } from './fixtures'

const HEADING = '\u9662\u7ea7\u8d21\u732e\u6bdb\u5229\u770b\u677f' // 院级贡献毛利看板
const UNAVAILABLE = '\u6570\u636e\u4e0d\u53ef\u7528' // 数据不可用

const MONTH = '2099-02'
const BAD = 'E2E-EVID-BAD'
const OK = 'E2E-EVID-OK'
const dbPath = fileURLToPath(new URL('../../../后端代码/server/data/coreone.db', import.meta.url))

function runSeed(script: string): void {
  execFileSync(process.execPath, ['--experimental-sqlite', '-e', script], {
    encoding: 'utf8',
    stdio: 'pipe',
  })
}

function seed(): void {
  const sql = [
    `INSERT OR IGNORE INTO partners (id, code, name, service_scope, status, is_deleted) VALUES ('${BAD}','${BAD}','E2E Evidence Bad Hospital','technical_only',1,0)`,
    `INSERT OR IGNORE INTO partners (id, code, name, service_scope, status, is_deleted) VALUES ('${OK}','${OK}','E2E Evidence Ok Hospital','technical_only',1,0)`,
    `INSERT OR IGNORE INTO antibodies (id, name, category, per_test_price, price_status, status, is_deleted) VALUES ('AB-CK7','CK7','\u4e00\u6297',5,'has_price',1,0)`,
    `INSERT INTO case_revenue (id, case_no, partner_id, gross_amount, net_amount, lab_revenue, out_revenue, discount_rate, revenue_source, service_month, line_count)
     VALUES ('E2E-EVID-CR-BAD','E2E-EVID-1','${BAD}',510,500,500,0,1,'statement','${MONTH}',1)`,
    `INSERT INTO case_revenue (id, case_no, partner_id, gross_amount, net_amount, lab_revenue, out_revenue, discount_rate, revenue_source, service_month, line_count)
     VALUES ('E2E-EVID-CR-OK','E2E-EVID-2','${OK}',310,300,300,0,1,'statement','${MONTH}',1)`,
    `INSERT INTO lis_cases (id, case_no, partner_id, block_count, ihc_count, special_stain_count, specimen_type)
     VALUES ('E2E-EVID-LC-BAD','E2E-EVID-1','${BAD}',1,'oops',0,'tissue')`,
    `INSERT INTO lis_cases (id, case_no, partner_id, block_count, ihc_count, special_stain_count, specimen_type)
     VALUES ('E2E-EVID-LC-OK','E2E-EVID-2','${OK}',2,2,0,'tissue')`,
    `INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type) VALUES ('E2E-EVID-MK-BAD','E2E-EVID-1','${BAD}','CK7','Y000001')`,
    `INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type) VALUES ('E2E-EVID-MK-OK','E2E-EVID-2','${OK}','CK7','Y000001')`,
  ]
  runSeed([
    `const { DatabaseSync } = require('node:sqlite')`,
    `const db = new DatabaseSync(${JSON.stringify(dbPath)})`,
    `db.exec('PRAGMA busy_timeout = 5000')`,
    ...sql.map((s) => `db.exec(${JSON.stringify(s)})`),
    `db.close()`,
  ].join(';'))
}

function cleanup(): void {
  const sql = [
    `DELETE FROM lis_case_markers WHERE partner_id IN ('${BAD}','${OK}')`,
    `DELETE FROM lis_cases WHERE partner_id IN ('${BAD}','${OK}')`,
    `DELETE FROM case_revenue WHERE partner_id IN ('${BAD}','${OK}')`,
    `DELETE FROM partners WHERE id IN ('${BAD}','${OK}')`,
  ]
  runSeed([
    `const { DatabaseSync } = require('node:sqlite')`,
    `const db = new DatabaseSync(${JSON.stringify(dbPath)})`,
    `db.exec('PRAGMA busy_timeout = 5000')`,
    ...sql.map((s) => `db.exec(${JSON.stringify(s)})`),
    `db.close()`,
  ].join(';'))
}

test.describe('critical LOC-015 hospital-cm evidence unavailable chain', () => {
  test('real API + real browser: polluted count is withheld as 数据不可用; clean hospital still publishes; no fake ¥', async ({ page, request }) => {
    seed()
    try {
      // 真实后端 API 合同：污染院 cm=null + evidence unavailable；干净院 cm=280（合法数字照常发布）
      const token = await apiLogin(request, 'admin')
      const api = await apiGet(request, token, `/hospital-pnl?serviceMonth=${MONTH}`)
      expect(api.status()).toBe(200)
      const list = (await api.json())?.data?.list as Array<Record<string, unknown>>
      const badApi = list.find((r) => r.partnerId === BAD)!
      expect(badApi.cm).toBeNull()
      expect((badApi.evidence as { status: string }).status).toBe('unavailable')
      const okApi = list.find((r) => r.partnerId === OK)!
      expect(okApi.cm).toBe(280)
      expect((okApi.evidence as { status: string }).status).toBe('ok')

      await loginThroughUi(page, 'admin')
      await page.goto('/hospital-cm')
      await expect(page.getByRole('heading', { name: HEADING })).toBeVisible()
      await page.locator('input[type="month"]').fill(MONTH)

      const badRow = page.getByRole('row', { name: /E2E Evidence Bad Hospital/ })
      await expect(badRow).toBeVisible()
      await expect(badRow.getByTestId('evidence-unavailable-badge')).toHaveText(UNAVAILABLE)
      await expect(badRow).not.toContainText('\u00a5500')
      await expect(badRow).not.toContainText('500')

      const okRow = page.getByRole('row', { name: /E2E Evidence Ok Hospital/ })
      await expect(okRow).toBeVisible()
      // 当前校准态（经营线未定·仅供观察）下，干净院显示观察中而非「数据不可用」
      await expect(okRow).toContainText('\u89c2\u5bdf\u4e2d') // 观察中
      await expect(okRow.getByTestId('evidence-unavailable-badge')).toHaveCount(0)
      await expect(page.getByText('\u00a5500')).toHaveCount(0)
    } finally {
      cleanup()
    }
  })
})
