import { z } from 'zod'
import request from './request'

const nullableString = z.string().nullable()

export const stocktakingRecordSchema = z.object({
  id: z.string(),
  stocktakingNo: z.string(),
  sheetNo: nullableString.optional(),
  materialId: z.string(),
  materialCode: z.string(),
  materialName: z.string(),
  unit: z.string(),
  positionId: nullableString,
  batchId: nullableString,
  batchNo: nullableString,
  locationId: nullableString,
  locationName: nullableString,
  resolutionState: z.string(),
  snapshotVersion: z.number().nullable(),
  currentPositionVersion: z.number().nullable(),
  systemStock: z.number(),
  actualStock: z.number(),
  difference: z.number(),
  currentStock: z.number().nullable(),
  operator: z.string(),
  status: z.string(),
  reason: nullableString,
  remark: nullableString,
  adjustmentEventId: nullableString,
  latestEventId: nullableString,
  cancelledAt: nullableString.optional(),
  cancelledBy: nullableString.optional(),
  createdAt: z.string(),
  updatedAt: z.string().nullable().optional(),
})

export const stocktakingEventSchema = z.object({
  id: z.string(),
  eventKind: z.enum(['adjustment', 'compensation']),
  parentEventId: nullableString,
  rootEventId: z.string(),
  chainDepth: z.number(),
  quantityDelta: z.number(),
  inventoryBefore: z.number(),
  inventoryAfter: z.number(),
  operator: z.string(),
  reason: z.string(),
  createdAt: z.string(),
})

export const stocktakingExplanationSchema = z.object({
  id: z.string(),
  adjustmentEventId: z.string(),
  sequence: z.number(),
  explanation: z.string(),
  operator: z.string(),
  createdAt: z.string(),
})

export const stocktakingDetailSchema = stocktakingRecordSchema.extend({
  events: z.array(stocktakingEventSchema),
  explanations: z.array(stocktakingExplanationSchema),
})

export type StocktakingRecord = z.infer<typeof stocktakingRecordSchema>
export type StocktakingDetail = z.infer<typeof stocktakingDetailSchema>
export type StocktakingEvent = z.infer<typeof stocktakingEventSchema>
export type StocktakingExplanation = z.infer<typeof stocktakingExplanationSchema>

export interface StocktakingListParams {
  page: number
  pageSize: number
  keyword?: string
  status?: string
}

export interface StocktakingStats {
  todayCount: number
  pendingCount: number
  adjustedCount: number
  unresolvedCount: number
}

export interface CreateStocktakingInput {
  materialId: string
  positionId: string
  batchId: string | null
  locationId: string
  expectedPositionVersion: number
  expectedSystemStock: number
  actualStock: number
  remark?: string
}

export interface CreateStocktakingResult {
  id: string
  status: string
  materialId: string
  positionId: string
  batchId: string | null
  locationId: string
  snapshotVersion: number
}

const paginationSchema = z.object({
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  totalPages: z.number(),
})

const listSchema = z.object({
  list: z.array(stocktakingRecordSchema),
  pagination: paginationSchema,
})

const statsSchema = z.object({
  todayCount: z.number(),
  pendingCount: z.number(),
  adjustedCount: z.number(),
  unresolvedCount: z.number(),
})

export const stocktakingApi = {
  async getList(params: StocktakingListParams) {
    return listSchema.parse(await request.get('/stocktaking', { params }))
  },
  async getStats() {
    return statsSchema.parse(await request.get('/stocktaking/stats'))
  },
  async getDetail(id: string) {
    return stocktakingDetailSchema.parse(await request.get(`/stocktaking/${id}`))
  },
  create(data: CreateStocktakingInput) {
    return request.post<CreateStocktakingResult>('/stocktaking', data)
  },
  adjust(id: string, reason: string) {
    return request.post<{ id: string; eventId: string; status: string }>(`/stocktaking/${id}/adjust`, { reason })
  },
  appendExplanation(id: string, explanation: string) {
    return request.post<{ id: string }>(`/stocktaking/${id}/explanations`, { explanation })
  },
  reverse(id: string, eventId: string, reason: string) {
    return request.post<{ id: string; eventId: string; parentEventId: string; status: string }>(
      `/stocktaking/${id}/reverse`,
      { eventId, reason },
    )
  },
}

export function apiErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const value = error as { response?: { data?: { error?: { code?: unknown } } } }
  const code = value.response?.data?.error?.code
  return typeof code === 'string' ? code : null
}
