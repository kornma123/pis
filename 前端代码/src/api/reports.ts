import request from './request'

export const reportsApi = {
  getCostByProject: (params?: { startDate?: string; endDate?: string }) =>
    request.get('/reports/cost-by-project', { params }),

  getCostByProjectGroup: (params?: { startDate?: string; endDate?: string }) =>
    request.get('/reports/cost-by-project-group', { params }),

  getCostByMaterial: (params?: { startDate?: string; endDate?: string }) =>
    request.get('/reports/cost-by-material', { params }),

  getCostBySupplier: (params?: { startDate?: string; endDate?: string }) =>
    request.get('/reports/cost-by-supplier', { params }),

  getCostTrend: (params?: { startDate?: string; endDate?: string; dimension?: 'monthly' | 'quarterly'; projectType?: string }) =>
    request.get('/reports/cost-trend', { params }),

  getFullCostByProject: (params?: { startDate?: string; endDate?: string }) =>
    request.get('/reports/full-cost-by-project', { params }),

  getCostStructure: (params?: { startDate?: string; endDate?: string }) =>
    request.get('/reports/cost-structure', { params }),

  getCostVariance: (params?: { startDate?: string; endDate?: string; compareType?: string }) =>
    request.get('/reports/cost-variance', { params }),

  getCostMonthlyComparison: (params?: { month?: string; source?: 'outbound' | 'abc' }) =>
    request.get('/reports/cost-monthly-comparison', { params }),

  getPersonnelEfficiency: (params?: { timeRange?: string; role?: string; startDate?: string; endDate?: string }) =>
    request.get('/reports/personnel-efficiency', { params }),
}
