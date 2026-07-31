const SHANGHAI_BUSINESS_TIME_ZONE = 'Asia/Shanghai'

const shanghaiYearMonthFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SHANGHAI_BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
})

/**
 * COREONE 的服务器端业务月份。调用方不得在时区能力异常时回退 UTC：
 * formatter 或结果形状异常会直接抛错，让业务写在进入数据库前 fail-closed。
 */
export function shanghaiBusinessMonth(now = new Date()): string {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError('invalid date for Shanghai business month')
  }

  const parts = shanghaiYearMonthFormatter.formatToParts(now)
  const year = parts.find(part => part.type === 'year')?.value
  const month = parts.find(part => part.type === 'month')?.value
  if (!year || !/^\d{4}$/.test(year) || !month || !/^(0[1-9]|1[0-2])$/.test(month)) {
    throw new RangeError('invalid Shanghai business month')
  }
  return `${year}-${month}`
}
