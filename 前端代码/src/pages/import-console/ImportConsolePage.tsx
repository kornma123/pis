import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Lock, Loader2, AlertCircle, FlaskConical, Flag, ArrowRight } from 'lucide-react'
import { statementImportApi, type Grid } from '@/api/statement-import'
import { partnerConfigApi } from '@/api/partner-config'
import type { PreviewResult, LineScope } from '@/types/statement-import'
import type { PartnerConfigLine } from '@/types/partner-config'
import { UploadBar, ScoreCard, useHospitals, readGrid, btnCls, btnPri, inputCls, yuan } from '@/pages/import-shared/ImportShared'

// 归类中文短标签（与配置页口径一致）：计入实验室 / 拆分制片 / 诊断报告 / 外送转出
const SCOPE_TAG: Record<LineScope, { t: string; c: string }> = {
  in: { t: '计入实验室', c: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  split: { t: '拆分·制片计入', c: 'text-blue-700 bg-blue-50 border-blue-200' },
  diagnosis: { t: '诊断与报告', c: 'text-gray-600 bg-gray-50 border-gray-200' },
  out: { t: '外送转出', c: 'text-gray-600 bg-gray-50 border-gray-200' },
}
function ScopeTag({ scope }: { scope: LineScope }) {
  const s = SCOPE_TAG[scope] ?? SCOPE_TAG.out
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${s.c}`}>{s.t}</span>
}

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
      <p className="mb-4 text-[13px] text-gray-500">上传一张对账单样表，按该院配置规则解析+分类，给出体检卡；未匹配的行可当场归类（写回该院配置、立即生效）；核对无误后设为月度导入基线。</p>

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

          {/* 逐线拆分 */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <h3 className="mb-2 text-[13px] font-semibold text-gray-900">按业务线拆分</h3>
              <table className="w-full text-[12.5px] tabular-nums">
                <thead><tr className="text-left text-[11.5px] text-gray-400"><th className="py-1">业务线</th><th>归类</th><th className="text-right">笔数</th><th className="text-right">结算额</th><th className="text-right">计入实验室</th></tr></thead>
                <tbody>
                  {preview.revenue.byLine.map((l) => {
                    const labPart = l.scope === 'in' ? l.settle : l.scope === 'split' ? (l.labShare ?? 0) : 0
                    return (
                      <tr key={l.key} className="border-t border-gray-100 align-top"><td className="py-1.5 text-gray-800">{l.name}</td>
                        <td><ScopeTag scope={l.scope} /></td>
                        <td className="text-right text-gray-600">{l.count}</td><td className="text-right text-gray-900">{yuan(l.settle)}</td>
                        <td className="text-right">{l.scope === 'in' || l.scope === 'split' ? <span className="text-blue-600">{yuan(labPart)}</span> : <span className="text-gray-300">—</span>}
                          {l.scope === 'split' && <div className="text-[10px] text-gray-400">诊断桶 {yuan(l.diagShare ?? 0)}</div>}</td></tr>
                    )
                  })}
                  <tr className="border-t border-gray-200 font-medium"><td className="py-1.5">实验室收入合计</td><td></td><td></td><td></td><td className="text-right text-blue-600">{yuan(preview.revenue.labRevenue)}</td></tr>
                </tbody>
              </table>
            </div>

            {/* 待归类 */}
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

function AttentionItem({ item, no, settle, status, lines, onClassify }: {
  item: string; no: string; settle: number; status: string; lines: PartnerConfigLine[]
  onClassify: (lineKey: string, ruleType: 'keyword' | 'prefix' | 'remark', value: string) => void
}) {
  const [lk, setLk] = useState('')
  const prefixGuess = (no.match(/^[^\d]+/)?.[0] || '').trim() // 病理号前导非数字段（如 H/冰/M）
  const [ruleType, setRuleType] = useState<'keyword' | 'prefix' | 'remark'>(item ? 'keyword' : 'prefix')
  const [value, setValue] = useState(item || prefixGuess)
  // 行变化（重新预览后顺序/内容变）时重置默认识别词，避免陈旧值
  useEffect(() => { setRuleType(item ? 'keyword' : 'prefix'); setValue(item || prefixGuess); setLk('') }, [item, no]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50/50 p-2.5">
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-medium text-gray-800">{item || '（无项目名）'}</div>
        <div className="text-[11px] text-gray-500">{no || '无病理号'} · {status === 'ambiguous' ? '歧义' : '未匹配'} · {yuan(settle)}</div>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[7rem_1fr] sm:items-center">
        <select aria-label="识别依据" className={inputCls + ' h-8 text-[12px]'} value={ruleType} onChange={(e) => setRuleType(e.target.value as 'keyword' | 'prefix' | 'remark')}>
          <option value="keyword">项目名含</option>
          <option value="prefix">病理号前缀</option>
          <option value="remark">备注含</option>
        </select>
        <input aria-label="识别词" className={inputCls + ' h-8 text-[12px]'} value={value} onChange={(e) => setValue(e.target.value)} placeholder="识别词" />
        <select aria-label="归到业务线" className={inputCls + ' h-8 text-[12px]'} value={lk} onChange={(e) => setLk(e.target.value)}>
          <option value="">归到业务线…</option>
          {lines.map((l) => <option key={l.key} value={l.key}>{l.name}（{(SCOPE_TAG[l.scope as LineScope] ?? SCOPE_TAG.out).t}）</option>)}
        </select>
        <button className={btnPri + ' h-8'} disabled={!lk || !value.trim()} onClick={() => onClassify(lk, ruleType, value.trim())}>归类<ArrowRight className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  )
}
