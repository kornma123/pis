import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Lock, Loader2, AlertCircle, FlaskConical, Flag } from 'lucide-react'
import { statementImportApi, type Grid } from '@/api/statement-import'
import { partnerConfigApi } from '@/api/partner-config'
import type { PreviewResult } from '@/types/statement-import'
import type { PartnerConfigLine } from '@/types/partner-config'
import { UploadBar, ScoreCard, ByLineTable, AttentionItem, useHospitals, readGrid, btnCls } from '@/pages/import-shared/ImportShared'

export default function ImportConsolePage() {
  const { hospitals, loading: hospLoading, error: hospError, reload: reloadHospitals } = useHospitals()
  const [partnerId, setPartnerId] = useState('')
  const [month, setMonth] = useState('')
  const [grid, setGrid] = useState<Grid | null>(null)
  const [fileName, setFileName] = useState('')
  const [lines, setLines] = useState<PartnerConfigLine[]>([])
  const [configVersion, setConfigVersion] = useState(0)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 选医院 → 载入该院业务线（供内联归类下拉）
  useEffect(() => {
    if (!partnerId) { setLines([]); return }
    partnerConfigApi.get(partnerId).then((env) => { setLines(env.config.lines); setConfigVersion(env.version) }).catch(() => {})
    setPreview(null); setGrid(null); setFileName('')
  }, [partnerId])

  const runPreview = useCallback(async (g: Grid) => {
    if (!partnerId) { toast.error('请先选择医院'); return }
    setBusy(true); setError('')
    try {
      const r = await statementImportApi.preview({ partnerId, grid: g, serviceMonth: month || undefined })
      setPreview(r); setConfigVersion(r.configVersion)
    } catch (e: any) {
      setError(e?.message || '预览失败'); setPreview(null)
    } finally { setBusy(false) }
  }, [partnerId, month])

  const onFile = useCallback(async (f: File) => {
    setBusy(true); setFileName(f.name)
    try { const g = await readGrid(f); setGrid(g); await runPreview(g) }
    catch (e: any) { setError('读取文件失败：' + (e?.message || '')); setBusy(false) }
  }, [runPreview])

  // 内联归类：把某行按【所选规则类型】加为某业务线的识别词 → 写回该院配置 → 重新预览。
  // codex F2：支持 项目名/病理号前缀/备注 三类规则；带 expectedVersion 乐观锁，配置已被改到更新版时 409 → 提示重新预览。
  const classify = useCallback(async (lineKey: string, ruleType: 'keyword' | 'prefix' | 'remark', value: string) => {
    if (!partnerId || !lineKey || !grid || !value.trim()) return
    try {
      await statementImportApi.classifyRule({ partnerId, lineKey, ruleType, value, expectedVersion: configVersion })
      const env = await partnerConfigApi.get(partnerId); setLines(env.config.lines)
      toast.success('已写回该院配置，重新预览')
      await runPreview(grid)
    } catch (e: any) {
      if (e?.response?.data?.error?.code === 'CONFLICT' || e?.response?.status === 409) {
        toast.error('该院配置已被更新，请基于最新预览重试'); await runPreview(grid)
      } /* 其余拦截器已 toast */
    }
  }, [partnerId, grid, runPreview, configVersion])

  const setBaseline = useCallback(async () => {
    if (!partnerId || !configVersion) return
    try { await partnerConfigApi.baseline(partnerId, configVersion); toast.success(`已设 v${configVersion} 为月度导入基线`) }
    catch { /* 拦截器已 toast */ }
  }, [partnerId, configVersion])

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-1 flex items-center gap-2">
        <FlaskConical className="h-5 w-5 text-blue-500" />
        <h1 className="text-[18px] font-semibold text-gray-900">导入测试台</h1>
        <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500"><Lock className="h-3 w-3" />仅财务 / 管理员</span>
      </div>
      <p className="mb-4 text-[13px] text-gray-500">首次校准一家医院的对账单：上传样表 → 按该院配置解析分类 → 未匹配行当场归类（写回该院配置、立即生效）→ 核对无误后设为月度导入基线。之后每月照基线在「财务月度导入」入库。</p>

      <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <UploadBar hospitals={hospitals} partnerId={partnerId} onPartner={setPartnerId} month={month} onMonth={setMonth} onFile={onFile} busy={busy} fileName={fileName} hospitalsLoading={hospLoading} hospitalsError={hospError} onReloadHospitals={reloadHospitals} />
      </div>

      {busy && !preview ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />解析中…</div>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>
      ) : !preview ? (
        <div className="rounded-lg border border-dashed border-gray-200 py-16 text-center text-[13px] text-gray-400">{partnerId ? '上传对账单样表后，这里出解析与体检结果' : '先选择一家合作医院'}</div>
      ) : preview.note ? (
        <div className="rounded-lg border border-gray-200 bg-white p-5 text-[13px] text-gray-600 shadow-sm"><span className="font-medium">{preview.template}</span> · {preview.note}</div>
      ) : (
        <div className="space-y-4">
          {/* 体检卡 */}
          <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[14px] font-semibold text-gray-900">体检卡 <span className="text-[12px] font-normal text-gray-400">· 模板 {preview.template} · 配置 v{preview.configVersion}</span></h2>
              <button className={btnCls} onClick={setBaseline} disabled={preview.score.status === 'todo'} title={preview.score.status === 'todo' ? '有待处理项，先归类/核对' : '设为月度导入基线'}><Flag className="h-4 w-4" />设为导入基线</button>
            </div>
            <ScoreCard score={preview.score} revenue={preview.revenue} />
          </div>

          {/* 逐线拆分 + 待归类 */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <h3 className="mb-2 text-[13px] font-semibold text-gray-900">按业务线拆分</h3>
              <ByLineTable revenue={preview.revenue} />
            </div>

            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <h3 className="mb-2 text-[13px] font-semibold text-gray-900">待人工归类 <span className="text-[11.5px] font-normal text-gray-400">（{preview.needsAttention.length} 行）</span></h3>
              {preview.needsAttention.length === 0 ? (
                <div className="py-6 text-center text-[12.5px] text-emerald-600">全部已识别 ✓</div>
              ) : (
                <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1">
                  {preview.needsAttention.map((row, i) => <AttentionItem key={i} item={row.item} no={row.no} settle={row.settle} status={row.status} lines={lines} onClassify={classify} />)}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
