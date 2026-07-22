import type { ImportEvidence } from './lisImportModel'

export function LisImportEvidence({ evidence }: { evidence: ImportEvidence }) {
  const { summary } = evidence
  const title = evidence.outcome === 'complete' ? '全部完成' : evidence.outcome === 'partial' ? '部分完成' : '处理结果未知'
  const tone = evidence.outcome === 'complete'
    ? 'border-green-200 bg-green-50 text-green-800'
    : evidence.outcome === 'partial'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-red-200 bg-red-50 text-red-800'
  return (
    <div role="status" aria-label={title} className={`mt-4 rounded-md border p-3 text-xs ${tone}`}>
      <div className="font-semibold">{title}</div>
      <p className="mt-1">{evidence.message}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>病例已确认写入 {summary.caseImported} 例（新增 {summary.caseInserted}、更新 {summary.caseUpdated}），成功回执 {summary.verifiedCaseChunks} 批。</li>
        {summary.caseSkipped > 0 && <li>{summary.caseSkipped} 例格式不完整，已跳过。</li>}
        {summary.rejectedCrossMonth > 0 && <li>{summary.rejectedCrossMonth} 例跨月冲突已拒收，原记录未覆盖。</li>}
        {summary.rejectedInvalidDate > 0 && <li>{summary.rejectedInvalidDate} 例登记日期非法已拒收。</li>}
        {summary.markerImported > 0 && <li>抗体已确认写入 {summary.markerImported} 行，涉及 {summary.markerCases} 例。</li>}
        {summary.markerUnmatched > 0 && <li>{summary.markerUnmatched} 行抗体未能唯一映射到医院病例，未当作成功。</li>}
        {summary.markerSkipped > 0 && <li>{summary.markerSkipped} 行抗体格式不完整，已跳过。</li>}
        {evidence.markerBlocked && <li>抗体清单未提交：病例存在拒收，需拆分并核对月份后再导。</li>}
      </ul>
    </div>
  )
}
