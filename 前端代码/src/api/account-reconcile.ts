import request from './request'
import type {
  BoardResp,
  WorkbenchResp,
  ComputeResp,
  SupplementResp,
  ReconcileBinding,
  VerdictReason,
  FollowUp,
} from '@/types/account-reconcile'

// 账实核对 API —— 对齐后端 /api/v1/account-reconcile（LOC-005 权威代次合同）。
// request 已 unwrap {success,data}，直接拿 data。所有读/写必须携带四元组 binding；
// binding 由 GET /board（月份级代次发现）取得，前端不凭空构造 statementGenerationId。
export const accountReconcileApi = {
  // 月份级代次发现 + 看板：每院的 statement/reconcile generation、院·月状态与汇总。
  // （复核总览端点即代次发现入口——前端唯一取得四元组 binding 的地方）
  board: (settlementMonth: string) =>
    request.get('/account-reconcile/overview', { params: { settlementMonth } }) as unknown as Promise<BoardResp>,

  // 计算某院某月账实核对（写）。reconcileGenerationId 由调用方决定：
  // 同 statement 代沿用当前对账代（幂等重放），statement 代已变或首算时铸新 uuid（supersede）。
  compute: (binding: ReconcileBinding) =>
    request.post('/account-reconcile/compute', binding) as unknown as Promise<ComputeResp>,

  // 复核工作台：snapshot + 当前代差异（含认定态）+ 逐抗体线索。
  workbench: (binding: ReconcileBinding) =>
    request.get('/account-reconcile/workbench', { params: { ...binding } }) as unknown as Promise<WorkbenchResp>,

  // 认定一条差异（必须当前代差异；旧代差异 STALE_RECONCILIATION_DIFF）。
  verdict: (diffId: string, binding: ReconcileBinding, reason: VerdictReason, note?: string) =>
    request.post(`/account-reconcile/diffs/${diffId}/verdict`, { ...binding, reason, note }) as unknown as Promise<{
      id: string
      verdict: VerdictReason
      followUp: FollowUp
      pendingCount: number
      duplicate: boolean
    }>,

  // 复核完成（前置=全认定；body 必须且只能四元组 binding）
  complete: (hospitalMonthId: string, binding: ReconcileBinding) =>
    request.post(`/account-reconcile/hospital-months/${hospitalMonthId}/complete`, binding) as unknown as Promise<ReconcileBinding & {
      hospitalMonthId: string
      status: 'complete'
      confirmedLabRevenue: number
    }>,

  // 关账（定版；每次只关一家，多家由调用方循环聚合）
  close: (binding: ReconcileBinding) =>
    request.post('/account-reconcile/close', { items: [binding] }) as unknown as Promise<{
      closed: Array<ReconcileBinding & { hospitalMonthId: string; status: 'closed' }>
    }>,

  // 补收追踪
  supplements: (serviceMonth: string, status?: string) =>
    request.get('/account-reconcile/supplements', { params: { serviceMonth, status } }) as unknown as Promise<SupplementResp>,

  // 独立签发（SoD 人闸）：唯一把补收单 pending_review → approved 的入口，签发后方可收款。
  // 认定人（submittedBy）不能签发自己提交的单——由后端强制（403 SELF_REVIEW_FORBIDDEN），前端仅提示。
  approve: (supplementId: string, reason?: string) =>
    request.post(`/account-reconcile/supplements/${supplementId}/approve`, { reason }) as unknown as Promise<{
      id: string
      reviewStatus: string
      reviewedBy: string
    }>,

  collect: (supplementId: string, collectedMonth?: string) =>
    request.post(`/account-reconcile/supplements/${supplementId}/collect`, { collectedMonth }) as unknown as Promise<{
      id: string
      status: string
      collectedMonth: string
    }>,

  giveup: (supplementId: string, reason: string) =>
    request.post(`/account-reconcile/supplements/${supplementId}/giveup`, { reason }) as unknown as Promise<{ id: string; status: string }>,

  reopenSupplement: (supplementId: string, reason: string) =>
    request.post(`/account-reconcile/supplements/${supplementId}/reopen`, { reason }) as unknown as Promise<{ id: string; status: string }>,
}
