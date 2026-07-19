import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertCircle, Database, Loader2, Search, Upload } from 'lucide-react'
import { lisCasesApi, type LisCaseItem } from '@/api/lis-cases'
import { EmptyState } from '@/components/ui/EmptyState'
import { Pagination } from '@/components/ui/Pagination'
import { canAccess } from '@/lib/permissions'
import { useHospitals, inputCls, btnPri } from '@/pages/import-shared/ImportShared'
import LisImportView from './LisImportView'
import LisCaseDetail from './LisCaseDetail'

const SPECIMEN: Record<string, string> = { tissue: '组织', tissue_complex: '组织（复杂）', cytology: '细胞' }
const SPECIMEN_OPTS = ['tissue', 'tissue_complex', 'cytology']
const PAGE_SIZE = 20

function errorMessage(_error: unknown, fallback: string) {
  return fallback
}

function quantity(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : '未提供'
}

export default function LisCasesPage() {
  const [view, setView] = useState<'list' | 'import' | 'detail'>('list')
  const [selected, setSelected] = useState<{ partnerId: string; caseNo: string } | null>(null)

  if (view === 'import') {
    return <LisImportView onBack={() => setView('list')} onDone={() => setView('list')} />
  }
  if (view === 'detail' && selected) {
    return (
      <LisCaseDetail
        partnerId={selected.partnerId}
        caseNo={selected.caseNo}
        onBack={() => setView('list')}
      />
    )
  }
  return (
    <ListView
      onImport={() => setView('import')}
      onOpen={(record) => {
        setSelected({ partnerId: record.partnerId || '', caseNo: record.caseNo })
        setView('detail')
      }}
    />
  )
}

function ListView({ onImport, onOpen }: { onImport: () => void; onOpen: (record: LisCaseItem) => void }) {
  const { hospitals } = useHospitals()
  const canWrite = canAccess('reconciliation', 'W')
  const requestId = useRef(0)
  const [partnerId, setPartnerId] = useState('')
  const [specimenType, setSpecimenType] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ list: LisCaseItem[]; total: number }>({ list: [], total: 0 })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [specimenBusy, setSpecimenBusy] = useState('')

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current
    setLoading(true)
    setLoadError('')
    try {
      const response = await lisCasesApi.list({
        page,
        pageSize: PAGE_SIZE,
        partnerId: partnerId || undefined,
        specimenType: specimenType || undefined,
        keyword: keyword.trim() || undefined,
      })
      if (currentRequest !== requestId.current) return
      if (!response || !Array.isArray(response.list) || typeof response.total !== 'number') {
        throw new Error('病例列表响应格式异常')
      }
      setData({ list: response.list, total: response.total })
    } catch (error) {
      if (currentRequest === requestId.current) {
        setLoadError(errorMessage(error, '病例列表加载失败'))
      }
    } finally {
      if (currentRequest === requestId.current) setLoading(false)
    }
  }, [keyword, page, partnerId, specimenType])

  useEffect(() => {
    load()
    return () => { requestId.current += 1 }
  }, [load])

  const changeSpecimen = useCallback(async (record: LisCaseItem, next: string) => {
    if (!record.partnerId || !canWrite || specimenBusy) return
    setSpecimenBusy(record.id)
    try {
      await lisCasesApi.setSpecimen(record.caseNo, next, record.partnerId)
      setData((current) => ({
        ...current,
        list: current.list.map((item) => item.id === record.id
          ? { ...item, specimenType: next, specimenTypeSource: 'manual' }
          : item),
      }))
      toast.success('样本类型已记录为人工覆盖')
    } catch {
      // 全局请求层显示后端真因；本地数据保持不变。
    } finally {
      setSpecimenBusy('')
    }
  }, [canWrite, specimenBusy])

  const resetPageAnd = (setter: (value: string) => void, value: string) => {
    setter(value)
    setPage(1)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Database aria-hidden="true" className="h-5 w-5 text-blue-500" />
            <h1 className="text-[18px] font-semibold text-gray-900">LIS 病例</h1>
          </div>
          <p className="mt-1 text-[12.5px] text-gray-500">仅展示对工作量核对必要的病理号、医院、数量和样本分类。</p>
        </div>
        {canWrite ? (
          <button type="button" className={btnPri} onClick={onImport} aria-label="导入 LIS 文件">
            <Upload aria-hidden="true" className="h-4 w-4" />导入
          </button>
        ) : (
          <span className="rounded-md bg-gray-100 px-3 py-2 text-xs text-gray-500">只读：无病例写权限</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-52">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            aria-label="搜索病理号"
            className={`${inputCls} w-full pl-9`}
            placeholder="搜病理号"
            value={keyword}
            onChange={(event) => resetPageAnd(setKeyword, event.target.value)}
          />
        </div>
        <select
          className={`${inputCls} min-w-0 flex-1 sm:w-52 sm:flex-none`}
          value={partnerId}
          onChange={(event) => resetPageAnd(setPartnerId, event.target.value)}
          aria-label="筛选医院"
        >
          <option value="">全部医院</option>
          {hospitals.map((hospital) => <option key={hospital.id} value={hospital.id}>{hospital.name}</option>)}
        </select>
        <select
          className={`${inputCls} min-w-0 flex-1 sm:w-36 sm:flex-none`}
          value={specimenType}
          onChange={(event) => resetPageAnd(setSpecimenType, event.target.value)}
          aria-label="筛选样本类型"
        >
          <option value="">全部样本</option>
          {SPECIMEN_OPTS.map((specimen) => <option key={specimen} value={specimen}>{SPECIMEN[specimen]}</option>)}
        </select>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        {loadError ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-4 py-12 text-center text-sm text-gray-600">
            <AlertCircle aria-hidden="true" className="h-6 w-6 text-amber-500" />
            <div><div className="font-medium text-gray-800">病例列表未加载</div><div className="mt-1 text-xs">{loadError}。数据未知，不能按空列表处理。</div></div>
            <button type="button" className="button-secondary" onClick={load}>重新加载病例</button>
          </div>
        ) : loading ? (
          <div role="status" aria-label="正在加载病例" className="space-y-2 p-4">
            {[0, 1, 2].map((row) => <div key={row} className="h-10 animate-pulse rounded bg-gray-100" />)}
          </div>
        ) : data.list.length === 0 ? (
          <EmptyState
            icon={Database}
            title="当前条件下没有病例"
            description={canWrite ? '可调整筛选，或导入经校验的 LIS 工作量文件。' : '可调整筛选；当前账号只有读取权限。'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[820px] w-full text-[13px]">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left text-[12px] font-medium text-gray-600">
                  <th className="px-4 py-2.5">病理号</th>
                  <th className="px-4 py-2.5">送检医院</th>
                  <th className="px-3 py-2.5 text-right">蜡块</th>
                  <th className="px-3 py-2.5 text-right">HE 切片</th>
                  <th className="px-3 py-2.5 text-right">免疫组化</th>
                  <th className="px-3 py-2.5 text-right">特染</th>
                  <th className="px-4 py-2.5">样本</th>
                  <th className="px-4 py-2.5">状态</th>
                </tr>
              </thead>
              <tbody>
                {data.list.map((record) => (
                  <tr key={record.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-2.5">
                      {record.partnerId ? (
                        <button
                          type="button"
                          aria-label={`查看病例 ${record.caseNo}`}
                          className="a11y-focus-ring rounded font-medium tabular-nums text-blue-600 hover:underline"
                          onClick={() => onOpen(record)}
                        >
                          {record.caseNo}
                        </button>
                      ) : (
                        <span className="inline-flex flex-col gap-0.5">
                          <span className="font-medium tabular-nums text-gray-800">{record.caseNo}</span>
                          <span className="text-[11px] text-amber-700">合作方未映射，详情不可核定</span>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{record.partnerName || '未提供'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{quantity(record.quantities?.block)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{quantity(record.quantities?.heSlide)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{quantity(record.quantities?.ihc)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{quantity(record.quantities?.specialStain)}</td>
                    <td className="px-4 py-2">
                      {canWrite && record.partnerId ? (
                        <span className="inline-flex items-center gap-1">
                          <select
                            value={record.specimenType || 'tissue'}
                            onChange={(event) => changeSpecimen(record, event.target.value)}
                            disabled={Boolean(specimenBusy)}
                            className="a11y-focus-ring h-8 rounded-md border border-gray-200 bg-white px-2 text-[12px] text-gray-700 disabled:opacity-60"
                            aria-label={`修改 ${record.caseNo} 的样本类型`}
                          >
                            {SPECIMEN_OPTS.map((specimen) => <option key={specimen} value={specimen}>{SPECIMEN[specimen]}</option>)}
                          </select>
                          {specimenBusy === record.id && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin text-gray-400" />}
                        </span>
                      ) : (
                        <span>{SPECIMEN[record.specimenType || ''] || '未提供'}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500">{record.status || '未提供'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loadError && !loading && data.list.length > 0 && (
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />
        )}
      </div>
    </div>
  )
}
