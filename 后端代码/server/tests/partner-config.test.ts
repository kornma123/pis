/**
 * P0 — 逐院配置（单一事实源）红测试。
 *
 * 配置驱动导入器的地基：每家医院一份【版本化】配置（lines+规则+scope / 三级扣率 /
 * 模板·列映射 / 计税 / 特殊结算），可回滚、可按版本追溯。仿本分支 bom_versions 范式。
 * config_json 与定稿 mockup（config_v11/v12）的配置对象 1:1（basic/amount/parse/lines/discount/special）。
 *
 * 红线：逐院单一事实源（测试台与配置页写同一份）；改规则即记一条变更、可回滚、可追溯重算。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import { v4 as uuidv4 } from 'uuid'
import {
  seedDefaultConfig,
  deepDiff,
  makeDiffs,
  loadConfig,
  saveConfig,
  getChanges,
  rollbackConfig,
  setBaseline,
  getConfigVersion,
  type PartnerConfig,
} from '../src/utils/partner-config.js'

let db: any
const genId = () => `PC-${uuidv4()}`

function addPartner(id: string, code: string, name: string) {
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, ?, ?, 1)`).run(id, code, name)
}

beforeAll(async () => {
  db = await getDb()
  addPartner('PT-SEED', 'PT-S0001', '和睦家·主院')
  addPartner('PT-SAVE', 'PT-S0002', '苍南县人民医院')
  addPartner('PT-ROLL', 'PT-S0003', '东安人民医院')
  addPartner('PT-ISOA', 'PT-S0004', '隔离A院')
  addPartner('PT-ISOB', 'PT-S0005', '隔离B院')
  addPartner('PT-BASE', 'PT-S0006', '基线院')
  addPartner('PT-LOCK', 'PT-S0007', '并发锁院')
  addPartner('PT-ATOM', 'PT-S0008', '原子院')
})

describe('原子性 + DB 约束（codex F2/F3）', () => {
  it('insertChange 失败 → 整体回滚：旧版本仍 current、无半成品新版本、current 唯一', () => {
    loadConfig(db, 'PT-ATOM', genId) // seed v1 + seed 变更
    const before = loadConfig(db, 'PT-ATOM', genId)
    const next: PartnerConfig = JSON.parse(JSON.stringify(before.config))
    next.discount.def = 0.5
    // 让 insertChange 复用一个已存在的变更行 id → 主键冲突，触发 SAVEPOINT 回滚
    const dupId = (db.prepare(`SELECT id FROM partner_config_changes WHERE partner_id='PT-ATOM' LIMIT 1`).get() as any).id
    let n = 0
    const badGen = () => { n++; return n === 1 ? 'PC-atom-newrow' : dupId } // 1=新版本行id / 2=变更行id(冲突)
    expect(() => saveConfig(db, 'PT-ATOM', next, { genId: badGen })).toThrow()

    const after = loadConfig(db, 'PT-ATOM', genId)
    expect(after.version).toBe(before.version) // 版本没涨（无半成品）
    expect(after.config.discount.def).not.toBe(0.5) // 配置未被破坏
    const cc = (db.prepare(`SELECT COUNT(*) AS c FROM partner_configs WHERE partner_id='PT-ATOM' AND is_current=1`).get() as any).c
    expect(cc).toBe(1) // current 唯一
  })
})

describe('seedDefaultConfig（纯函数·默认 8 线模板）', () => {
  it('产出 8 条默认业务线：4 计入(in) + 4 移出(out)', () => {
    const cfg = seedDefaultConfig({ name: '示例医院', code: 'PT-X0001' })
    expect(cfg.lines).toHaveLength(8)
    const ins = cfg.lines.filter((l) => l.scope === 'in')
    const outs = cfg.lines.filter((l) => l.scope === 'out')
    expect(ins).toHaveLength(4)
    expect(outs).toHaveLength(4)
    // 计入：组织学/细胞·宫颈TCT/院内冰冻/线下外院会诊
    expect(ins.map((l) => l.key).sort()).toEqual(['consult', 'cyto', 'frozen', 'histo'])
    // 移出：外送基因NGS/荧光原位FISH/远程诊断/共建分成净额
    expect(outs.map((l) => l.key).sort()).toEqual(['fish', 'joint_share', 'ngs', 'remote'])
  })

  it('每条线有稳定 key（非位置索引）+ 前缀/识别词数组；院内冰冻含「冰」前缀、会诊含 H/Y 前缀', () => {
    const cfg = seedDefaultConfig({ name: '示例', code: 'PT-X' })
    for (const l of cfg.lines) {
      expect(typeof l.key).toBe('string')
      expect(l.key.length).toBeGreaterThan(0)
      expect(Array.isArray(l.prefixes)).toBe(true)
      expect(Array.isArray(l.keywords)).toBe(true)
      expect(Array.isArray(l.remarks)).toBe(true)
    }
    expect(cfg.lines.find((l) => l.key === 'frozen')!.prefixes).toContain('冰')
    expect(cfg.lines.find((l) => l.key === 'consult')!.prefixes).toEqual(expect.arrayContaining(['H', 'Y']))
  })

  it('basic 用传入的名称/编码；amount 默认未税；discount.def 默认占位', () => {
    const cfg = seedDefaultConfig({ name: '和睦家·主院', code: 'PT-S0001' })
    expect(cfg.basic.full).toBe('和睦家·主院')
    expect(cfg.basic.code).toBe('PT-S0001')
    expect(cfg.amount.bill).toBe('未税')
    expect(cfg.amount.settle).toBe('未税')
    expect(typeof cfg.discount.def).toBe('number')
    expect(cfg.discount.def).toBeGreaterThan(0)
    expect(cfg.discount.def).toBeLessThanOrEqual(1)
  })
})

describe('deepDiff / makeDiffs（变更追溯）', () => {
  it('deepDiff 逐字段（含嵌套数组）找出差异', () => {
    const a = seedDefaultConfig({ name: 'A', code: 'c' })
    const b: PartnerConfig = JSON.parse(JSON.stringify(a))
    b.discount.def = 0.85
    b.lines[0].keywords.push('新识别词')
    const diffs = deepDiff(a, b)
    expect(diffs.find((d) => d.path === 'discount.def' && d.before === a.discount.def && d.after === 0.85)).toBeTruthy()
    expect(diffs.find((d) => d.after === '新识别词')).toBeTruthy()
  })

  it('makeDiffs 给出友好中文标签（调整前→调整后）', () => {
    const a = seedDefaultConfig({ name: 'A', code: 'c' })
    const b: PartnerConfig = JSON.parse(JSON.stringify(a))
    b.discount.def = 0.85
    const fr = makeDiffs(a, b)
    const hit = fr.find((d) => d.path === 'discount.def')
    expect(hit).toBeTruthy()
    expect(typeof hit!.label).toBe('string')
    expect(hit!.label.length).toBeGreaterThan(0)
    expect(hit!.before).toBe(a.discount.def)
    expect(hit!.after).toBe(0.85)
  })
})

describe('loadConfig（首访默认 seed + 持久化）', () => {
  it('首次 load → version 1 + 持久化默认配置 + 记一条 seed 变更', () => {
    const r = loadConfig(db, 'PT-SEED', genId)
    expect(r.version).toBe(1)
    expect(r.config.lines).toHaveLength(8)
    expect(r.config.basic.full).toBe('和睦家·主院')
    const ch = getChanges(db, 'PT-SEED')
    expect(ch).toHaveLength(1)
    expect(ch[0].kind).toBe('seed')
  })

  it('二次 load 不重复 seed（仍 version 1，不新增版本/变更）', () => {
    const r2 = loadConfig(db, 'PT-SEED', genId)
    expect(r2.version).toBe(1)
    expect(getChanges(db, 'PT-SEED')).toHaveLength(1)
  })
})

describe('saveConfig（生成版本 + 变更）', () => {
  it('改配置 → version 2 + edit 变更含 discount.def 调整前后', () => {
    loadConfig(db, 'PT-SAVE', genId) // seed v1
    const cur = loadConfig(db, 'PT-SAVE', genId).config
    const next: PartnerConfig = JSON.parse(JSON.stringify(cur))
    next.discount.def = 0.85
    next.lines.find((l) => l.key === 'consult')!.keywords.push('Ki67')
    const res = saveConfig(db, 'PT-SAVE', next, { changedBy: '测试', tab: '结算扣率', genId })
    expect(res.version).toBe(2)
    expect(res.diffs.length).toBeGreaterThan(0)

    const after = loadConfig(db, 'PT-SAVE', genId)
    expect(after.version).toBe(2)
    expect(after.config.discount.def).toBe(0.85)

    const ch = getChanges(db, 'PT-SAVE')
    expect(ch[0].kind).toBe('edit')
    expect(ch[0].version).toBe(2)
    expect(ch[0].diffs.find((d: any) => d.path === 'discount.def')).toBeTruthy()
  })

  it('保存无改动 = 幂等空操作（版本不变、不新增变更）', () => {
    const cur = loadConfig(db, 'PT-SAVE', genId).config
    const res = saveConfig(db, 'PT-SAVE', cur, { genId })
    expect(res.version).toBe(2)
    expect(res.diffs).toHaveLength(0)
    expect(getChanges(db, 'PT-SAVE').filter((c: any) => c.kind === 'edit')).toHaveLength(1)
  })

  it('乐观锁：expectedVersion 不匹配则抛冲突（防测试台/配置页并发覆盖）', () => {
    const cur = loadConfig(db, 'PT-SAVE', genId).config
    const stale: PartnerConfig = JSON.parse(JSON.stringify(cur))
    stale.discount.def = 0.7
    expect(() => saveConfig(db, 'PT-SAVE', stale, { genId, expectedVersion: 1 })).toThrow()
  })
})

describe('rollbackConfig（回滚不抹历史）', () => {
  it('回滚到 version 1 → 新增 version 3（is_current）+ 配置还原 + 历史保留', () => {
    loadConfig(db, 'PT-ROLL', genId) // v1 def=0.9
    const v1def = loadConfig(db, 'PT-ROLL', genId).config.discount.def
    const next: PartnerConfig = JSON.parse(JSON.stringify(loadConfig(db, 'PT-ROLL', genId).config))
    next.discount.def = 0.5
    saveConfig(db, 'PT-ROLL', next, { genId }) // v2 def=0.5

    const rb = rollbackConfig(db, 'PT-ROLL', 1, { changedBy: '测试', genId })
    expect(rb.version).toBe(3)
    const now = loadConfig(db, 'PT-ROLL', genId)
    expect(now.version).toBe(3)
    expect(now.config.discount.def).toBe(v1def)

    // 历史版本仍可取（不可变）
    expect(getConfigVersion(db, 'PT-ROLL', 1)!.discount.def).toBe(v1def)
    expect(getConfigVersion(db, 'PT-ROLL', 2)!.discount.def).toBe(0.5)
    expect(getChanges(db, 'PT-ROLL').find((c: any) => c.kind === 'rollback')).toBeTruthy()
  })
})

describe('逐院隔离（单一事实源按医院独立）', () => {
  it('改 A 院配置不影响 B 院的版本与配置', () => {
    loadConfig(db, 'PT-ISOA', genId)
    loadConfig(db, 'PT-ISOB', genId)
    const a = loadConfig(db, 'PT-ISOA', genId).config
    const na: PartnerConfig = JSON.parse(JSON.stringify(a))
    na.discount.def = 0.33
    saveConfig(db, 'PT-ISOA', na, { genId })

    const b = loadConfig(db, 'PT-ISOB', genId)
    expect(b.version).toBe(1)
    expect(b.config.discount.def).not.toBe(0.33)
    expect(b.config.basic.full).toBe('隔离B院')
  })
})

describe('setBaseline（月度导入基线）', () => {
  it('设某版本为基线 → is_baseline 标记，current 仍可取', () => {
    loadConfig(db, 'PT-BASE', genId)
    setBaseline(db, 'PT-BASE', 1, { changedBy: '测试' })
    const row = db.prepare(`SELECT is_baseline FROM partner_configs WHERE partner_id=? AND version=1`).get('PT-BASE') as any
    expect(Number(row.is_baseline)).toBe(1)
    expect(loadConfig(db, 'PT-BASE', genId).version).toBe(1)
  })
})

describe('case_revenue.config_version 列（追溯重算锚）', () => {
  it('case_revenue 含 config_version 列', () => {
    const cols = db.prepare(`PRAGMA table_info(case_revenue)`).all() as any[]
    expect(cols.map((c) => c.name)).toContain('config_version')
  })
})
