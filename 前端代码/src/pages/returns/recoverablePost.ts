import request, { genIdempotencyKey } from '@/api/request'

export class UnverifiedMutationReceiptError extends Error {
  constructor() {
    super('写入请求返回了无法验证的回执')
    this.name = 'UnverifiedMutationReceiptError'
  }
}

/**
 * 同一份表单在回执丢失后重试时复用幂等键；用户修改表单则生成新键。
 * 只在内存保存业务请求的稳定指纹，不写 localStorage、日志或 URL。
 */
export function createRecoverablePost<TInput, TBody extends Record<string, unknown>, TResult>(
  path: string,
  toBody: (input: TInput) => TBody,
  isVerified?: (result: TResult) => boolean,
) {
  let pending: { fingerprint: string; key: string } | null = null

  return async (input: TInput): Promise<TResult> => {
    const body = toBody(input)
    const fingerprint = JSON.stringify(body)
    if (!pending || pending.fingerprint !== fingerprint) {
      pending = { fingerprint, key: genIdempotencyKey() }
    }
    const key = pending.key
    try {
      const result = await request.post<TResult>(path, body, { headers: { 'Idempotency-Key': key } })
      if (isVerified && !isVerified(result)) throw new UnverifiedMutationReceiptError()
      if (pending?.key === key) pending = null
      return result
    } catch (error) {
      // 回执未知时保留 key；相同内容重试由后端回放首次结果。
      throw error
    }
  }
}
