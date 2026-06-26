import request from './request'

export const abcApi = {
  // ===== 作业中心管理 =====
  getActivityCenters: () =>
    request.get('/abc/activity-centers'),

  getActivityCenter: (id: string) =>
    request.get(`/abc/activity-centers/${id}`),

  createActivityCenter: (data: any) =>
    request.post('/abc/activity-centers', data),

  updateActivityCenter: (id: string, data: any) =>
    request.put(`/abc/activity-centers/${id}`, data),

  deleteActivityCenter: (id: string) =>
    request.delete(`/abc/activity-centers/${id}`),

  // ===== 成本动因 =====
  getCostDrivers: () =>
    request.get('/abc/cost-drivers'),

  createCostDriver: (data: any) =>
    request.post('/abc/cost-drivers', data),

  // ===== 成本池 =====
  getCostPools: (params?: any) =>
    request.get('/abc/cost-pools', { params }),

  createCostPool: (data: any) =>
    request.post('/abc/cost-pools', data),

  syncCostPools: (yearMonth: string) =>
    request.post('/abc/cost-pools/sync', { yearMonth }),

  autoCollectCostPools: (yearMonth: string) =>
    request.post('/abc/cost-pools/auto-collect', { yearMonth }),

  recalculateCostPools: (yearMonth: string) =>
    request.post('/abc/cost-pools/recalculate', { yearMonth }),

  // ===== 成本期间 =====
  getPeriods: (params?: any) =>
    request.get('/abc/periods', { params }),

  createPeriod: (data: any) =>
    request.post('/abc/periods', data),

  startPeriodCollection: (id: string, data?: any) =>
    request.post(`/abc/periods/${id}/start-collection`, data || {}),

  closePeriod: (id: string, data?: any) =>
    request.post(`/abc/periods/${id}/close`, data || {}),

  // ===== 成本异常 =====
  getExceptions: (params?: any) =>
    request.get('/abc/exceptions', { params }),

  resolveException: (id: string, data?: any) =>
    request.post(`/abc/exceptions/${id}/resolve`, data || {}),

  ignoreException: (id: string, data?: any) =>
    request.post(`/abc/exceptions/${id}/ignore`, data || {}),

  retryException: (id: string) =>
    request.post(`/abc/exceptions/${id}/retry`, {}),

  // ===== 成本重算任务 =====
  getCostRuns: (params?: any) =>
    request.get('/abc/cost-runs', { params }),

  getCostRun: (id: string) =>
    request.get(`/abc/cost-runs/${id}`),

  createCostRun: (data: any) =>
    request.post('/abc/cost-runs', data),

  // ===== 关账后调整单 =====
  getAdjustments: (params?: any) =>
    request.get('/abc/adjustments', { params }),

  createAdjustment: (data: any) =>
    request.post('/abc/adjustments', data),

  approveAdjustment: (id: string, data?: any) =>
    request.post(`/abc/adjustments/${id}/approve`, data || {}),

  rejectAdjustment: (id: string, data?: any) =>
    request.post(`/abc/adjustments/${id}/reject`, data || {}),

  // ===== BOM 作业关联 =====
  getBomLinks: (bomId: string) =>
    request.get(`/abc/bom-links/${bomId}`),

  updateBomLinks: (bomId: string, links: any[]) =>
    request.put(`/abc/bom-links/${bomId}`, { links }),

  // ===== BOM 收费映射 =====
  getBomFeeMappingAudit: (params?: any) =>
    request.get('/abc/bom-fee-mappings/audit', { params }),

  runBomFeeMappingAudit: (data?: any) =>
    request.post('/abc/bom-fee-mappings/audit', data || {}),

  getBomFeeMappings: (bomId: string) =>
    request.get(`/abc/bom-fee-mappings/${bomId}`),

  updateBomFeeMappings: (bomId: string, mappings: any[]) =>
    request.put(`/abc/bom-fee-mappings/${bomId}`, { mappings }),

  previewBomFeeMapping: (bomId: string, data: any) =>
    request.post(`/abc/bom-fee-mappings/${bomId}/preview`, data),

  // ===== 收费标准 =====
  getFeeStandards: (params?: any) =>
    request.get('/abc/fee-standards', { params }),

  getFeeStandard: (id: string) =>
    request.get(`/abc/fee-standards/${id}`),

  // ===== 盈利性分析 =====
  getProfitability: (params?: any) =>
    request.get('/abc/profitability', { params }),

  // L5-3 切片成本下钻：按 BOM 聚合逐中心作业动因分解
  getBomActivityBreakdown: (params: { bomId: string; startDate?: string; endDate?: string; month?: string }) =>
    request.get('/abc/profitability/activity-breakdown', { params }),

	  // ===== 成本看板 =====
	  getDashboard: (month?: string) =>
	    request.get('/abc/dashboard', { params: { month } }),

	  getClosingReadiness: (yearMonth: string) =>
	    request.get('/abc/closing-readiness', { params: { yearMonth } }),

	  // ===== 收费对照 =====
  getFeeComparison: (params?: any) =>
    request.get('/abc/fee-comparison', { params }),

  // ===== 成本趋势 =====
  getSlideCostTrend: (params?: any) =>
    request.get('/abc/slide-cost-trend', { params }),

  // ===== 导出 =====
  exportData: (params: any) =>
    request.get('/abc/export', { params }),

  // ===== 批次追溯 =====
  getBatchTrace: (batchId: string) =>
    request.get(`/abc/batch-trace/${batchId}`),

  // ===== 预算管理 =====
  getBudgets: (params?: any) =>
    request.get('/abc/budgets', { params }),

  createBudget: (data: any) =>
    request.post('/abc/budgets', data),

  updateBudget: (id: string, data: any) =>
    request.put(`/abc/budgets/${id}`, data),

  // ===== 质量成本 =====
  getQualityCosts: (params?: any) =>
    request.get('/abc/quality-costs', { params }),

  createQualityCost: (data: any) =>
    request.post('/abc/quality-costs', data),

  updateQualityCost: (id: string, data: any) =>
    request.put(`/abc/quality-costs/${id}`, data),

  getQualityCostSummary: (yearMonth?: string) =>
    request.get('/abc/quality-costs/summary', { params: { yearMonth } }),

  // ===== 审计日志 =====
  getAuditLogs: (params?: any) =>
    request.get('/abc/audit-logs', { params }),

  // ===== 预警规则 =====
  getAlertRules: () =>
    request.get('/abc/alert-rules'),

  createAlertRule: (data: any) =>
    request.post('/abc/alert-rules', data),

  // ===== 差异分析 =====
  getVarianceAnalysis: (params?: any) =>
    request.get('/abc/variance-analysis', { params }),
}
