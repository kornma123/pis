import type { ReactNode } from 'react'
import type { Material, Location } from '@/types'
import type { LaneCStats } from '@/api/inventory'

// Lane C（退库/报废/调拨）三页共用的记录形状（字段按页略有不同，用可选覆盖）
export interface LaneCRecord {
  id: string
  materialId: string
  materialName?: string
  quantity: number
  unit?: string
  operator: string
  status?: string
  remark?: string
  createdAt: string
  // 退库/报废
  returnNo?: string
  scrapNo?: string
  reason?: string
  // 调拨
  inboundNo?: string
  batchNo?: string
  fromLocationId?: string
  fromLocationName?: string
  toLocationId?: string
  toLocationName?: string
}

export type SortField = 'createdAt' | 'quantity'
export type SortOrder = 'asc' | 'desc'

export interface LaneCColumn {
  key: string
  label: string
  align?: 'left' | 'right'
  sortable?: SortField
  render: (row: LaneCRecord, ctx: { materials: Material[] }) => ReactNode
}

export interface ReasonOption {
  value: string
  label: string
}

export interface ReturnSourceOption {
  allocationId: string
  outboundId: string
  outboundNo: string
  batchId: string
  batchNo: string
  quantity: number
  availableQuantity: number
  createdAt: string
}

// 库存影响标注（据实说清方向，呼应讨论循环确认的语义）
export interface StockEffect {
  text: string // 如 "库存 +数量"
  tone: 'up' | 'down' | 'neutral'
}

export interface LaneCConfig {
  module: 'returns' | 'scraps' | 'transfers'
  noun: string // "退库" / "报废" / "调拨"
  title: string
  subtitle: string
  createLabel: string // 登记按钮文案
  createTone: 'blue' | 'red'
  effect: StockEffect
  note: string // 据实语义说明条
  filterKind: 'reason' | 'location' // 筛选下拉类型
  reasons?: ReasonOption[] // filterKind='reason' 时的下拉选项（登记表单也用）
  reasonLabel?: (value?: string) => string // 展示用（含 legacy 兼容）
  createMode: 'reason' | 'transfer'
  needsLocations: boolean
  columns: LaneCColumn[]
  detailFields: (row: LaneCRecord, ctx: { materials: Material[] }) => { label: string; value: ReactNode }[]
  exportSheet: string
  exportFileName: string // 不含日期后缀
  exportRow: (row: LaneCRecord, ctx: { materials: Material[] }) => Record<string, unknown>
  api: {
    getList: (params: any) => Promise<any>
    getStats: () => Promise<any>
    getSources?: (materialId: string) => Promise<ReturnSourceOption[]>
    create: (form: LaneCForm) => Promise<any>
    remove: (id: string) => Promise<any>
  }
  validateCreate: (form: LaneCForm) => string | null
}

export interface LaneCForm {
  materialId: string
  quantity: number
  reason: string
  sourceAllocationId: string
  batchNo: string
  fromLocationId: string
  toLocationId: string
  remark: string
}

export const emptyForm: LaneCForm = {
  materialId: '', quantity: 1, reason: '', sourceAllocationId: '', batchNo: '', fromLocationId: '', toLocationId: '', remark: '',
}

export type { Material, Location, LaneCStats }
