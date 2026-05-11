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
  const totalPages = Math.ceil(total / pageSize)
  res.status(200).json({
    success: true,
    data: {
      list,
      pagination: {
        page,
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
  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  })
}
