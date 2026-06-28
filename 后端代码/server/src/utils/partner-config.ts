/**
 * 逐院配置（单一事实源）—— 配置驱动导入器 P0 地基。
 *
 * 每家医院一份【版本化】配置：业务线(lines)+识别规则+计入/移出(scope) / 三级扣率 /
 * 对账单模板·列映射 / 计税口径 / 特殊结算（保底费·共建分成）。版本不可变、可回滚、
 * 可按版本追溯重算（仿本分支 bom_versions 范式）。
 *
 * config_json 与定稿 mockup（config_v11/v12）的配置对象 1:1，但【不含】变更记录数组——
 * 变更落 partner_config_changes 表（对应 mockup 的 cfgOnly）。
 *
 * 红线：
 *  - 逐院单一事实源：配置页 / 导入测试台 / 月度向导 读写【同一份】逐院配置。
 *  - 改规则即记一条变更（调整前→调整后 + 快照），可回滚、可追溯。
 *  - 乐观锁防测试台与配置页并发覆盖（§8.5）。
 *  - 纯函数（seed/diff/label）+ DB 帮手分离，无 express 依赖。
 */

// —— 类型（与 mockup 配置对象 1:1）——

/** 一条业务线（检测类别）。key = 稳定标识（非位置索引，防 reorder 错位）。 */
export interface PartnerConfigLine {
  key: string
  name: string
  on: boolean
  scope: 'in' | 'out' // 计入实验室 / 移出
  prefixes: string[] // 病理号前缀识别词（如 冰 / H / M）
  keywords: string[] // 项目名含
  remarks: string[] // 备注含（仅列映射了备注列时生效）
}

export interface PartnerConfig {
  basic: { full: string; short: string; code: string; group: string; campus: string; start: string; status: string; contact: string }
  amount: { bill: '未税' | '含税'; settle: '未税' | '含税'; rate: number } // 计税口径 + 税率(%)
  parse: { uploaded: boolean; file: string; rows: number; template: string; colMap: Record<string, unknown> }
  lines: PartnerConfigLine[]
  discount: { def: number; byLine: { key: string; rate: number }[]; byItem: { item: string; rate: number }[] } // 三级扣率：项>线>默认
  special: { retainer: { on: boolean; name: string; amount: number }; joint: { on: boolean; ratio: number; share: string } }
}

export type ChangeKind = 'seed' | 'edit' | 'rollback'

export interface FriendlyDiff {
  path: string
  label: string
  before: unknown
  after: unknown
}

export interface ChangeRow {
  version: number
  kind: ChangeKind
  tab: string | null
  diffs: FriendlyDiff[]
  changedAt: string
  changedBy: string | null
}

interface DbLike {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] }
  exec: (sql: string) => unknown
}

/**
 * 原子写（codex F2）：把多条 SQL（UPDATE is_current=0 + INSERT 版本 + 写变更）包进 SAVEPOINT，
 * 任一失败整体回滚——否则失败时该院会留下「无 current 配置 / 配置变了但无审计」。
 * 用 SAVEPOINT 而非 BEGIN：可嵌套在调用方已开的事务里（如 /commit 的 BEGIN IMMEDIATE），不冲突。
 */
let spCounter = 0
function tx<T>(db: DbLike, fn: () => T): T {
  const sp = `sp_pc_${++spCounter}`
  db.exec(`SAVEPOINT ${sp}`)
  try {
    const r = fn()
    db.exec(`RELEASE ${sp}`)
    return r
  } catch (e) {
    db.exec(`ROLLBACK TO ${sp}`)
    db.exec(`RELEASE ${sp}`)
    throw e
  }
}

// —— 默认 8 线模板（plan §P0：4 计入 + 4 移出）——
// 识别词取自定稿 mockup config_v11 默认模板；第 8 线「共建分成净额」按 plan 补齐（mockup 默认 7 线，
// 共建按院 special.joint 开关，此处作为默认目录线占位，识别走专用解析器）。
function defaultLines(): PartnerConfigLine[] {
  return [
    { key: 'histo', name: '组织学', on: true, scope: 'in', prefixes: [], keywords: ['手术标本', '活检', '穿刺', '内镜'], remarks: [] },
    { key: 'cyto', name: '细胞·宫颈TCT', on: true, scope: 'in', prefixes: [], keywords: ['TCT', '液基', '体液细胞'], remarks: [] },
    { key: 'frozen', name: '院内冰冻', on: true, scope: 'in', prefixes: ['冰'], keywords: ['冰冻', '术中'], remarks: [] },
    { key: 'consult', name: '线下外院会诊', on: true, scope: 'in', prefixes: ['H', 'Y'], keywords: ['会诊', '免疫组化', '癌基因蛋白', '单克隆抗体', 'PD-L1'], remarks: [] },
    { key: 'ngs', name: '外送基因检测（NGS）', on: true, scope: 'out', prefixes: ['M', 'Q'], keywords: ['基因', 'panel', '测序', '泛癌'], remarks: [] },
    { key: 'fish', name: '荧光原位杂交（FISH）', on: true, scope: 'out', prefixes: ['F'], keywords: ['荧光原位', 'FISH'], remarks: [] },
    { key: 'remote', name: '远程诊断', on: true, scope: 'out', prefixes: ['常'], keywords: [], remarks: ['远程'] },
    { key: 'joint_share', name: '共建分成净额', on: true, scope: 'out', prefixes: [], keywords: ['分成', '共建'], remarks: [] },
  ]
}

/** 默认配置（建档起点；真实逐院差异靠建档上传样表校正）。 */
export function seedDefaultConfig(opts: { name?: string; code?: string } = {}): PartnerConfig {
  return {
    basic: { full: opts.name || '', short: '', code: opts.code || '', group: '无（独立医院）', campus: '', start: '', status: '合作中', contact: '' },
    amount: { bill: '未税', settle: '未税', rate: 6 },
    parse: { uploaded: false, file: '', rows: 0, template: '', colMap: {} },
    lines: defaultLines(),
    discount: { def: 0.9, byLine: [], byItem: [] },
    special: { retainer: { on: false, name: '每月固定保底费', amount: 0 }, joint: { on: false, ratio: 0, share: '' } },
  }
}

// —— 纯函数：深度 diff + 友好标签（仿 mockup deepDiff/fLabel/makeDiffs）——

export interface RawDiff { path: string; before: unknown; after: unknown }

/** 逐字段（含嵌套对象/数组）找出差异；叶子用 JSON.stringify 比较。 */
export function deepDiff(a: unknown, b: unknown, path = '', out: RawDiff[] = []): RawDiff[] {
  if (a === b) return out
  const ta = typeof a
  const tb = typeof b
  if (ta !== 'object' || a === null || tb !== 'object' || b === null) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, before: a, after: b })
    return out
  }
  const keys = new Set<string>([...Object.keys(a as object), ...Object.keys(b as object)])
  for (const k of keys) {
    deepDiff((a as any)[k], (b as any)[k], path ? `${path}.${k}` : k, out)
  }
  return out
}

const TAB_LABEL: Record<string, string> = {
  'basic.full': '医院全称', 'basic.short': '简称', 'basic.code': '编码', 'basic.group': '所属集团', 'basic.campus': '院区', 'basic.start': '合作起始', 'basic.status': '合作状态', 'basic.contact': '联系人',
  'amount.bill': '开单计税口径', 'amount.settle': '结算计税口径', 'amount.rate': '税率(%)',
  'discount.def': '默认扣率',
  'special.retainer.on': '是否含每月固定保底费', 'special.retainer.name': '保底费名称', 'special.retainer.amount': '每月固定保底费金额',
  'special.joint.on': '是否共建分成', 'special.joint.ratio': '分成比例(%)', 'special.joint.share': '分成说明',
}

/** 路径 → 友好中文标签（lines.{i}.{字段} 用 cur 配置里该线的当前名称）。 */
export function fLabel(path: string, cur: PartnerConfig): string {
  if (TAB_LABEL[path]) return TAB_LABEL[path]
  const ml = path.match(/^lines\.(\d+)\.(.+)$/)
  if (ml) {
    const ln = (cur.lines[+ml[1]] || {}).name || `业务线 ${+ml[1] + 1}`
    const rest = ml[2]
    if (rest === 'name') return `${ln} · 名称`
    if (rest === 'scope') return `${ln} · 是否计入实验室`
    if (rest === 'on') return `${ln} · 是否启用`
    if (/^keywords\./.test(rest)) return `${ln} · 识别词（项目名）`
    if (/^prefixes\./.test(rest)) return `${ln} · 识别词（病理号前缀）`
    if (/^remarks\./.test(rest)) return `${ln} · 识别词（备注）`
    return `${ln} · 设置`
  }
  const md = path.match(/^discount\.byItem\.(\d+)\./)
  if (md) return `按项目扣率 #${+md[1] + 1}`
  const mbl = path.match(/^discount\.byLine\.(\d+)\./)
  if (mbl) return `按业务线扣率 #${+mbl[1] + 1}`
  if (path.startsWith('parse.')) return '对账单解析设置'
  return path
}

/** 友好 diff（调整前→调整后 + 中文标签）。 */
export function makeDiffs(prev: PartnerConfig, cur: PartnerConfig): FriendlyDiff[] {
  return deepDiff(prev, cur).map((d) => ({ path: d.path, label: fLabel(d.path, cur), before: d.before, after: d.after }))
}

// —— DB 帮手 ——

function row2config(json: string): PartnerConfig {
  return JSON.parse(json) as PartnerConfig
}

function currentRow(db: DbLike, partnerId: string): { version: number; config_json: string } | undefined {
  return db.prepare(`SELECT version, config_json FROM partner_configs WHERE partner_id=? AND is_current=1`).get(partnerId) as any
}

function insertChange(db: DbLike, partnerId: string, version: number, kind: ChangeKind, tab: string | null, diffs: FriendlyDiff[], snapshot: PartnerConfig, changedBy: string | null, genId: () => string) {
  db.prepare(
    `INSERT INTO partner_config_changes (id, partner_id, version, kind, tab, diffs_json, snapshot_json, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(genId(), partnerId, version, kind, tab, JSON.stringify(diffs), JSON.stringify(snapshot), changedBy)
}

function writeVersion(db: DbLike, partnerId: string, version: number, config: PartnerConfig, createdBy: string | null, genId: () => string) {
  db.prepare(`UPDATE partner_configs SET is_current=0 WHERE partner_id=?`).run(partnerId)
  db.prepare(
    `INSERT INTO partner_configs (id, partner_id, version, config_json, is_current, is_baseline, created_by) VALUES (?, ?, ?, ?, 1, 0, ?)`,
  ).run(genId(), partnerId, version, JSON.stringify(config), createdBy)
}

/**
 * 读配置；首访无配置 → 按默认模板 seed v1（从 partners 取名称/编码）+ 记一条 seed 变更。
 */
export function loadConfig(db: DbLike, partnerId: string, genId: () => string): { version: number; config: PartnerConfig; isBaseline: boolean } {
  const cur = currentRow(db, partnerId)
  if (cur) {
    const baseRow = db.prepare(`SELECT is_baseline FROM partner_configs WHERE partner_id=? AND is_current=1`).get(partnerId) as any
    return { version: cur.version, config: row2config(cur.config_json), isBaseline: Number(baseRow?.is_baseline) === 1 }
  }
  const p = db.prepare(`SELECT name, code FROM partners WHERE id=?`).get(partnerId) as any
  const config = seedDefaultConfig({ name: p?.name, code: p?.code })
  tx(db, () => {
    writeVersion(db, partnerId, 1, config, 'system', genId)
    insertChange(db, partnerId, 1, 'seed', null, [], config, 'system', genId)
  })
  return { version: 1, config, isBaseline: false }
}

/**
 * 只读取配置（**不 seed、不写库**）：有配置→返回当前版；无→返回内存默认(version 0, persisted=false)。
 * 供 /preview 等只读路径（codex F4：loadConfig 首访会 seed 写库，违反「未落库」契约）。
 */
export function peekConfig(db: DbLike, partnerId: string): { version: number; config: PartnerConfig; persisted: boolean } {
  const cur = currentRow(db, partnerId)
  if (cur) return { version: cur.version, config: row2config(cur.config_json), persisted: true }
  const p = db.prepare(`SELECT name, code FROM partners WHERE id=?`).get(partnerId) as any
  return { version: 0, config: seedDefaultConfig({ name: p?.name, code: p?.code }), persisted: false }
}

/**
 * 保存配置 → 与当前版本 diff；无差异=幂等空操作；有差异=新版本+1（is_current）+ edit 变更。
 * 乐观锁：传 expectedVersion 且与当前不符则抛冲突（防测试台/配置页并发覆盖）。
 */
export function saveConfig(
  db: DbLike,
  partnerId: string,
  config: PartnerConfig,
  opts: { changedBy?: string; tab?: string; genId: () => string; expectedVersion?: number },
): { version: number; diffs: FriendlyDiff[] } {
  const cur = currentRow(db, partnerId)
  if (!cur) {
    // 无配置 → 先 seed 再继续（保证调用方不必先 load）
    loadConfig(db, partnerId, opts.genId)
  }
  const base = currentRow(db, partnerId)!
  if (opts.expectedVersion != null && opts.expectedVersion !== base.version) {
    throw new Error(`配置版本冲突：期望 v${opts.expectedVersion}，当前已是 v${base.version}（他人已修改，请刷新后重试）`)
  }
  const prev = row2config(base.config_json)
  const diffs = makeDiffs(prev, config)
  if (diffs.length === 0) return { version: base.version, diffs: [] }

  const nextVersion = base.version + 1
  tx(db, () => {
    writeVersion(db, partnerId, nextVersion, config, opts.changedBy ?? null, opts.genId)
    insertChange(db, partnerId, nextVersion, 'edit', opts.tab ?? null, diffs, config, opts.changedBy ?? null, opts.genId)
  })
  return { version: nextVersion, diffs }
}

/** 取某历史版本的配置（不可变）。 */
export function getConfigVersion(db: DbLike, partnerId: string, version: number): PartnerConfig | null {
  const r = db.prepare(`SELECT config_json FROM partner_configs WHERE partner_id=? AND version=?`).get(partnerId, version) as any
  return r ? row2config(r.config_json) : null
}

/**
 * 回滚到某历史版本 → 以该版本内容生成【新版本】（is_current），不抹历史，记一条 rollback 变更。
 */
export function rollbackConfig(db: DbLike, partnerId: string, toVersion: number, opts: { changedBy?: string; genId: () => string }): { version: number } {
  const target = getConfigVersion(db, partnerId, toVersion)
  if (!target) throw new Error(`回滚失败：找不到版本 v${toVersion}`)
  const base = currentRow(db, partnerId)
  const baseConfig = base ? row2config(base.config_json) : seedDefaultConfig()
  const baseVersion = base ? base.version : 0
  const nextVersion = baseVersion + 1
  const diffs = makeDiffs(baseConfig, target)
  tx(db, () => {
    writeVersion(db, partnerId, nextVersion, target, opts.changedBy ?? null, opts.genId)
    insertChange(db, partnerId, nextVersion, 'rollback', `回滚到 v${toVersion}`, diffs, target, opts.changedBy ?? null, opts.genId)
  })
  return { version: nextVersion }
}

/** 设某版本为月度导入基线（同院唯一）。 */
export function setBaseline(db: DbLike, partnerId: string, version: number, _opts: { changedBy?: string } = {}): void {
  const exists = db.prepare(`SELECT 1 FROM partner_configs WHERE partner_id=? AND version=?`).get(partnerId, version)
  if (!exists) throw new Error(`设基线失败：找不到版本 v${version}`)
  tx(db, () => {
    db.prepare(`UPDATE partner_configs SET is_baseline=0 WHERE partner_id=?`).run(partnerId)
    db.prepare(`UPDATE partner_configs SET is_baseline=1 WHERE partner_id=? AND version=?`).run(partnerId, version)
  })
}

/** 变更记录（最新在前）。 */
export function getChanges(db: DbLike, partnerId: string): ChangeRow[] {
  const rows = db.prepare(
    `SELECT version, kind, tab, diffs_json, changed_at, changed_by FROM partner_config_changes WHERE partner_id=? ORDER BY version DESC, changed_at DESC`,
  ).all(partnerId) as any[]
  return rows.map((r) => ({
    version: r.version,
    kind: r.kind as ChangeKind,
    tab: r.tab ?? null,
    diffs: r.diffs_json ? JSON.parse(r.diffs_json) : [],
    changedAt: r.changed_at,
    changedBy: r.changed_by ?? null,
  }))
}
