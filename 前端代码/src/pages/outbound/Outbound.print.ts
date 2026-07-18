import type { OutboundRecord } from '@/types'

const PRINT_STYLES = `
  body { font-family: sans-serif; padding: 40px; }
  h2 { text-align: center; margin-bottom: 8px; }
  .meta { text-align: center; color: #666; font-size: 12px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
  th { background: #f5f5f5; }
  .footer { margin-top: 24px; font-size: 12px; color: #999; text-align: center; }
`

type PrintableValue = string | number | null | undefined

function displayText(value: PrintableValue, fallback: string) {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

function createTextElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tagName: K,
  value: PrintableValue,
  fallback = '',
) {
  const element = doc.createElement(tagName)
  element.textContent = displayText(value, fallback)
  return element
}

function appendCell(doc: Document, row: HTMLTableRowElement, value: PrintableValue, fallback = '-') {
  row.append(createTextElement(doc, 'td', value, fallback))
}

function formatCreatedAt(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString()
}

function populatePrintDocument(doc: Document, record: OutboundRecord) {
  doc.documentElement.lang = 'zh-CN'

  const charset = doc.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  const title = createTextElement(doc, 'title', `出库单 ${displayText(record.outboundNo, '-')}`)
  const style = doc.createElement('style')
  style.textContent = PRINT_STYLES
  doc.head.replaceChildren(charset, title, style)

  const heading = createTextElement(doc, 'h2', '出库单')
  const meta = createTextElement(
    doc,
    'div',
    `单号：${displayText(record.outboundNo, '-')} | 项目：${displayText(record.projectName, '-')} | 时间：${formatCreatedAt(record.createdAt)}`,
  )
  meta.className = 'meta'

  const table = doc.createElement('table')
  const tableHead = doc.createElement('thead')
  const headerRow = doc.createElement('tr')
  for (const label of ['物料', '批号', '数量', '单价', '金额']) {
    headerRow.append(createTextElement(doc, 'th', label))
  }
  tableHead.append(headerRow)

  const tableBody = doc.createElement('tbody')
  for (const item of record.items ?? []) {
    const row = doc.createElement('tr')
    const quantity = displayText(item.quantity, '-')
    const unit = displayText(item.unit, '')
    appendCell(doc, row, item.materialName)
    appendCell(doc, row, item.batchNo)
    appendCell(doc, row, unit ? `${quantity} ${unit}` : quantity)
    appendCell(doc, row, item.unitCost, '0')
    appendCell(doc, row, item.totalCost, '0')
    tableBody.append(row)
  }
  table.append(tableHead, tableBody)

  const detailFooter = createTextElement(
    doc,
    'div',
    `操作人：${displayText(record.operator, '-')} | 备注：${displayText(record.remark, '无')}`,
  )
  detailFooter.className = 'footer'
  const systemFooter = createTextElement(doc, 'div', '本单据由 COREONE 系统自动生成')
  systemFooter.className = 'footer'

  doc.body.replaceChildren(heading, meta, table, detailFooter, systemFooter)
}

export function printOutboundRecord(record: OutboundRecord) {
  const printWindow = window.open('', '_blank')
  if (!printWindow) return false

  // Chromium returns null for noopener windows, so isolate the blank handle synchronously
  // before any untrusted business value is attached to its document.
  printWindow.opener = null
  populatePrintDocument(printWindow.document, record)
  printWindow.focus()
  printWindow.print()
  return true
}
