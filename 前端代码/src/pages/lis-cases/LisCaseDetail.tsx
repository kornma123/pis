import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, FlaskConical, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { lisCasesApi, type CaseMarker, type LisCaseItem } from '@/api/lis-cases'
import { canAccess } from '@/lib/permissions'
import { btnCls } from '@/pages/import-shared/ImportShared'

const SPECIMEN: Record<string, string> = { tissue: '组织', tissue_complex: '组织（复杂）', cytology: '细胞' }
const SPECIMEN_OPTS = ['tissue', 'tissue_complex', 'cytology']

function quantity(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '未提供'
}

function message(_error: unknown, fallback: string) {
  return fallback
}

export default function LisCaseDetail({ partnerId, caseNo, onBack }: { partnerId: string; caseNo: string; onBack: () => void }) {
  const canWrite = canAccess('reconciliation', 'W')
  const requestId = useRef(0)
  const correctionActionRef = useRef(false)
  const [record, setRecord] = useState<LisCaseItem | null>(null)
  const [markers, setMarkers] = useState<CaseMarker[]>([])
  const [loading, setLoading] = useState(true)
  const [caseError, setCaseError] = useState('')
  const [markerError, setMarkerError] = useState('')
  const [saving, setSaving] = useState(false)
  // #179 登记时间更正：显式人工纠错通道（CAS expected=页面当前展示值；reason/confirm 强制）
  const [correctionOpen, setCorrectionOpen] = useState(false)
  const [newTime, setNewTime] = useState('')
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [correcting, setCorrecting] = useState(false)
  const [correctionError, setCorrectionError] = useState('')
  const [correctionStale, setCorrectionStale] = useState(false)

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current
    setLoading(true)
    setCaseError('')
    setMarkerError('')

    const [caseResult, markerResult] = await Promise.allSettled([
      lisCasesApi.list({ partnerId, keyword: caseNo, pageSize: 20 }),
      lisCasesApi.markers(partnerId, caseNo),
    ])
    if (currentRequest !== requestId.current) return

    if (caseResult.status === 'fulfilled' && Array.isArray(caseResult.value?.list)) {
      setRecord(caseResult.value.list.find((item) => item.caseNo === caseNo) || null)
    } else {
      setRecord(null)
      setCaseError(message(caseResult.status === 'rejected' ? caseResult.reason : null, '病例详情加载失败'))
    }

    if (markerResult.status === 'fulfilled' && Array.isArray(markerResult.value)) {
      setMarkers(markerResult.value)
    } else {
      setMarkers([])
      setMarkerError(message(markerResult.status === 'rejected' ? markerResult.reason : null, '抗体清单加载失败'))
    }
    setLoading(false)
  }, [caseNo, partnerId])

  useEffect(() => {
    load()
    return () => { requestId.current += 1 }
  }, [load])

  const changeSpecimen = useCallback(async (next: string) => {
    if (!record?.partnerId || !canWrite || saving) return
    setSaving(true)
    try {
      await lisCasesApi.setSpecimen(record.caseNo, next, record.partnerId)
      setRecord((current) => current ? { ...current, specimenType: next, specimenTypeSource: 'manual' } : current)
      toast.success('样本类型已记录为人工覆盖')
    } catch {
      // 请求层显示后端真因；不乐观写入。
    } finally {
      setSaving(false)
    }
  }, [canWrite, record, saving])

  const submitCorrection = useCallback(async () => {
    if (!record?.partnerId || correcting || correctionActionRef.current) return
    if (!canAccess('reconciliation', 'W')) { setCorrectionError('当前账号已无更正权限，请重新登录或联系管理员'); return }
    setCorrectionStale(false)
    if (newTime.trim() === '') { setCorrectionError('请填写新登记时间'); return }
    if (reason.trim() === '') { setCorrectionError('请填写更正原因'); return }
    if (!confirmed) { setCorrectionError('请显式确认本次更正'); return }
    setCorrectionError('')
    correctionActionRef.current = true
    setCorrecting(true)
    try {
      const result = await lisCasesApi.correct({
        partnerId: record.partnerId,
        caseNo: record.caseNo,
        expectedOperateTime: record.operateTime ?? '', // CAS：提交页面当前展示的登记时间
        newOperateTime: newTime.trim(),
        reason: reason.trim(),
        confirm: true,
      })
      if (result.partnerId !== record.partnerId || result.caseNo !== record.caseNo) throw new Error('更正回执身份不匹配')
      // 按服务端返回的 canonical truth 刷新，不沿用本地输入值
      setRecord((current) => current ? { ...current, operateTime: result.newOperateTime } : current)
      setCorrectionOpen(false)
      setNewTime('')
      setReason('')
      setConfirmed(false)
      toast.success('登记时间已更正并留痕')
    } catch (error) {
      // 请求层已 toast 真因；stale（409）需给出重载路径，其余错误不乐观写入
      const failure = error as { status?: number; code?: string }
      if (failure?.status === 409 && failure.code === 'STALE_EXPECTED') setCorrectionStale(true)
      else if (failure?.status === 409 && failure.code === 'SAME_VALUE') setCorrectionError('新登记时间与当前值相同，无需更正')
      else setCorrectionError('更正未成功，登记时间未改变，请核对后重试')
    } finally {
      correctionActionRef.current = false
      setCorrecting(false)
    }
  }, [confirmed, correcting, newTime, reason, record])

  const reloadAfterStale = useCallback(() => {
    setCorrectionOpen(false)
    setCorrectionStale(false)
    setCorrectionError('')
    load()
  }, [load])

  const antibodies = markers.filter((marker) => marker.kind === 'antibody')
  const whiteCount = markers.filter((marker) => marker.kind === 'white').length
  const recutCount = markers.filter((marker) => marker.kind === 'recut').length

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <button type="button" className={btnCls} onClick={onBack}>
        <ArrowLeft aria-hidden="true" className="h-4 w-4" />返回列表
      </button>

      {loading ? (
        <div role="status" aria-label="正在加载病例详情" className="py-16 text-center text-gray-400">
          <Loader2 aria-hidden="true" className="mx-auto h-6 w-6 animate-spin" />
        </div>
      ) : caseError ? (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-center text-sm text-amber-800">
          <AlertCircle aria-hidden="true" className="mx-auto mb-2 h-6 w-6" />
          <div className="font-medium">病例详情未加载</div>
          <div className="mt-1 text-xs">{caseError}。不能按不存在处理。</div>
          <button type="button" className={`${btnCls} mt-4`} onClick={load}>重新加载详情</button>
        </div>
      ) : !record ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-[13px] text-gray-500">未找到与医院和病理号同时匹配的病例。</div>
      ) : (
        <>
          <div>
            <h1 className="text-[18px] font-semibold tabular-nums text-gray-900">{record.caseNo}</h1>
            <p className="mt-1 text-xs text-gray-500">病例详情仅保留本流程所需字段，不展示患者身份、诊断或原始导入载荷。</p>
          </div>

          <section aria-label="病例基础信息" className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <div className="grid grid-cols-1 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="送检医院" value={record.partnerName || '未提供'} />
              <Field label="病例状态" value={record.status || '未提供'} />
              <Field label="登记时间" value={record.operateTime || '未提供'} />
              <Field label="导入批次" value={record.importBatch || '未提供'} />
              <div>
                <div className="text-[12px] text-gray-500">样本类型</div>
                {canWrite && record.partnerId ? (
                  <span className="mt-1 inline-flex items-center gap-2">
                    <select
                      value={record.specimenType || 'tissue'}
                      onChange={(event) => changeSpecimen(event.target.value)}
                      disabled={saving}
                      className="a11y-focus-ring h-9 rounded-md border border-gray-200 bg-white px-2 text-[13px] text-gray-900 disabled:opacity-60"
                      aria-label={`修改 ${record.caseNo} 的样本类型`}
                    >
                      {SPECIMEN_OPTS.map((specimen) => <option key={specimen} value={specimen}>{SPECIMEN[specimen]}</option>)}
                    </select>
                    {saving && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-gray-400" />}
                  </span>
                ) : (
                  <div className="mt-0.5 text-[13px] text-gray-900">{SPECIMEN[record.specimenType || ''] || '未提供'}</div>
                )}
                {record.specimenTypeSource === 'manual' && <div className="mt-1 text-[11px] text-gray-500">人工覆盖记录</div>}
              </div>
            </div>
            {canWrite && record.partnerId && (
              <div className="mt-4 border-t border-gray-200 pt-3">
                {!correctionOpen ? (
                  <button type="button" className={btnCls} onClick={() => { setCorrectionOpen(true); setCorrectionError(''); setCorrectionStale(false) }}>更正登记时间</button>
                ) : (
                  <div role="region" aria-label="登记时间更正" className="space-y-3 rounded-md border border-gray-200 bg-gray-50 p-3 text-[13px]">
                    <div className="text-gray-700">当前登记时间：<span className="font-medium tabular-nums text-gray-900">{record.operateTime || '未提供'}</span>（将作为并发校验基准）</div>
                    <label className="block text-gray-700">
                      新登记时间
                      <input
                        type="text"
                        value={newTime}
                        onChange={(event) => setNewTime(event.target.value)}
                        placeholder="YYYY-MM-DD"
                        aria-label="新登记时间"
                        disabled={correcting}
                        className="a11y-focus-ring mt-1 h-9 w-full rounded-md border border-gray-200 bg-white px-2 text-[13px] text-gray-900 disabled:opacity-60"
                      />
                    </label>
                    <label className="block text-gray-700">
                      更正原因
                      <textarea
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        aria-label="更正原因"
                        rows={2}
                        disabled={correcting}
                        className="a11y-focus-ring mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-[13px] text-gray-900 disabled:opacity-60"
                      />
                    </label>
                    <label className="flex items-start gap-2 text-gray-700">
                      <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={correcting} className="mt-0.5" />
                      我确认本次登记时间更正已核对无误，并计入留痕
                    </label>
                    {correctionError && <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{correctionError}</div>}
                    {correctionStale && (
                      <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                        登记时间已被修改，本次更正未生效。请重新加载病例后再按最新值提交。
                        <button type="button" className={`${btnCls} ml-2`} onClick={reloadAfterStale}>重新加载</button>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={btnCls} disabled={correcting} onClick={() => { setCorrectionOpen(false); setCorrectionError(''); setCorrectionStale(false) }}>取消</button>
                      <button type="button" className={btnCls} disabled={correcting} onClick={submitCorrection}>
                        {correcting ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}提交更正
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          <section aria-labelledby="workload-title" className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <h2 id="workload-title" className="mb-3 text-[13px] font-medium text-gray-700">工作量</h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Qty label="蜡块" value={record.quantities?.block} />
              <Qty label="HE 切片" value={record.quantities?.heSlide} />
              <Qty label="免疫组化" value={record.quantities?.ihc} />
              <Qty label="特染" value={record.quantities?.specialStain} />
              <Qty label="EBER" value={record.quantities?.eber} />
              <Qty label="PD-L1" value={record.quantities?.pdl1} />
            </div>
          </section>

          <section aria-labelledby="marker-title" className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <h2 id="marker-title" className="mb-3 flex items-center gap-2 text-[13px] font-medium text-gray-700">
              <FlaskConical aria-hidden="true" className="h-4 w-4 text-violet-500" />本例抗体
            </h2>
            {markerError ? (
              <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                <div className="font-medium">抗体清单未加载</div>
                <div className="mt-1">{markerError}。当前结果未知，不能按“没有抗体”处理。</div>
                <button type="button" className={`${btnCls} mt-3`} onClick={load}>重新核对抗体清单</button>
              </div>
            ) : antibodies.length === 0 ? (
              <div className="text-[12.5px] text-gray-500">已成功查询；当前没有匹配的抗体清单。</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {antibodies.map((marker, index) => (
                  <span key={`${marker.markerName}-${index}`} className="inline-flex max-w-full items-center break-all rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-[12px] text-violet-700">
                    {marker.markerName}
                  </span>
                ))}
              </div>
            )}
            {!markerError && (whiteCount > 0 || recutCount > 0) && (
              <div className="mt-2 text-[11.5px] text-gray-500">
                {whiteCount > 0 ? `白片 ${whiteCount} 张` : ''}{whiteCount > 0 && recutCount > 0 ? ' · ' : ''}{recutCount > 0 ? `HE 深切/重切 ${recutCount} 张` : ''}（不计抗体）
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[12px] text-gray-500">{label}</div><div className="mt-0.5 break-words text-[13px] text-gray-900">{value}</div></div>
}

function Qty({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded-md border border-gray-200 bg-gray-50 px-2 py-2 text-center">
      <div className="break-words text-[18px] font-semibold tabular-nums text-gray-900">{quantity(value)}</div>
      <div className="text-[11px] text-gray-500">{label}</div>
    </div>
  )
}
