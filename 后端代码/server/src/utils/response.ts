import type { Response } from 'express'

export function success<T>(res: Response, data: T, message = '操作成功', statusCode = 200): void {
  res.status(statusCode).json({
    success: true,
    data,
    message,
  })
}

export function successList<T>(
  res: Response,
  list: T[],
  page: number,
  pageSize: number,
  total: number,
  extra?: Record<string, unknown>
): void {
  const normalizedPage = Math.max(1, page || 1)
  const totalPages = Math.ceil(total / pageSize)
  res.status(200).json({
    success: true,
    data: {
      list,
      page: normalizedPage,
      pageSize,
      total,
      totalPages,
      pagination: {
        page: normalizedPage,
        pageSize,
        total,
        totalPages,
      },
      ...extra,
    },
  })
}

export function error(
  res: Response,
  message: string,
  code = 'INTERNAL_ERROR',
  statusCode = 500,
  details?: unknown
): void {
  const isDev = process.env.NODE_ENV === 'development'
  const safeMessage = statusCode >= 500 && !isDev ? '服务器内部错误，请稍后重试' : message
  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message: safeMessage,
      ...(details && isDev ? { details } : {}),
    },
  })
}
