/**
 * 对账单解析层（配置驱动导入器 P1）—— 网格 → 规范化行 + 独立声明合计(declaredTotal) + 模板识别。
 *
 * 输入：前端 SheetJS `sheet_to_json {header:1}` 得到的 2D 网格（string[][]），POST 给后端。
 *   后端【不加 xlsx 依赖】，结构性解析在网格上跑（§8.1 决策）。
 *
 * 7 模板家族（康湾真实对账单实测）：
 *   line_item        逐项明细（和睦家/红睦房）：每行一条收费，病理号+项目名称+收费金额+结算扣率+结算金额。
 *   service_fee_mixed 服务费混合（温州中心/中西医）：编号+服务项目(自由文本)+医院收费+分配率+结算金额，含小计/合计。
 *   consult_remote   会诊远程（平泉/丰宁）：宽列(诊断方式/远程会诊结算/免组结算…)+结算合计。
 *   diagnostic_fee   诊断服务费（宁波/义乌）：宽列(基础诊断费用/免疫组化结算…)+合计结算金额。
 *   category_summary 类别汇总+明细子表（东安/养志/祁阳）：行=类别(常规病理/HPV/FISH)非逐 case。
 *   joint_venture    科室共建利润表（石门/成都东篱）：按科室 P&L，分成净额。
 *   outsourced_detail 外送明细（赣州）：无病理号，患者+送检项目+收费金额+结算金额。
 *
 * 口径（康湾锁定）：结算金额(实收) = 医院收费(开单/计费) × 扣率。**绝不把开单当结算**（红线）。
 *   ⚠️ 术语：本层「bill」= 医院收费/收费金额(折前 gross)；「settle」= 结算金额(折后实收 net)。
 *   注意 billing-revenue.ts 历史命名相反（开单金额=net）；以本层语义为准，按 settle=bill×rate 关系认列。
 *
 * declaredTotal = 对账单【独立声明的合计行】里的金额（非逐行求和），用于真对账闭合（抓漏读行）。
 */

export type StatementTemplate =
  | 'line_item'
  | 'service_fee_mixed'
  | 'consult_remote'
  | 'diagnostic_fee'
  | 'category_summary'
  | 'joint_venture'
  | 'outsourced_detail'
  | 'unknown'

export type Grid = (string | number | null | undefined)[][]

/** 列映射：逻辑字段 → 物理列下标（-1=未识别）。可由逐院 config.parse.colMap 覆盖。 */
export interface ColMap {
  caseNo: number
  item: number
  bill: number
  rate: number
  settle: number
  remark: number
  campus: number
  qty: number // 数量（split 制片拆分工作量降级用）
}

export interface ParsedRow {
  no: string // 病理号 / 编号（outsourced/category 可能为空）
  item: string // 项目名称 / 服务项目
  remark: string // 备注 / 住院号
  bill: number // 医院收费（折前 gross）；缺=NaN
  rate: number // 扣率；缺=NaN
  settle: number // 结算金额（折后实收）= bill×rate（缺则现算）
  campus: string
  qty?: number // 数量（scope=split 工作量降级来源；缺省按 1，与 golden 脚本 `parseFloat||1` 一致）
}

export interface ParseResult {
  template: StatementTemplate
  rows: ParsedRow[]
  declaredTotal: number | null // 独立声明结算合计（实收口径）
  declaredGross: number | null // 独立声明收费合计（折前）
  rowSettleSum: number // Σ逐行 settle（与 declaredTotal 比 = 对账闭合）
  headerRow: number
  colMap: ColMap
  warnings: string[]
}

// —— 工具 ——

const norm = (s: unknown): string =>
  (s == null ? '' : String(s)).normalize('NFKC').replace(/[\s\u3000]+/g, '').trim()

const cellStr = (v: unknown): string => (v == null ? '' : String(v)).trim()

/** 数值解析：容忍 ¥ 千分位 % 与全角；非数返回 NaN。 */
function toNum(v: unknown): number {
  if (v == null || v === '') return NaN
  const s = String(v).normalize('NFKC').replace(/[¥,\s%]/g, '')
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : NaN
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
const round4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000

/**
 * 扣率解析（%-aware）：'90%'→0.9 / '0.9'→0.9 / '90'→0.9（>1 视为百分数）/ 空→NaN。
 * ⚠️ 不能用 toNum：toNum 会把 '90%' 的 % 去掉得 90，导致 settle=开单×90 百倍虚高（codex F1）。
 */
function parseRate(v: unknown): number {
  if (v == null || v === '') return NaN
  const s = String(v).normalize('NFKC').trim()
  if (!/[0-9]/.test(s)) return NaN
  const n = parseFloat(s.replace(/[%\s]/g, ''))
  if (!Number.isFinite(n)) return NaN
  return s.includes('%') || n > 1 ? n / 100 : n // 扣率 ∈ 0–1；>1 必是未写 % 的百分数
}

/** 该行所有数值单元格（按列序）。 */
function numericCells(row: Grid[number]): number[] {
  const out: number[] = []
  for (const c of row) {
    const n = toNum(c)
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

function firstNonEmpty(row: Grid[number]): string {
  for (const c of row) {
    const s = cellStr(c)
    if (s) return s
  }
  return ''
}

/**
 * 合计/总计行（非小计）：第一非空单元【以】合计/总计/结算合计 开头。
 * 注：extractDeclaredTotal 从 headerRow+1 起扫，表头已被跳过，故无需再排除「结算合计/合计结算金额」
 * 这类表头词——否则真合计行恰好叫「结算合计」时 declaredTotal 会漏成 null（codex F8）。
 */
function isGrandTotalRow(row: Grid[number]): boolean {
  const f = norm(firstNonEmpty(row))
  if (/小计/.test(f)) return false
  return /^(合计|总计|总额|结算合计|合计结算金额|本月合计)/.test(f)
}

/** 噪声/标签行（小计、签名、说明等），不计为明细。 */
function isNoiseRow(row: Grid[number]): boolean {
  const f = norm(firstNonEmpty(row))
  if (!f) return true
  return /小计|合计|总计|复核|制表|医院确认|确认人|经办|备注[:：]|期间|货币单位|单位[:：]RMB|说明/.test(f)
}

// —— 模板识别 ——

export function detectTemplate(grid: Grid): StatementTemplate {
  const head = grid.slice(0, 8).map((r) => r.map(norm).join('|')).join('\n')
  // 共建利润表：科室级 P&L
  if (/科室/.test(head) && /(医院利润|医院应分得收入|医院收入总额|成本利润率)/.test(head)) return 'joint_venture'
  // 外送明细
  if (/外送/.test(head) || /送检项目名称/.test(head)) return 'outsourced_detail'
  // 类别汇总：项目名称 + (每月金额|合计结算金额|医院收款金额) 且无 病理号/编号 逐 case 列
  const hasCase = /病理号|^编号|\|编号/.test(head)
  if (/项目名称|科室/.test(head) && /(每月金额|合计结算金额|医院收款金额|结算金额\|合计)/.test(head) && !hasCase) return 'category_summary'
  // 诊断服务费
  if (/诊断服务费/.test(head)) return 'diagnostic_fee'
  // 会诊远程：诊断方式 + (远程|会诊) 宽列
  if (/(诊断方式|诊断↵方式)/.test(head) || (/会诊专家/.test(head) && /(远程比率|远程会诊|疑难病理会诊结算|冰冻结算)/.test(head))) return 'consult_remote'
  // 服务费混合：服务费结算 + 分配率/医院收费
  if (/服务费结算/.test(head) || (/分配率/.test(head) && /医院收费/.test(head))) return 'service_fee_mixed'
  // 逐项明细：病理号 + 结算扣率 + (收费金额|合约金额|结算金额)。按列特征识别，不依赖「结算清单」标题行
  // （前端可能传去标题的网格；且 consult/diagnostic 已在前面拦截，它们无「结算扣率」列）。
  if (/病理号/.test(head) && /结算扣率/.test(head) && /(收费金额|合约金额|结算金额)/.test(head)) return 'line_item'
  return 'unknown'
}

// —— 列映射自动识别 ——

/** 按表头文字匹配列；patterns 按优先级，命中第一个未占用列。 */
function pickCol(header: string[], used: Set<number>, patterns: RegExp[]): number {
  for (const re of patterns) {
    for (let i = 0; i < header.length; i++) {
      if (used.has(i)) continue
      if (re.test(header[i])) {
        used.add(i)
        return i
      }
    }
  }
  return -1
}

export function detectColMap(headerRowCells: Grid[number]): ColMap {
  const header = headerRowCells.map(norm)
  const used = new Set<number>()
  // settle 优先识别（合计结算金额/结算合计 优先于裸 结算金额）
  const settle = pickCol(header, used, [/^合计结算金额$|^合计↵?结算金额$/, /^结算合计$/, /^结算金额$/, /结算金额/])
  const caseNo = pickCol(header, used, [/^病理号$/, /^编号$/, /^病例号$/, /病理号/])
  const item = pickCol(header, used, [/^项目名称$/, /^服务项目$/, /^送检项目名称$/, /服务项目|项目名称/])
  const bill = pickCol(header, used, [/^收费金额$/, /^合约金额$/, /^医院收费$/, /^医院收款金额$/, /^每月金额$/, /收费金额|医院收费/])
  const rate = pickCol(header, used, [/^结算扣率$|^结算↵?扣率$/, /^分配率$/, /^基础费分配率$/, /^远程比率$|^远程↵?比率$/, /扣率|分配率|比率/])
  const remark = pickCol(header, used, [/^备注$/, /住院号|检验编号/])
  const campus = pickCol(header, used, [/院区/])
  const qty = pickCol(header, used, [/^数量$/, /数量/])
  return { caseNo, item, bill, rate, settle, remark, campus, qty }
}

// —— 通用解析（line_item / service_fee_mixed / consult_remote / diagnostic_fee / outsourced_detail）——

export interface ParseOpts {
  headerRow?: number
  colMap?: Partial<ColMap>
  template?: StatementTemplate
}

function resolveHeaderRow(grid: Grid, hint?: number): number {
  if (hint != null) return hint
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const joined = grid[i].map(norm).join('')
    const nonEmpty = grid[i].filter((c) => cellStr(c)).length
    if (nonEmpty >= 3 && /(病理号|项目名称|服务项目|送检项目名称|科室|编号)/.test(joined)) return i
  }
  return 0
}

/** 提取独立声明合计（grand total 行的金额；settle=最后一个数、gross=第一个数）。 */
function extractDeclaredTotal(grid: Grid, startRow: number): { declaredTotal: number | null; declaredGross: number | null } {
  let declaredTotal: number | null = null
  let declaredGross: number | null = null
  for (let i = startRow; i < grid.length; i++) {
    if (!isGrandTotalRow(grid[i])) continue
    const nums = numericCells(grid[i])
    if (nums.length === 0) continue
    declaredTotal = round2(nums[nums.length - 1]) // 实收合计 = 最后一个数
    declaredGross = round2(nums[0]) // 收费合计 = 第一个数
  }
  return { declaredTotal, declaredGross }
}

export function parseLineItems(grid: Grid, opts: ParseOpts = {}): ParseResult {
  const template = opts.template ?? detectTemplate(grid)
  const headerRow = resolveHeaderRow(grid, opts.headerRow)
  const auto = detectColMap(grid[headerRow] ?? [])
  const colMap: ColMap = { ...auto, ...(opts.colMap ?? {}) }
  const warnings: string[] = []

  const hasCaseCol = colMap.caseNo >= 0
  const rows: ParsedRow[] = []
  for (let i = headerRow + 1; i < grid.length; i++) {
    const row = grid[i]
    if (isNoiseRow(row)) continue
    const no = colMap.caseNo >= 0 ? cellStr(row[colMap.caseNo]) : ''
    const item = colMap.item >= 0 ? cellStr(row[colMap.item]) : ''
    const bill = colMap.bill >= 0 ? toNum(row[colMap.bill]) : NaN
    const rate = colMap.rate >= 0 ? parseRate(row[colMap.rate]) : NaN
    let settle = colMap.settle >= 0 ? toNum(row[colMap.settle]) : NaN

    // 明细闸：有 caseNo 的模板按 caseNo；无 caseNo（外送）按 项目+金额。
    const isDetail = hasCaseCol
      ? no !== ''
      : item !== '' && (Number.isFinite(bill) || Number.isFinite(settle))
    if (!isDetail) continue

    if (!Number.isFinite(settle)) {
      // 缺结算列 → 开单×扣率（§8.2），标注
      if (Number.isFinite(bill) && Number.isFinite(rate)) settle = round2(bill * rate)
      else settle = NaN
    }
    rows.push({
      no,
      item,
      remark: colMap.remark >= 0 ? cellStr(row[colMap.remark]) : '',
      bill: Number.isFinite(bill) ? round2(bill) : NaN,
      rate: Number.isFinite(rate) ? round4(rate) : NaN,
      settle: Number.isFinite(settle) ? round2(settle) : NaN,
      campus: colMap.campus >= 0 ? cellStr(row[colMap.campus]) : '',
      qty: (() => {
        const q = colMap.qty >= 0 ? toNum(row[colMap.qty]) : NaN
        return Number.isFinite(q) && q > 0 ? q : 1
      })(),
    })
  }

  const { declaredTotal, declaredGross } = extractDeclaredTotal(grid, headerRow + 1)
  const rowSettleSum = round2(rows.reduce((s, r) => s + (Number.isFinite(r.settle) ? r.settle : 0), 0))
  if (colMap.settle < 0) warnings.push('未识别结算金额列，逐行实收按 开单×扣率 估算')
  if (declaredTotal == null) warnings.push('未找到独立合计行，无法做对账闭合校验')
  // codex HIGH-1：宽表模板（远程会诊/诊断服务费）的业务语义在【列表头】（远程会诊结算/免组结算金额…），逐行项目名为空。
  //   这些行金额(结算合计)仍正确入账并参与对账闭合，但分类阶段会落「待人工归类」——这是诚实的保守处理：
  //   不按列自动展开归类，是为避免把「远程会诊(移出)」误按 会诊关键词判成「线下会诊(计入)」而虚增实验室收入。
  //   逐列语义→业务线 的自动映射属配置+解析协同的后续功能项，届时再做；当前在测试台按列含义人工归类。
  if ((template === 'consult_remote' || template === 'diagnostic_fee') && rows.some((r) => !r.item)) {
    warnings.push('宽表模板：项目语义在列表头、逐行项目名为空，相关行将进入「待人工归类」（金额已正确入账与对账，分类需在测试台按列含义确认，避免移出项被误计入）。')
  }
  return { template, rows, declaredTotal, declaredGross, rowSettleSum, headerRow, colMap, warnings }
}

// —— 专用：类别汇总（行=类别，非逐 case）——

export interface CategoryRow {
  category: string
  monthAmount: number // 每月金额 / 收费
  settle: number // 结算金额
  remark: string
}

export interface CategoryParseResult {
  template: 'category_summary'
  categories: CategoryRow[]
  declaredTotal: number | null
  rowSettleSum: number
  headerRow: number
  warnings: string[]
}

export function parseCategorySummary(grid: Grid, opts: { headerRow?: number } = {}): CategoryParseResult {
  const headerRow = resolveHeaderRow(grid, opts.headerRow)
  const header = (grid[headerRow] ?? []).map(norm)
  const idxItem = header.findIndex((h) => /项目名称|科室/.test(h))
  // 结算列：合计结算金额 优先，否则 结算金额
  let idxSettle = header.findIndex((h) => /^合计结算金额$|^合计↵?结算金额$/.test(h))
  if (idxSettle < 0) idxSettle = header.findIndex((h) => /^结算金额$/.test(h))
  const idxMonth = header.findIndex((h) => /每月金额|医院收款金额|每月收费/.test(h))
  const categories: CategoryRow[] = []
  for (let i = headerRow + 1; i < grid.length; i++) {
    const row = grid[i]
    if (isNoiseRow(row)) continue
    const category = idxItem >= 0 ? cellStr(row[idxItem]) : firstNonEmpty(row)
    if (!category) continue
    const settle = idxSettle >= 0 ? toNum(row[idxSettle]) : NaN
    const monthAmount = idxMonth >= 0 ? toNum(row[idxMonth]) : NaN
    if (!Number.isFinite(settle) && !Number.isFinite(monthAmount)) continue
    categories.push({
      category,
      monthAmount: Number.isFinite(monthAmount) ? round2(monthAmount) : NaN,
      settle: Number.isFinite(settle) ? round2(settle) : NaN,
      remark: '',
    })
  }
  const { declaredTotal } = extractDeclaredTotal(grid, headerRow + 1)
  const rowSettleSum = round2(categories.reduce((s, r) => s + (Number.isFinite(r.settle) ? r.settle : 0), 0))
  const warnings: string[] = []
  if (declaredTotal == null) warnings.push('未找到独立合计行')
  return { template: 'category_summary', categories, declaredTotal, rowSettleSum, headerRow, warnings }
}

// —— 专用：科室共建利润表（分成净额 OUT + 线下 H 会诊 IN 由 P2 分类）——

export interface JointVentureRow {
  dept: string
  hospitalRevenueTotal: number // 医院收入总额
  hospitalProfit: number // 医院利润
  numerics: number[] // 该行全部数值（供 P2 取分成净额/明细）
}

export interface JointVentureParseResult {
  template: 'joint_venture'
  depts: JointVentureRow[]
  headerRow: number
  warnings: string[]
}

export function parseJointVenture(grid: Grid, opts: { headerRow?: number } = {}): JointVentureParseResult {
  let headerRow = opts.headerRow ?? grid.findIndex((r) => r.map(norm).join('|').includes('科室') && /医院/.test(r.map(norm).join('|')))
  if (headerRow < 0) headerRow = 0
  const header = (grid[headerRow] ?? []).map(norm)
  const idxDept = header.findIndex((h) => /科室/.test(h))
  const idxRevTotal = header.findIndex((h) => /医院收入总额/.test(h))
  const idxProfit = header.findIndex((h) => /医院利润/.test(h))
  const depts: JointVentureRow[] = []
  for (let i = headerRow + 1; i < grid.length; i++) {
    const row = grid[i]
    const dept = idxDept >= 0 ? cellStr(row[idxDept]) : firstNonEmpty(row)
    if (!dept || isNoiseRow(row)) continue
    depts.push({
      dept,
      hospitalRevenueTotal: idxRevTotal >= 0 ? toNum(row[idxRevTotal]) : NaN,
      hospitalProfit: idxProfit >= 0 ? toNum(row[idxProfit]) : NaN,
      numerics: numericCells(row),
    })
  }
  const warnings: string[] = []
  if (depts.length === 0) warnings.push('未解析到科室行')
  return { template: 'joint_venture', depts, headerRow, warnings }
}

// —— 顶层分发 ——

export type AnyParseResult = ParseResult | CategoryParseResult | JointVentureParseResult

/** 按模板分发到对应解析器。caller 可传 template/colMap（来自逐院 config）覆盖自动识别。 */
export function parseStatement(grid: Grid, opts: ParseOpts = {}): AnyParseResult {
  const template = opts.template ?? detectTemplate(grid)
  if (template === 'category_summary') return parseCategorySummary(grid, { headerRow: opts.headerRow })
  if (template === 'joint_venture') return parseJointVenture(grid, { headerRow: opts.headerRow })
  return parseLineItems(grid, { ...opts, template })
}
