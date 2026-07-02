import request from './request'
import type { PreviewResult, CommitResult } from '@/types/statement-import'

export type Grid = (string | number | null)[][]

// request 拦截器已解包 → 直接返回 data 层
export const statementImportApi = {
  /** POST /statement-import/preview —— 干跑（解析+分类+评分，不落库） */
  preview: (body: { partnerId: string; grid: Grid; serviceMonth?: string; template?: string; goldenExpected?: number }) =>
    request.post('/statement-import/preview', body) as unknown as Promise<PreviewResult>,

  /** POST /statement-import/commit —— 落库（未匹配/不平需 confirm:true） */
  commit: (body: { partnerId: string; grid: Grid; serviceMonth: string; template?: string; docNo?: string; confirm?: boolean }) =>
    request.post('/statement-import/commit', body) as unknown as Promise<CommitResult>,

  /** POST /statement-import/classify-rule —— 把某行归类写回该院配置（立即生效；expectedVersion 乐观锁防并发覆盖） */
  classifyRule: (body: { partnerId: string; lineKey?: string; newLine?: { name: string; scope: 'in' | 'out' }; ruleType: 'prefix' | 'keyword' | 'remark'; value: string; expectedVersion?: number }) =>
    request.post('/statement-import/classify-rule', body) as unknown as Promise<{ partnerId: string; version: number; lineKey: string; scope: 'in' | 'out' }>,

  /** GET /statement-import/lis-coverage —— 导入预检：该院 LIS 覆盖（total=0 → 提示先导 LIS，拆分才有真蜡块） */
  lisCoverage: (partnerId: string, month?: string) =>
    request.get('/statement-import/lis-coverage', { params: { partnerId, month } }) as unknown as Promise<{ total: number; withBlocks: number; inPeriod: number | null }>,
}
