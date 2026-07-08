import request from './request'
import type {
  OverviewResp,
  WorkbenchResp,
  ComputeResp,
  SupplementResp,
  VerdictReason,
} from '@/types/account-reconcile'

// 账实核对 API —— 对齐后端 /api/v1/account-reconcile。request 已 unwrap {success,data}，直接拿 data。
export const accountReconcileApi = {
  // ① 复核总览：某月各院状态 + 看板
  overview: (serviceMonth: string) =>
    request.get('/account-reconcile/overview', { params: { serviceMonth } }) as unknown as Promise<OverviewResp>,

  // 计算某院某月账实核对（写）
  compute: (partnerId: string, serviceMonth: string) =>
    request.post('/account-reconcile/compute', { partnerId, serviceMonth }) as unknown as Promise<ComputeResp>,

  // ② 复核工作台：某院某月差异 + 未匹配
  workbench: (partnerId: string, serviceMonth: string) =>
    request.get('/account-reconcile/workbench', { params: { partnerId, serviceMonth } }) as unknown as Promise<WorkbenchResp>,

  // 认定一条差异
  verdict: (diffId: string, reason: VerdictReason, note?: string) =>
    request.post(`/account-reconcile/diffs/${diffId}/verdict`, { reason, note }) as unknown as Promise<{
      id: string
      verdict: VerdictReason
      followUp: string
      pendingCount: number
    }>,

  // 复核完成（前置=全认定）
  complete: (hospitalMonthId: string) =>
    request.post(`/account-reconcile/hospital-months/${hospitalMonthId}/complete`) as unknown as Promise<{
      id: string
      status: string
      confirmedLabRevenue: number
    }>,

  // 反向：复核完成 → 待复核（必填理由）
  reopen: (hospitalMonthId: string, reason: string) =>
    request.post(`/account-reconcile/hospital-months/${hospitalMonthId}/reopen`, { reason }) as unknown as Promise<{
      id: string
      status: string
    }>,

  // 关账（部分关账 + 挂起；前置=复核完成；定版）
  close: (serviceMonth: string, partnerIds: string[]) =>
    request.post('/account-reconcile/close', { serviceMonth, partnerIds }) as unknown as Promise<{
      serviceMonth: string
      closed: string[]
      skipped: { partnerId: string; reason: string }[]
    }>,

  // 反关账（已关账 → 复核完成，必填理由）
  reopenClose: (hospitalMonthId: string, reason: string) =>
    request.post(`/account-reconcile/hospital-months/${hospitalMonthId}/reopen-close`, { reason }) as unknown as Promise<{
      id: string
      status: string
    }>,

  // ③ 补收追踪
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
