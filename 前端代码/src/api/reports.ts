import request from './request'

export const reportsApi = {
  getCostByProject: (params?: { startDate?: string; endDate?: string }) =>
    request.get('/reports/cost-by-project', { params }),

  getCostByMaterial: (params?: { startDate?: string; endDate?: string }) =>
    request.get('/reports/cost-by-material', { params }),

  getCostBySupplier: (params?: { startDate?: string; endDate?: string }) =>
    request.get('/reports/cost-by-supplier', { params }),

  getCostTrend: (params?: { startDate?: string; endDate?: string; dimension?: 'monthly' | 'quarterly'; projectType?: string }) =>
    request.get('/reports/cost-trend', { params }),
}
