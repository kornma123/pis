/**
 * 生成业务编号
 * @param prefix 前缀，如 'IB', 'OB', 'TF', 'LOG'
 * @returns 格式: PREFIX-YYYYMMDD-TTTTTT-RRR
 */
let lastTimestamp = 0
let sequence = 0

export function generateNo(prefix: string): string {
  const now = Date.now()
  if (now === lastTimestamp) {
    sequence += 1
  } else {
    lastTimestamp = now
    sequence = 0
  }

  const date = new Date(now).toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = now.toString().slice(-6)
  const suffix = sequence.toString(36).toUpperCase().padStart(3, '0')
  return `${prefix}-${date}-${timestamp}-${suffix}`
}
