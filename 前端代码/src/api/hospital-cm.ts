import request from './request'
import type {
  ComparisonRow,
  PortfolioHealth,
  Readiness,
  TrendPoint,
  FullPortfolioHealth,
  CaliberRatification,
} from '@/types/hospital-cm'

// request 拦截器已解包 → 直接返回 data 层（success→data.data；successList→data）。

export const hospitalCmApi = {
  /** GET /hospital-pnl/ —— 第 2 层对照表（默认贡献降序·始终可读·影子）。successList → {list, caliberRatification} */
  comparison: (params?: { serviceMonth?: string }) =>
    request.get('/hospital-pnl', { params }) as unknown as Promise<{
      list: ComparisonRow[]
      total: number
      caliberRatification?: CaliberRatification
    }>,

  /** GET /hospital-pnl/health —— 第 1 层体检（趋势-only·校准态·始终可读·影子）。 */
  health: (params?: { serviceMonth?: string }) =>
    request.get('/hospital-pnl/health', { params }) as unknown as Promise<PortfolioHealth>,

  /** GET /hospital-pnl/readiness —— 就绪谓词清单（校准视图渲染·始终可读）。 */
  readiness: () =>
    request.get('/hospital-pnl/readiness') as unknown as Promise<Readiness>,

  /**
   * GET /hospital-pnl/full-health —— 第 1 层**完整体检态**（覆盖倍数绝对判断·**就绪后才 200**）。
   * ⚠️ 就绪谓词为假时后端返回 **403**（URL 后门焊到数据层·§六.6）→ 前端**只在 readiness.ready===true 时才调用**，
   *    正常流程下永不触发 403 toast；此端点的 403 是给「绕过前端直打 API」的兜底。
   */
  fullHealth: (params?: { serviceMonth?: string }) =>
    request.get('/hospital-pnl/full-health', { params }) as unknown as Promise<FullPortfolioHealth>,

  /** GET /hospital-pnl/trend?partnerId= —— 某院月度趋势（同账户历史·下钻用；对照表已内联 trendPoints）。 */
  trend: (partnerId: string) =>
    request.get('/hospital-pnl/trend', { params: { partnerId } }) as unknown as Promise<TrendPoint[]>,
}
