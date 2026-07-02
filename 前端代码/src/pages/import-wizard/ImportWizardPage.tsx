import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Lock, Loader2, AlertCircle, CheckCircle2, Database, ArrowRight, ArrowLeft, Info } from 'lucide-react'
import { statementImportApi, type Grid } from '@/api/statement-import'
import type { PreviewResult, CommitResult } from '@/types/statement-import'
import { UploadBar, ScoreCard, useHospitals, readGrid, btnCls, btnPri, yuan } from '@/pages/import-shared/ImportShared'

const STEPS = ['上传对账单', '预览核对', '入库'] as const

export default function ImportWizardPage() {
  const { hospitals, loading: hospLoading, error: hospError, reload: reloadHospitals } = useHospitals()
  const [partnerId, setPartnerId] = useState('')
  const [month, setMonth] = useState('')
  const [grid, setGrid] = useState<Grid | null>(null)
  const [fileName, setFileName] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [committed, setCommitted] = useState<CommitResult | null>(null)
  const [needConfirm, setNeedConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 预检：先 LIS 后对账单的顺序引导（该院无 LIS → 拆分只能按账单数量估，偏下限）
  const [lisCoverage, setLisCoverage] = useState<{ total: number; withBlocks: number; inPeriod: number | null } | null>(null)

  useEffect(() => {
    setLisCoverage(null)
    if (!partnerId) return
    let stale = false
    statementImportApi.lisCoverage(partnerId, month || undefined)
      .then((r) => { if (!stale) setLisCoverage(r) })
      .catch(() => { /* 预检失败不阻断导入，静默跳过 */ })
    return () => { stale = true }
  }, [partnerId, month])

  const step = committed ? 2 : preview ? 1 : 0

  const onFile = useCallback(async (f: File) => {
    if (!partnerId) { toast.error('请先选择医院'); return }
    if (!month) { toast.error('请先选择账期'); return }
    setBusy(true); setFileName(f.name); setError(''); setCommitted(null); setNeedConfirm(null)
    try {
      const g = await readGrid(f); setGrid(g)
      const r = await statementImportApi.preview({ partnerId, grid: g, serviceMonth: month })
      setPreview(r)
    } catch (e: any) { setError(e?.message || '解析/预览失败'); setPreview(null) }
    finally { setBusy(false) }
  }, [partnerId, month])

  const commit = useCallback(async (confirm: boolean) => {
    if (!partnerId || !grid || !month) return
    setBusy(true); setError('')
    try {
      const r = await statementImportApi.commit({ partnerId, grid, serviceMonth: month, confirm })
      setCommitted(r); setNeedConfirm(null)
      toast.success(`已入库 ${r.caseCount} 例 · 实验室收入 ${yuan(r.labRevenue)}`)
    } catch (e: any) {
      // codex CRITICAL：非 2xx 时拦截器 reject 原始 AxiosError，后端结构化错误在 e.response.data.error（与项目既有 idiom 一致）。
      //   原来只看 e.code/e.message（='ERR_BAD_REQUEST'/'…409'），永不命中 → 确认入库按钮不出现，月度入库走死。
      const be = e?.response?.data?.error
      if (be?.code === 'NEEDS_CONFIRM' || e?.response?.status === 409) {
        setNeedConfirm(be?.message || '对账单未完全识别或未对平，需确认后入库')
      } else setError(be?.message || e?.message || '入库失败')
    } finally { setBusy(false) }
  }, [partnerId, grid, month])

  const reset = () => { setPreview(null); setGrid(null); setFileName(''); setCommitted(null); setNeedConfirm(null); setError('') }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-1 flex items-center gap-2">
        <Database className="h-5 w-5 text-blue-500" />
        <h1 className="text-[18px] font-semibold text-gray-900">财务月度导入向导</h1>
        <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500"><Lock className="h-3 w-3" />仅财务 / 管理员</span>
      </div>
      <p className="mb-4 text-[13px] text-gray-500">三步把一家医院某账期的对账单入库：上传 → 预览核对 → 入库。入库后院级盈亏看板即刷新。</p>

      {/* 步骤条 */}
      <div className="mb-5 flex items-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[12px] font-medium ${i <= step ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-400'}`}>{i + 1}</span>
            <span className={`text-[13px] ${i <= step ? 'font-medium text-gray-900' : 'text-gray-400'}`}>{s}</span>
            {i < STEPS.length - 1 && <ArrowRight className="h-4 w-4 text-gray-300" />}
          </div>
        ))}
      </div>

      {error && <div className="mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}

      {/* Step 0：上传 */}
      {step === 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <UploadBar hospitals={hospitals} partnerId={partnerId} onPartner={setPartnerId} month={month} onMonth={setMonth} onFile={onFile} busy={busy} fileName={fileName} hospitalsLoading={hospLoading} hospitalsError={hospError} onReloadHospitals={reloadHospitals} />
          <p className="mt-3 text-[12px] text-gray-400">先选医院和账期，再上传该院该月的对账单（.xlsx）。</p>
          {/* 预检提示：顺序引导（先 LIS 后对账单），不阻断 */}
          {partnerId && lisCoverage && lisCoverage.total === 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 text-[12.5px] text-blue-800">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>该院还没有 LIS 病例数据：拆分类收费只能按账单数量估算（口径偏下限）。建议先让管理员导入该院 LIS 再导对账单——不导也能算，之后补导 LIS 并重新导入本对账单即可更新。</span>
            </div>
          )}
        </div>
      )}

      {/* Step 1：预览核对 */}
      {step === 1 && preview && (
        <div className="space-y-4">
          {preview.note ? (
            <div className="rounded-lg border border-gray-200 bg-white p-5 text-[13px] text-gray-600 shadow-sm">{preview.template} · {preview.note}（该模板暂不支持逐 case 入库）</div>
          ) : (
            <>
              <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
                <ScoreCard score={preview.score} revenue={preview.revenue} />
              </div>
              {preview.needsAttention.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-800">
                  有 {preview.needsAttention.length} 行未识别（{yuan(preview.revenue.unmatchedSettle + preview.revenue.ambiguousSettle)}）。建议先到「导入测试台」归类，或确认后照常入库（未识别金额不计入实验室收入）。
                </div>
              )}
              {needConfirm && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-900">
                  <div className="mb-2">{needConfirm}</div>
                  <button className={btnPri} onClick={() => commit(true)} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}确认入库（含未识别）</button>
                </div>
              )}
            </>
          )}
          <div className="flex items-center justify-between">
            <button className={btnCls} onClick={reset}><ArrowLeft className="h-4 w-4" />重选</button>
            {!preview.note && !needConfirm && (
              <button className={btnPri} onClick={() => commit(false)} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}入库</button>
            )}
          </div>
        </div>
      )}

      {/* Step 2：入库完成 */}
      {step === 2 && committed && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center shadow-sm">
          <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-emerald-500" />
          <div className="text-[15px] font-semibold text-gray-900">已入库 {committed.caseCount} 例</div>
          <div className="mt-1 text-[13px] text-gray-500">
            实验室收入 <b className="tabular-nums text-gray-900">{yuan(committed.labRevenue)}</b>
            <> · 诊断与报告 <span className="tabular-nums text-gray-700">{yuan(committed.diagnosisSettle)}</span></>
            <> · 外送转出 <span className="tabular-nums text-gray-700">{yuan(committed.outSettle)}</span></>
            {committed.unmatchedSettle > 0 && <> · 未识别 {yuan(committed.unmatchedSettle)}（未计入）</>}
            {committed.skippedNoCase > 0 && <> · 跳过无病理号 {committed.skippedNoCase} 行</>}</div>
          {committed.splitLisMissing > 0 && (
            <div className="mx-auto mt-3 max-w-md rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              本期 {committed.splitLisMissing}/{committed.splitLisExpected} 例组织制片缺 LIS 蜡块数，制片份额按账单数量估算（偏下限）；补导该院 LIS 后重新导入本对账单即可更新。
            </div>
          )}
          <div className="mt-4 flex items-center justify-center gap-2">
            <Link to="/hospital-pnl" className={btnPri}>去看院级盈亏看板<ArrowRight className="h-4 w-4" /></Link>
            <button className={btnCls} onClick={reset}>再导一张</button>
          </div>
        </div>
      )}
    </div>
  )
}
