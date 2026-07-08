/**
 * 账实核对 · 件数解析根因修复（floor-to-1 → 从描述解析真实件数 + 解析不出标低置信）。
 *
 * 病灶（修前）reconcile-compute.ts:83：`slides = Number(qty) > 0 ? qty : 1`。
 *   真实对账单（温州中心医院，全部月份）把一 case 的免疫组化聚合成一行、真实件数写在服务项目文本里
 *   （`免疫组化*16` 表示 16 片），且导入器不落 qty → 此处按 1 片 → 系统性低估账单件数
 *   → billCount(1) < lisCount(16) → 量产假的「疑似漏收，需补收」。
 *
 * 修法（本文件锁）：
 *  1) qty 缺/0 时从 charge_item 文本解析真实件数——只认「CJK 后紧跟的乘号 *N/×N」这一在真数据里唯一
 *     可靠的写法（`免疫组化*16`→16）；**不**从价格/费用明细里瞎抓数字（`FISH750*2` 的 750/2、`免疫组化144`
 *     的 144 都不是件数）。
 *  2) 解析不出且**有聚合信号**（乘号残缺 / `/个`·`/项` 费用明细 / 多个冲突计数）→ 保持按 1 但标 low_confidence，
 *     使其不进入「高置信漏收」；无任何聚合信号的普通单行（`免疫组化`）仍按 1 且高置信（设计基线，不泛滥标低置信）。
 *
 * 真实件数样本（scratchpad/duizhang 60 份真对账单扫描实证）：
 *   `免疫组化*16`(24×) `*17`(16×) `*15` `*4` `*20` `*1`；`61基因检测+免疫组化*2`；`刚果红染色组化*1`。
 *   过度抓取陷阱（真数据）：`基础诊断费：265+蜡块20/个+局部81/个+FISH750*2/项+特染42/项+封染片33+免疫组化144`。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import { buildReconcileInputs, parseSlideCount, runReconcile } from '../src/utils/reconcile-compute.js'
import { computeReconcile } from '../src/utils/reconcile-account.js'

// ────────────────────────────────────────────────────────────────────────────
// 1) 纯解析函数 parseSlideCount —— 件数从哪来 + 反向验证不 over-count
// ────────────────────────────────────────────────────────────────────────────
describe('parseSlideCount · qty 优先（有数量列时不动）', () => {
  it('qty>0 直接用 qty（文本无关）·高置信', () => {
    expect(parseSlideCount('免疫组化检测（前八项）', 8)).toEqual({ count: 8, confident: true })
    expect(parseSlideCount('免疫组化*16', 3)).toEqual({ count: 3, confident: true }) // qty 赢
    expect(parseSlideCount('特殊染色', '2')).toEqual({ count: 2, confident: true }) // 字符串数字
  })
  it('qty 缺/0/负/非有限 → 落到文本解析（不再直接信 qty）', () => {
    expect(parseSlideCount('免疫组化', 0).count).toBe(1)
    expect(parseSlideCount('免疫组化', null as any).count).toBe(1)
    expect(parseSlideCount('免疫组化', undefined as any).count).toBe(1)
    expect(parseSlideCount('免疫组化', -3).count).toBe(1)
    expect(parseSlideCount('免疫组化', NaN as any).count).toBe(1)
  })
})

describe('parseSlideCount · 从文本解析真实件数（qty 缺）', () => {
  it('免疫组化*N → N 片·高置信（温州真样本）', () => {
    for (const [text, n] of [['免疫组化*16', 16], ['免疫组化*17', 17], ['免疫组化*15', 15], ['免疫组化*4', 4], ['免疫组化*20', 20], ['免疫组化*1', 1]] as const) {
      expect(parseSlideCount(text, 0)).toEqual({ count: n, confident: true })
    }
  })
  it('复合行 `61基因检测+免疫组化*2` → 只取贴着抗体名的 *2·高置信', () => {
    expect(parseSlideCount('61基因检测+免疫组化*2', 0)).toEqual({ count: 2, confident: true })
  })
  it('特染 `刚果红染色组化*1` → 1·高置信', () => {
    expect(parseSlideCount('刚果红染色组化*1', 0)).toEqual({ count: 1, confident: true })
  })
  it('乘号变体 ×✕╳ 认；Latin x/X 不认（真数据只用 *·防 X100 编码误吞）', () => {
    expect(parseSlideCount('免疫组化×5', 0)).toEqual({ count: 5, confident: true })
    expect(parseSlideCount('免疫组化✕7', 0)).toEqual({ count: 7, confident: true })
    expect(parseSlideCount('免疫组化X100', 0)).toEqual({ count: 1, confident: true }) // 编码非件数，不抓
    expect(parseSlideCount('免疫组化x9', 0)).toEqual({ count: 1, confident: true }) // Latin x 不认
  })
  it('全角乘号/全角数字经 NFKC 归一后也认（免疫组化＊１６→16）', () => {
    expect(parseSlideCount('免疫组化＊１６', 0)).toEqual({ count: 16, confident: true })
    expect(parseSlideCount('免疫组化　＊　６', 0)).toEqual({ count: 6, confident: true }) // 全角空格
  })
})

describe('parseSlideCount · 反向验证：绝不 over-count（把非件数文本误当件数）', () => {
  it('费用明细行绝不抓价格/单价数字（真数据陷阱）', () => {
    const trap = '基础诊断费：265+蜡块20/个+局部81/个+FISH750*2/项+特染42/项+封染片33+免疫组化144'
    const r = parseSlideCount(trap, 0)
    // 关键安全属性：绝不把 265/750/2/42/144 当成件数
    expect(r.count).toBe(1)
    expect([265, 750, 2, 42, 144, 20, 81, 33]).not.toContain(r.count)
    // 有 `/个`·`/项` 费用明细聚合信号 → 标低置信分流人工，不当高置信漏收
    expect(r.confident).toBe(false)
  })
  it('数字被 digit 前缀（价格式 750*2）不误认——乘号须紧跟 CJK 名', () => {
    // 纯价格表达 `750*2` 的 * 前是数字 0，不是抗体名 → 不抓
    expect(parseSlideCount('检测费750*2元', 0).count).toBe(1)
  })
  it('中文费率乘法绝不抓价格/费率数字（对抗复核实证的真费用语法）', () => {
    // N次×单价元（真样本 石门医院 352次*18元 格式）——18 是单价、非件数
    expect(parseSlideCount('免疫组化2次*18元', 0)).toEqual({ count: 1, confident: false })
    expect(parseSlideCount('352次*18元', 0)).toEqual({ count: 1, confident: false })
    // 每片×价 / 每项×价 —— 每×单价、非件数
    expect(parseSlideCount('免疫组化每片×85元', 0)).toEqual({ count: 1, confident: false })
    expect(parseSlideCount('免疫组化（每项×36）', 0)).toEqual({ count: 1, confident: false })
    // 百分率 / N种×价 —— 都不是件数
    expect(parseSlideCount('工会经费（应付工资*2%）', 0).count).toBe(1)
    expect(parseSlideCount('免疫组化3种×8元', 0)).toEqual({ count: 1, confident: false })
  })
  it('乘号贴在非线名（检测/会诊）上绝不当件数（codex 异构复核逮到）', () => {
    // 检测*2/项：检测非免疫组化/特染线名 + /项 费率单位 → 不取 2
    expect(parseSlideCount('基础诊断费：265+FISH检测*2/项+特染42/项+免疫组化144', 0)).toEqual({ count: 1, confident: false })
    expect(parseSlideCount('FISH检测*2/项', 0).count).toBe(1)
    // 会诊×2：会诊非线名 → 不取 2（乘号须紧贴 免疫组化/组化/染色/特染 线名尾）
    expect(parseSlideCount('免疫组化+会诊×2', 0)).toEqual({ count: 1, confident: false })
  })
  it('件数超合理上界（疑似误填价格）→ 标低置信、不硬信', () => {
    expect(parseSlideCount('免疫组化*2884', 0)).toEqual({ count: 1, confident: false })
    expect(parseSlideCount('免疫组化*0', 0)).toEqual({ count: 1, confident: false })
  })
  it('同一行多个冲突计数 → 歧义、标低置信不乱并', () => {
    expect(parseSlideCount('免疫组化*8+特染*3', 0)).toEqual({ count: 1, confident: false })
  })
})

describe('parseSlideCount · 普通单行按 1 且高置信（设计基线·不泛滥标低置信）', () => {
  it('无任何聚合信号的普通行 → 1·高置信', () => {
    for (const t of ['免疫组化', '免疫组织化学染色诊断', '免疫组化染色', '特殊染色', 'Masson三色染色']) {
      expect(parseSlideCount(t, 0)).toEqual({ count: 1, confident: true })
    }
  })
  it('空/异常输入 → 1·高置信（防御）', () => {
    expect(parseSlideCount('', 0)).toEqual({ count: 1, confident: true })
    expect(parseSlideCount(undefined as any, 0)).toEqual({ count: 1, confident: true })
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 2) buildReconcileInputs 集成：真实聚合行不再被系统性低估
// ────────────────────────────────────────────────────────────────────────────
describe('buildReconcileInputs · 聚合行件数解析（端到端·真样本）', () => {
  let db: any
  const P = 'PARTNER-SLIDECOUNT'
  const M = '2025-10'
  beforeAll(async () => {
    db = await getDb()
    const insLine = (id: string, caseNo: string, item: string, qty: number | null, unit: number | null, gross: number) =>
      db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, gross_amount, service_month) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, caseNo, P, item, qty, unit, gross, M)
    const insLis = (id: string, caseNo: string, ihc: number, ss: number) =>
      db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, operate_time, ihc_count, special_stain_count) VALUES (?, ?, ?, '2025-10-15', ?, ?)`)
        .run(id, caseNo, P, ihc, ss)

    // 温州真样本：一行 `免疫组化*16`，qty 未落库（NULL），gross=2884
    insLine('crl-agg16', 'H25-01121', '免疫组化*16', null, null, 2884)
    insLis('lis-agg16', 'H25-01121', 16, 0)
    // 普通单行 qty=3（path-1 带数量列）——回归：不受影响
    insLine('crl-qty3', 'C-QTY', '免疫组化', 3, 100, 300)
    insLis('lis-qty3', 'C-QTY', 3, 0)
    // 普通单行 qty 缺、无聚合信号 —— 仍按 1
    insLine('crl-plain', 'C-PLAIN', '免疫组化', null, null, 180)
    insLis('lis-plain', 'C-PLAIN', 1, 0)
  })

  it('`免疫组化*16` + qty 缺 → 账单件数 = 16（修前为 1）', () => {
    const inputs = buildReconcileInputs(db, P, M)
    const b = inputs.bills.find((x) => x.caseNo === 'H25-01121')!
    expect(b.ihc).toBe(16) // 🔴 修前=1
    // 单价也被修正：2884/16≈180.25，不再是 2884/1
    expect(b.ihcUnitPrice).toBeCloseTo(180.25, 2)
  })

  it('聚合行修复后 delta=0 → 不再量产假漏收', () => {
    const inputs = buildReconcileInputs(db, P, M)
    const r = computeReconcile(inputs.bills, inputs.lis)
    const d = r.diffs.find((x) => x.caseNo === 'H25-01121')
    expect(d).toBeUndefined() // 16 vs 16 → 相等不出差异（修前 1 vs 16 = 漏收 15）
  })

  it('回归：qty>0 的普通行件数不变（=3）', () => {
    const inputs = buildReconcileInputs(db, P, M)
    expect(inputs.bills.find((x) => x.caseNo === 'C-QTY')!.ihc).toBe(3)
  })

  it('普通单行 qty 缺仍按 1（基线不变）', () => {
    const inputs = buildReconcileInputs(db, P, M)
    expect(inputs.bills.find((x) => x.caseNo === 'C-PLAIN')!.ihc).toBe(1)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 3) runReconcile 落库：解析不出的聚合行 → 差异标 low_confidence（分流人工，不当高置信漏收）
//    普通行/已解析行 → 不被泛滥标低置信。既有末端人闸（#79）不动。
// ────────────────────────────────────────────────────────────────────────────
describe('runReconcile · 低置信分流（消除「静默按 1 → 高置信漏收」）', () => {
  let db: any
  const P = 'PARTNER-LOWCONF'
  const M = '2026-03'
  beforeAll(async () => {
    db = await getDb()
    const insLine = (id: string, caseNo: string, item: string, qty: number | null, gross: number) =>
      db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, gross_amount, service_month) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
        .run(id, caseNo, P, item, qty, gross, M)
    const insLis = (id: string, caseNo: string, ihc: number) =>
      db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, operate_time, ihc_count, special_stain_count) VALUES (?, ?, ?, '2026-03-10', ?, 0)`)
        .run(id, caseNo, P, ihc)

    // A) 解析不出的聚合行（费用明细 `/项`）→ 差异应标 low_confidence
    insLine('lc-agg', 'CASE-AGG', '基础诊断费：+特染42/项+免疫组化144', null, 500)
    insLis('lc-agg-lis', 'CASE-AGG', 5) // bill 按 1 vs lis 5 → 漏收，但低置信
    // B) 普通单行 qty 缺、无聚合信号，账实不等 → 高置信漏收（不被泛滥标低置信）
    insLine('lc-plain', 'CASE-PLAIN', '免疫组化', null, 180)
    insLis('lc-plain-lis', 'CASE-PLAIN', 2) // bill 1 vs lis 2 → 漏收，高置信
    // C) 已解析聚合行 `*16` → 相等、无差异（不产生噪声）
    insLine('lc-star', 'CASE-STAR', '免疫组化*16', null, 2884)
    insLis('lc-star-lis', 'CASE-STAR', 16)
    // 凑匹配率 100% 使 matchStatus=正常、出差异
    runReconcile(db, P, M, 'tester')
  })

  it('解析不出的聚合行差异 → low_confidence=1（分流人工）', () => {
    const d = db.prepare(`SELECT * FROM reconcile_diffs WHERE partner_id=? AND case_no='CASE-AGG' AND line_type='免疫组化'`).get(P) as any
    expect(d).toBeTruthy()
    expect(d.system_hint).toBe('疑似漏收，需补收')
    expect(d.low_confidence).toBe(1) // 🔴 修前=0（静默按 1 当高置信漏收）
  })

  it('普通单行差异 → low_confidence=0（高置信·不被泛滥标低置信）', () => {
    const d = db.prepare(`SELECT * FROM reconcile_diffs WHERE partner_id=? AND case_no='CASE-PLAIN' AND line_type='免疫组化'`).get(P) as any
    expect(d).toBeTruthy()
    expect(d.low_confidence).toBe(0)
  })

  it('已解析 `*16` 聚合行 → 无差异（不再假漏收）', () => {
    const d = db.prepare(`SELECT * FROM reconcile_diffs WHERE partner_id=? AND case_no='CASE-STAR'`).get(P) as any
    expect(d).toBeUndefined()
  })
})
