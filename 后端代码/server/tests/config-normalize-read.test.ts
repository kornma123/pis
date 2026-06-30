/**
 * PRD-0 T2 — 配置归一覆盖读/回滚路径（TC3 / TC4）。
 *
 * 背景：normalizeConfig 原仅在保存路径生效；历史版本里 discount.def=90（百倍虚高）从读/回滚路径漏进回退计算。
 *  - T2.1 读路径归一：row2config best-effort normalizeConfig → loadConfig/peekConfig 读出已归一（90→0.9）。
 *  - T2.2 回滚校验：rollback target 写新版本前 normalize；无法归一的坏历史版本明确报错，不生成 current。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import { v4 as uuidv4 } from 'uuid'
import { loadConfig, peekConfig, rollbackConfig, seedDefaultConfig, type PartnerConfig } from '../src/utils/partner-config.js'

let db: any
const genId = () => `PC-${uuidv4()}`

/** 直接注入一条历史版本（绕过 saveConfig 归一，模拟历史坏配置）。 */
function injectVersion(partnerId: string, version: number, config: PartnerConfig, isCurrent: boolean) {
  db.prepare(`UPDATE partner_configs SET is_current=0 WHERE partner_id=?`).run(partnerId)
  db.prepare(`INSERT INTO partner_configs (id, partner_id, version, config_json, is_current, is_baseline, created_by)
              VALUES (?, ?, ?, ?, ?, 0, 'test')`).run(genId(), partnerId, version, JSON.stringify(config), isCurrent ? 1 : 0)
}

beforeAll(async () => {
  db = await getDb()
  for (const [id, code, name] of [['PT-NORM', 'PT-N1', '坏扣率读院'], ['PT-RB', 'PT-N2', '回滚归一院'], ['PT-RBBAD', 'PT-N3', '回滚坏版本院']]) {
    db.prepare(`INSERT OR IGNORE INTO partners (id,code,name,status) VALUES (?,?,?,1)`).run(id, code, name)
  }
})

describe('TC3 历史坏扣率：读路径归一', () => {
  it('loadConfig 读出 discount.def=90 → 归一为 0.9（按线 85→0.85）', () => {
    const bad = seedDefaultConfig({ name: '坏扣率读院', code: 'x' })
    ;(bad.discount as any).def = 90
    bad.discount.byLine = [{ key: 'histo', rate: 85 as any }]
    injectVersion('PT-NORM', 1, bad, true)

    const r = loadConfig(db, 'PT-NORM', genId)
    expect(r.config.discount.def).toBe(0.9)
    expect(r.config.discount.byLine[0].rate).toBe(0.85)
  })

  it('peekConfig（只读路径）同样归一', () => {
    expect(peekConfig(db, 'PT-NORM').config.discount.def).toBe(0.9)
  })
})

describe('TC4 回滚坏版本', () => {
  it('回滚到含 def=90 的历史版本 → 新 current 已归一为 0.9，不带坏值', () => {
    const bad = seedDefaultConfig({ name: '回滚归一院', code: 'x' }); (bad.discount as any).def = 90
    injectVersion('PT-RB', 1, bad, false)
    const good = seedDefaultConfig({ name: '回滚归一院', code: 'x' }); good.discount.def = 0.8
    injectVersion('PT-RB', 2, good, true)

    const rb = rollbackConfig(db, 'PT-RB', 1, { genId })
    expect(rb.version).toBe(3)
    expect(loadConfig(db, 'PT-RB', genId).config.discount.def).toBe(0.9)
  })

  it('回滚到无法归一的坏版本（def 非数）→ 抛错，current 不变（不生成坏 current）', () => {
    const broken = seedDefaultConfig({ name: '回滚坏版本院', code: 'x' }); (broken.discount as any).def = 'abc'
    injectVersion('PT-RBBAD', 1, broken, false)
    const good = seedDefaultConfig({ name: '回滚坏版本院', code: 'x' })
    injectVersion('PT-RBBAD', 2, good, true)

    expect(() => rollbackConfig(db, 'PT-RBBAD', 1, { genId })).toThrow()
    const cur = db.prepare(`SELECT version FROM partner_configs WHERE partner_id='PT-RBBAD' AND is_current=1`).get() as any
    expect(cur.version).toBe(2) // current 仍是 v2，未被坏回滚污染
  })
})
