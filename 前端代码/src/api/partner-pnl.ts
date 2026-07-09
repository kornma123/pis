import request from './request'
import type { PartnerPnl, CasePnl, PnlTrendPoint, CaliberRatification } from '@/types/partner-pnl'

// request 拦截器已解包 → 直接返回 data 层
export const partnerPnlApi = {
  /** GET /partner-pnl —— 院级 P&L 列表（负毛利置顶）。successList → {list, caliberRatification} */
  overview: (params?: { serviceMonth?: string; partnerId?: string }) =>
    request.get('/partner-pnl', { params }) as unknown as Promise<{ list: PartnerPnl[]; total: number; caliberRatification?: CaliberRatification }>,

  /** GET /partner-pnl/cases —— case 级毛利下钻 / CM 筛查。successList → {list} */
  cases: (params: { serviceMonth?: string; partnerId?: string; onlyFlagged?: boolean; page?: number; pageSize?: number }) =>
    request.get('/partner-pnl/cases', { params }) as unknown as Promise<{ list: CasePnl[]; total: number; page: number; pageSize: number }>,

  /** GET /partner-pnl/trend —— 某医院月度趋势（success → 裸数组） */
  trend: (partnerId: string) =>
    request.get('/partner-pnl/trend', { params: { partnerId } }) as unknown as Promise<PnlTrendPoint[]>,

  /** POST /partner-pnl/backfill-abc-partner —— 回填成本维度 */
  backfill: () => request.post('/partner-pnl/backfill-abc-partner') as unknown as Promise<{ updated: number }>,
}
