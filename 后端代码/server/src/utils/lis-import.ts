/**
 * LIS 病例导出 → 规范化（W3）。真实文件「病例导出文档…xls」(HTML 伪 .xls，前端 SheetJS 解析后 POST)。
 *
 * 原始事实层：每 case 的 6 个基础数量列 + 送检医院 + 样本判定字段，原样落 lis_cases（可重传覆盖）。
 * specimen_type 是【派生推断】：导入时 detectSpecimenType 自动判(source=auto)，人工可覆盖(source=manual 永远赢)。
 */

import { detectSpecimenType, type SpecimenType, type LisCaseQty } from './case-charge-mapping.js'

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
  const x = parseInt(String(v).replace(/[^\d-]/g, ''), 10)
  return Number.isFinite(x) && x > 0 ? x : 0
}

/** 规范化一行 LIS 导出 → NormalizedLisCase（含自动样本类型判定） */
export function normalizeLisRow(row: Record<string, unknown>): NormalizedLisCase {
  const specimenFields = { 送检部位: s(row, 'site'), 大体描述: s(row, 'gross'), 亚专科: s(row, 'subspecialty') }
  return {
    caseNo: s(row, 'caseNo'),
    partnerName: s(row, 'partnerName'),
    registrationType: s(row, 'registrationType'),
    status: s(row, 'status'),
    operateTime: s(row, 'operateTime'),
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
