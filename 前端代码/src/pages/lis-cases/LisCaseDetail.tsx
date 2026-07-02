import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, Loader2, FlaskConical } from 'lucide-react'
import { lisCasesApi, type LisCaseItem, type CaseMarker } from '@/api/lis-cases'
import { btnCls } from '@/pages/import-shared/ImportShared'

const SPECIMEN: Record<string, string> = { tissue: '组织', tissue_complex: '组织(复杂)', cytology: '细胞' }
const SPECIMEN_OPTS = ['tissue', 'tissue_complex', 'cytology']

export default function LisCaseDetail({ partnerId, caseNo, onBack }: { partnerId: string; caseNo: string; onBack: () => void }) {
  const [c, setC] = useState<LisCaseItem | null>(null)
  const [markers, setMarkers] = useState<CaseMarker[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      lisCasesApi.list({ partnerId, keyword: caseNo, pageSize: 20 }).then((r) => r.list.find((x) => x.caseNo === caseNo) || null),
      lisCasesApi.markers(partnerId, caseNo).catch(() => [] as CaseMarker[]),
    ]).then(([cc, mm]) => { setC(cc); setMarkers(mm) })
      .catch((e) => toast.error(e?.response?.data?.error?.message || '加载失败'))
      .finally(() => setLoading(false))
  }, [partnerId, caseNo])

  async function changeSpecimen(next: string) {
    if (!c?.partnerId) return
    try { await lisCasesApi.setSpecimen(c.caseNo, next, c.partnerId); setC({ ...c, specimenType: next, specimenTypeSource: 'manual' }); toast.success('已改样本类型') }
    catch (e: any) { toast.error(e?.response?.data?.error?.message || '改失败') }
  }

  const antibodies = markers.filter((m) => m.kind === 'antibody')
  const whiteCount = markers.filter((m) => m.kind === 'white').length
  const recutCount = markers.filter((m) => m.kind === 'recut').length

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <button className={btnCls} onClick={onBack}><ArrowLeft className="h-4 w-4" />返回列表</button>
      {loading ? (
        <div className="py-16 text-center text-gray-400"><Loader2 className="mx-auto h-6 w-6 animate-spin" /></div>
      ) : !c ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-[13px] text-gray-400">没找到这个病例。</div>
      ) : (
        <>
          <h1 className="text-[18px] font-semibold tabular-nums text-gray-900">{c.caseNo}</h1>

          <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <div className="grid grid-cols-2 gap-y-3 text-[13px] sm:grid-cols-4">
              <Field label="送检医院" value={c.partnerName || '—'} />
              <Field label="病例状态" value={c.status || '—'} />
              <Field label="登记时间" value={c.operateTime || '—'} />
              <Field label="导入批次" value={c.importBatch || '—'} />
              <div>
                <div className="text-[12px] text-gray-500">样本类型</div>
                <select value={c.specimenType || 'tissue'} onChange={(e) => changeSpecimen(e.target.value)}
                  className="mt-0.5 h-8 rounded-md border border-gray-200 bg-white px-2 text-[13px] text-gray-900 outline-none focus:border-blue-500" aria-label="样本类型">
                  {SPECIMEN_OPTS.map((s) => <option key={s} value={s}>{SPECIMEN[s]}</option>)}
                </select>
                {c.specimenTypeSource === 'manual' && <span className="ml-2 text-[11px] text-gray-400">已人工改</span>}
              </div>
            </div>
          </div>

          {/* 工作量 */}
          <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <div className="mb-3 text-[13px] font-medium text-gray-700">工作量</div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              <Qty label="蜡块" value={c.quantities.block} />
              <Qty label="HE切片" value={c.quantities.heSlide} />
              <Qty label="免疫组化" value={c.quantities.ihc} />
              <Qty label="特染" value={c.quantities.specialStain} />
              <Qty label="EBER" value={c.quantities.eber} />
              <Qty label="PD-L1" value={c.quantities.pdl1} />
            </div>
          </div>

          {/* 抗体清单 */}
          <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-gray-700"><FlaskConical className="h-4 w-4 text-violet-500" />本例抗体</div>
            {antibodies.length === 0 ? (
              <div className="text-[12.5px] text-gray-400">还没导入这例的抗体清单。（在「导入」里上传抗体清单表，按病理号自动挂上）</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {antibodies.map((m, i) => (
                  <span key={i} className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-[12px] text-violet-700">{m.markerName}</span>
                ))}
              </div>
            )}
            {(whiteCount > 0 || recutCount > 0) && (
              <div className="mt-2 text-[11.5px] text-gray-400">另有 {whiteCount > 0 ? `白片 ${whiteCount} 张` : ''}{whiteCount > 0 && recutCount > 0 ? ' · ' : ''}{recutCount > 0 ? `HE深切/重切 ${recutCount} 张` : ''}（不计抗体）</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[12px] text-gray-500">{label}</div><div className="mt-0.5 text-gray-900">{value}</div></div>
}
function Qty({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-center">
      <div className="text-[18px] font-semibold tabular-nums text-gray-900">{value}</div>
      <div className="text-[11px] text-gray-500">{label}</div>
    </div>
  )
}
