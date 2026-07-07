/**
 * LIS 病例导出 → 规范化（W3）。真实文件「病例导出文档…xls」(HTML 伪 .xls，前端 SheetJS 解析后 POST)。
 *
 * 原始事实层：每 case 的 6 个基础数量列 + 送检医院 + 样本判定字段，原样落 lis_cases（可重传覆盖）。
 * specimen_type 是【派生推断】：导入时 detectSpecimenType 自动判(source=auto)，人工可覆盖(source=manual 永远赢)。
 */

import { detectSpecimenType, type SpecimenType, type LisCaseQty } from './case-charge-mapping.js'
import { canonicalCaseNo } from './classifier.js' // 病理号落库归一（NFKC+trim），与消费侧 case_revenue / 期间键闸同一 canonical，否则全角号永不命中

export interface NormalizedLisCase {
  caseNo: string
  partnerName: string // 送检医院
  registrationType: string // 缴费方式/登记类型
  status: string // 病例状态
  operateTime: string // 登记时间
  // 6 基础数量列
  heSlideCount: number
  blockCount: number
  ihcCount: number
  specialStainCount: number
  eberCount: number
  pdl1Count: number
  // 样本判定字段（供 detectSpecimenType）
  specimenFields: { 送检部位: string; 大体描述: string; 亚专科: string }
  /** 自动判定的样本类型（导入即算；落库时若已有 manual 则不覆盖） */
  autoSpecimenType: SpecimenType
}

const FIELD: Record<string, string[]> = {
  caseNo: ['病理号', 'caseNo', 'case_no'],
  partnerName: ['送检医院', 'partnerName', 'hospital'],
  registrationType: ['缴费方式', '登记类型', 'registrationType'],
  status: ['病例状态', 'status'],
  operateTime: ['登记时间', '接收时间', 'operateTime', 'operate_time'],
  heSlide: ['HE切片数', 'heSlideCount'],
  block: ['蜡块数', 'blockCount'],
  ihc: ['免疫组化数', 'ihcCount'],
  special: ['特染数', 'specialStainCount'],
  eber: ['EBER数', 'eberCount'],
  pdl1: ['PD-L1数', 'PDL1数', 'pdl1Count'],
  site: ['送检部位', 'specimenSite'],
  gross: ['大体描述', 'grossDescription'],
  subspecialty: ['亚专科', 'subspecialty'],
}

function pick(row: Record<string, unknown>, key: string): unknown {
  for (const k of FIELD[key] || [key]) if (row[k] != null && row[k] !== '') return row[k]
  return undefined
}
function s(row: Record<string, unknown>, key: string): string {
  const v = pick(row, key)
  return v == null ? '' : String(v).trim()
}
function n(row: Record<string, unknown>, key: string): number {
  const v = pick(row, key)
  if (v == null) return 0
  // NFKC 先把全角数字(如 '３')归半角，否则被 [^\d.-] 剥光→静默归 0 丢计数。
  // 保留小数点再 parseFloat → 四舍五入为整数计数；避免 parseInt 把 '10.5' 误剥成 '105'(×10 放大)
  const x = parseFloat(String(v).normalize('NFKC').replace(/[^\d.-]/g, ''))
  return Number.isFinite(x) && x > 0 ? Math.round(x) : 0
}

/**
 * 日期归一：readGrid 用 raw:true → 日期列(登记时间)以 Excel 序列号返回(如 46198.7)。
 * 若原样 String() 存 operate_time，下游按月过滤 substr(operate_time,1,7) 永不等 'YYYY-MM'
 * → lis-coverage 本期覆盖 / 反向缺口 / 向导预检 对真实数据恒失效。此处把序列号转 YYYY-MM-DD。
 * 已是日期字符串('2026-06-25...'/'2026/06/25')则原样返回（下游 replace('/','-') 兼容斜杠）。
 */
function toDateish(v: unknown): string {
  if (v == null || v === '') return ''
  const raw = String(v).trim()
  const num = typeof v === 'number' ? v : (/^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN)
  if (Number.isFinite(num) && num >= 20000 && num <= 90000) { // 合理日期区间(约 1954–2146)，避开计数值/小整数
    const d = new Date(Math.round((num - 25569) * 86400000)) // 25569 = 1970-01-01 的 Excel 序列号
    const p = (x: number): string => String(x).padStart(2, '0')
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
  }
  return raw
}

/** 规范化一行 LIS 导出 → NormalizedLisCase（含自动样本类型判定） */
export function normalizeLisRow(row: Record<string, unknown>): NormalizedLisCase {
  const specimenFields = { 送检部位: s(row, 'site'), 大体描述: s(row, 'gross'), 亚专科: s(row, 'subspecialty') }
  return {
    // 病理号是账实核对/期间键闸的 join key：必须与 case_revenue(_lines) 侧（statement-import 落库前经 canonicalCaseNo）
    // 同一 NFKC 归一，否则含全角/兼容字符的号在 lis_cases 侧留原样、canonical 侧归半角 → 永不命中（假阴性漏算）。
    caseNo: canonicalCaseNo(s(row, 'caseNo')),
    partnerName: s(row, 'partnerName'),
    registrationType: s(row, 'registrationType'),
    status: s(row, 'status'),
    operateTime: toDateish(pick(row, 'operateTime')), // 账期锚=登记时间(FIELD.operateTime 首选)；Excel 序列号→YYYY-MM-DD
    heSlideCount: n(row, 'heSlide'),
    blockCount: n(row, 'block'),
    ihcCount: n(row, 'ihc'),
    specialStainCount: n(row, 'special'),
    eberCount: n(row, 'eber'),
    pdl1Count: n(row, 'pdl1'),
    specimenFields,
    autoSpecimenType: detectSpecimenType(specimenFields),
  }
}

/** 有效 case_no 行判定（导出可能夹杂空行/汇总行） */
export function isValidLisRow(c: NormalizedLisCase): boolean {
  return c.caseNo !== '' && c.partnerName !== ''
}

// —— 抗体清单表（0702免组类：每例每抗体一行；无送检医院列）——
export interface NormalizedMarker {
  caseNo: string
  markerName: string
  adviceType: string // Y000001/Y000003=真抗体 · Y000006=HE深切重切 · Y000007=白片
  waxNo: string
  sectionNo: string
}

const MARKER_FIELD: Record<string, string[]> = {
  caseNo: ['病理号', 'caseNo', 'case_no'],
  markerName: ['markerName', '抗体名', '抗体', '标志物名称'],
  adviceType: ['adviceType', '申请类型'],
  waxNo: ['waxNo', '蜡块号'],
  sectionNo: ['sectionNo', '切片号'],
}

/** 规范化一行抗体清单 → NormalizedMarker（按列识别，只取分析列；医生名/备注/时间戳等 PII 不取）。 */
export function normalizeMarkerRow(row: Record<string, unknown>): NormalizedMarker {
  const pickM = (key: string): string => {
    for (const k of MARKER_FIELD[key] || [key]) {
      const v = row[k]
      if (v != null && v !== '') return String(v).normalize('NFKC').trim()
    }
    return ''
  }
  // caseNo 走 canonicalCaseNo（pickM 已 NFKC，此处显式统一到与 lis_cases/case_revenue 同一 canonical，保证 buildCaseMarkers 的 case_no join 命中）。
  return { caseNo: canonicalCaseNo(pickM('caseNo')), markerName: pickM('markerName'), adviceType: pickM('adviceType'), waxNo: pickM('waxNo'), sectionNo: pickM('sectionNo') }
}

/** 有效抗体行：需病理号 + 抗体名。 */
export function isValidMarkerRow(m: NormalizedMarker): boolean {
  return m.caseNo !== '' && m.markerName !== ''
}

/** 按列识别是不是「抗体清单表」（不写死表名/表数量）：出现抗体名列 = 是。 */
export function looksLikeMarkerSheet(headerNames: string[]): boolean {
  const set = new Set(headerNames.map((h) => String(h ?? '').trim()))
  return MARKER_FIELD.markerName.some((k) => set.has(k))
}

/** NormalizedLisCase → mapCaseToCharges 的输入（含已解析 specimen_type） */
export function toLisCaseQty(c: NormalizedLisCase, specimenType: SpecimenType): LisCaseQty {
  return {
    heSlideCount: c.heSlideCount,
    blockCount: c.blockCount,
    ihcCount: c.ihcCount,
    specialStainCount: c.specialStainCount,
    eberCount: c.eberCount,
    pdl1Count: c.pdl1Count,
    specimenType,
  }
}
