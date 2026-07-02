import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Database, Upload, Search, Loader2 } from 'lucide-react'
import { lisCasesApi, type LisCaseItem } from '@/api/lis-cases'
import { Pagination } from '@/components/ui/Pagination'
import { useHospitals, inputCls, btnPri } from '@/pages/import-shared/ImportShared'
import LisImportView from './LisImportView'
import LisCaseDetail from './LisCaseDetail'

const SPECIMEN: Record<string, string> = { tissue: '组织', tissue_complex: '组织(复杂)', cytology: '细胞' }
const SPECIMEN_OPTS = ['tissue', 'tissue_complex', 'cytology']
const PAGE_SIZE = 20

export default function LisCasesPage() {
  const [view, setView] = useState<'list' | 'import' | 'detail'>('list')
  const [sel, setSel] = useState<{ partnerId: string; caseNo: string } | null>(null)
  if (view === 'import') return <LisImportView onBack={() => setView('list')} onDone={() => setView('list')} />
  if (view === 'detail' && sel) return <LisCaseDetail partnerId={sel.partnerId} caseNo={sel.caseNo} onBack={() => setView('list')} />
  return <ListView onImport={() => setView('import')} onOpen={(c) => { setSel({ partnerId: c.partnerId || '', caseNo: c.caseNo }); setView('detail') }} />
}

function ListView({ onImport, onOpen }: { onImport: () => void; onOpen: (c: LisCaseItem) => void }) {
  const { hospitals } = useHospitals()
  const [partnerId, setPartnerId] = useState('')
  const [specimenType, setSpecimenType] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ list: LisCaseItem[]; total: number }>({ list: [], total: 0 })
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    lisCasesApi.list({ page, pageSize: PAGE_SIZE, partnerId: partnerId || undefined, specimenType: specimenType || undefined, keyword: keyword.trim() || undefined })
      .then((r) => setData({ list: r.list, total: r.total }))
      .catch((e) => toast.error(e?.response?.data?.error?.message || '加载失败'))
      .finally(() => setLoading(false))
  }, [page, partnerId, specimenType, keyword])
  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [partnerId, specimenType, keyword])

  async function changeSpecimen(c: LisCaseItem, next: string) {
    if (!c.partnerId) return
    try {
      await lisCasesApi.setSpecimen(c.caseNo, next, c.partnerId)
      setData((d) => ({ ...d, list: d.list.map((x) => x.id === c.id ? { ...x, specimenType: next, specimenTypeSource: 'manual' } : x) }))
      toast.success('已改样本类型')
    } catch (e: any) { toast.error(e?.response?.data?.error?.message || '改失败') }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-blue-500" />
          <h1 className="text-[18px] font-semibold text-gray-900">LIS 病例</h1>
        </div>
        <button className={btnPri} onClick={onImport}><Upload className="h-4 w-4" />导入</button>
      </div>
      <p className="-mt-1 text-[12.5px] text-gray-500">导入的病例都在这里，每条记着蜡块、切片的数量。财务月度对账时会用它把费用算得更准。</p>

      {/* 筛选 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input className={inputCls + ' w-52 pl-9'} placeholder="搜病理号" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
        <select className={inputCls + ' w-52'} value={partnerId} onChange={(e) => setPartnerId(e.target.value)} aria-label="医院">
          <option value="">全部医院</option>
          {hospitals.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
        </select>
        <select className={inputCls + ' w-32'} value={specimenType} onChange={(e) => setSpecimenType(e.target.value)} aria-label="样本类型">
          <option value="">全部样本</option>
          {SPECIMEN_OPTS.map((s) => <option key={s} value={s}>{SPECIMEN[s]}</option>)}
        </select>
      </div>

      {/* 表格 */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left text-[12px] font-medium text-gray-600">
              <th className="px-4 py-2.5">病理号</th>
              <th className="px-4 py-2.5">送检医院</th>
              <th className="px-3 py-2.5 text-right">蜡块</th>
              <th className="px-3 py-2.5 text-right">HE切片</th>
              <th className="px-3 py-2.5 text-right">免疫组化</th>
              <th className="px-3 py-2.5 text-right">特染</th>
              <th className="px-4 py-2.5">样本</th>
              <th className="px-4 py-2.5">状态</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
            ) : data.list.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-12 text-center text-[13px] text-gray-400">还没有病例，点右上角「导入」上传 LIS 病例表。</td></tr>
            ) : data.list.map((c) => (
              <tr key={c.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                <td className="cursor-pointer px-4 py-2.5 font-medium tabular-nums text-blue-600 hover:underline" onClick={() => onOpen(c)}>{c.caseNo}</td>
                <td className="px-4 py-2.5 text-gray-600">{c.partnerName || '—'}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{c.quantities.block}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{c.quantities.heSlide}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{c.quantities.ihc}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{c.quantities.specialStain}</td>
                <td className="px-4 py-2">
                  <select value={c.specimenType || 'tissue'} onChange={(e) => changeSpecimen(c, e.target.value)}
                    className="h-7 rounded-md border border-gray-200 bg-white px-1.5 text-[12px] text-gray-700 outline-none focus:border-blue-500" aria-label="样本类型">
                    {SPECIMEN_OPTS.map((s) => <option key={s} value={s}>{SPECIMEN[s]}</option>)}
                  </select>
                </td>
                <td className="px-4 py-2.5 text-gray-500">{c.status || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* 分页（统一组件） */}
        <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />
      </div>
    </div>
  )
}
