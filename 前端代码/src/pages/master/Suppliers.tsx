import { useState, useEffect } from 'react'
import { Search, Plus, X } from 'lucide-react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { Pagination } from '@/components/ui/Pagination'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { supplierApi } from '@/api/master'
import type { Supplier } from '@/types'
import { toast } from 'sonner'

interface FormData {
  code: string
  name: string
  contact: string
  phone: string
  email: string
  address: string
  taxNo: string
  bankName: string
  bankAccount: string
  status: 'active' | 'inactive'
}

type ModalType = 'create' | 'edit' | 'detail' | null

export default function Suppliers() {
  const { get, getNumber, setMultiple } = useUrlParams()

  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchStatus, setSearchStatus] = useState<string>('all')
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const urlPage = Math.max(1, getNumber('page', 1))
  const urlPageSize = [10, 20, 50, 100].includes(getNumber('pageSize', 100))
    ? getNumber('pageSize', 100)
    : 100

  const {
    data,
    loading,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
  } = usePagination<Supplier>({
    fetchFn: async ({ page, pageSize }) => {
      const params: any = { page, pageSize, keyword: keyword || undefined }
      if (statusFilter && statusFilter !== 'all') {
        params.status = statusFilter
      }
      const res: any = await supplierApi.getList(params)
      return { list: res.list || [], pagination: res.pagination }
    },
    initialPage: urlPage,
    initialPageSize: urlPageSize,
    deps: [keyword, statusFilter],
  })

  useEffect(() => {
    setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 100 ? pageSize : null,
      keyword: keyword || null,
      status: statusFilter !== 'all' ? statusFilter : null,
    })
  }, [page, pageSize, keyword, statusFilter, setMultiple])

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [modalType, setModalType] = useState<ModalType>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailRow, setDetailRow] = useState<Supplier | null>(null)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmProps, setConfirmProps] = useState<{
    title: string
    description: string
    confirmText: string
    confirmVariant: 'danger' | 'primary'
    onConfirm: () => void
  } | null>(null)

  const openConfirm = (props: {
    title: string
    description: string
    confirmText: string
    confirmVariant: 'danger' | 'primary'
    onConfirm: () => void
  }) => {
    setConfirmProps(props)
    setConfirmOpen(true)
  }

  const [form, setForm] = useState<FormData>({
    code: '',
    name: '',
    contact: '',
    phone: '',
    email: '',
    address: '',
    taxNo: '',
    bankName: '',
    bankAccount: '',
    status: 'active',
  })

  const stats = {
    total,
    active: data.filter((d) => d.status === 'active').length,
    inactive: data.filter((d) => d.status === 'inactive').length,
    newThisMonth: data.filter((d) => {
      if (!d.createdAt) return false
      const created = new Date(d.createdAt)
      const now = new Date()
      return (
        created.getMonth() === now.getMonth() &&
        created.getFullYear() === now.getFullYear()
      )
    }).length,
  }

  const handleSearch = () => {
    setKeyword(searchKeyword)
    setStatusFilter(searchStatus)
    setPage(1)
  }

  const handleReset = () => {
    setSearchKeyword('')
    setSearchStatus('all')
    setKeyword('')
    setStatusFilter('all')
    setPage(1)
  }

  const openCreate = () => {
    setEditingId(null)
    setForm({
      code: '',
      name: '',
      contact: '',
      phone: '',
      email: '',
      address: '',
      taxNo: '',
      bankName: '',
      bankAccount: '',
      status: 'active',
    })
    setModalType('create')
  }

  const openEdit = (row: Supplier) => {
    setEditingId(row.id)
    setForm({
      code: row.code,
      name: row.name,
      contact: row.contact || '',
      phone: row.phone || '',
      email: row.email || '',
      address: row.address || '',
      taxNo: row.taxNo || '',
      bankName: row.bankName || '',
      bankAccount: row.bankAccount || '',
      status: row.status,
    })
    setModalType('edit')
  }

  const openDetail = (row: Supplier) => {
    setDetailRow(row)
    setModalType('detail')
  }

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      toast.error('请填写供应商名称')
      return
    }
    try {
      if (editingId) {
        await supplierApi.update(editingId, form)
      } else {
        await supplierApi.create(form)
      }
      toast.success('保存成功')
      setModalType(null)
      refresh()
    } catch (e) {
      toast.error('保存失败')
    }
  }

  const handleDelete = async (id: string) => {
    openConfirm({
      title: '确认删除',
      description: '确定删除该供应商？删除后不可恢复。',
      confirmText: '删除',
      confirmVariant: 'danger',
      onConfirm: async () => {
        try {
          await supplierApi.delete(id)
          toast.success('删除成功')
          refresh()
        } catch (e) {
          toast.error('删除失败')
        }
      },
    })
  }

  const handleToggleStatus = async (row: Supplier) => {
    const newStatus = row.status === 'active' ? 'inactive' : 'active'
    try {
      await supplierApi.update(row.id, { status: newStatus })
      toast.success(newStatus === 'active' ? '已启用' : '已停用')
      refresh()
    } catch (e) {
      toast.error('操作失败')
    }
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === data.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(data.map((d) => d.id)))
    }
  }

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setSelectedIds(next)
  }

  const getAvatarColor = (name: string) => {
    const colors = [
      { bg: '#e0e7ff', text: '#4f46e5' },
      { bg: '#fef3c7', text: '#d97706' },
      { bg: '#dbeafe', text: '#2563eb' },
      { bg: '#dcfce7', text: '#16a34a' },
      { bg: '#fce7f3', text: '#db2777' },
      { bg: '#f3e8ff', text: '#9333ea' },
    ]
    const index = name.charCodeAt(0) % colors.length
    return colors[index]
  }

  return (
    <div className="space-y-5">
      {/* 页面头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight">
            供应商管理
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            管理供应商信息，维护采购渠道
          </p>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[#3b82f6] text-white rounded-[6px] hover:bg-blue-700 text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          新增供应商
        </button>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { value: stats.total, label: '供应商总数' },
          { value: stats.active, label: '合作中' },
          { value: stats.inactive, label: '已终止' },
          { value: stats.newThisMonth, label: '本月新增' },
        ].map((stat, i) => (
          <div
            key={i}
            className="bg-white rounded-[8px] border border-gray-200 p-5"
          >
            <div className="text-[24px] font-semibold text-gray-900">
              {stat.value}
            </div>
            <div className="text-sm text-gray-500 mt-1">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* 表格卡片 */}
      <div className="bg-white rounded-[8px] border border-gray-200 overflow-hidden">
        {/* 筛选栏 */}
        <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-gray-100">
          <span className="text-sm font-medium text-gray-900">供应商列表</span>
          <div className="flex-1" />
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="搜索供应商名称"
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="w-56 h-10 pl-9 pr-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <select
              value={searchStatus}
              onChange={(e) => setSearchStatus(e.target.value)}
              className="h-10 px-3 border border-gray-200 rounded-[6px] text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">全部状态</option>
              <option value="active">合作中</option>
              <option value="inactive">已终止</option>
            </select>
            <button
              onClick={handleSearch}
              className="h-10 px-4 text-sm text-gray-700 hover:bg-gray-50 rounded-[6px] border border-gray-200 transition-colors"
            >
              查询
            </button>
            <button
              onClick={handleReset}
              className="h-10 px-4 text-sm text-gray-600 hover:bg-gray-50 rounded-[6px] border border-gray-200 transition-colors"
            >
              重置
            </button>
          </div>
        </div>

        {/* 表格 */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left w-10">
                  <input
                    type="checkbox"
                    checked={data.length > 0 && selectedIds.size === data.length}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                  供应商名称/编码
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                  联系人
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                  联系电话
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                  合作状态
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                  创建时间
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                    加载中...
                  </td>
                </tr>
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                    暂无数据
                  </td>
                </tr>
              ) : (
                data.map((row) => {
                  const avatarColor = getAvatarColor(row.name)
                  const firstChar = row.name.charAt(0)
                  return (
                    <tr key={row.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(row.id)}
                          onChange={() => toggleSelect(row.id)}
                          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-10 h-10 rounded-[8px] flex items-center justify-center font-semibold text-sm shrink-0"
                            style={{
                              backgroundColor: avatarColor.bg,
                              color: avatarColor.text,
                            }}
                          >
                            {firstChar}
                          </div>
                          <div>
                            <div className="font-medium text-gray-900">
                              {row.name}
                            </div>
                            <div className="text-xs text-gray-500">
                              {row.code}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {row.contact || '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {row.phone || '-'}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            row.status === 'active'
                              ? 'bg-green-100 text-green-700'
                              : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {row.status === 'active' ? '合作中' : '已终止'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {row.createdAt ? row.createdAt.split('T')[0] : '-'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => openDetail(row)}
                            className="px-2 py-1 text-xs text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                          >
                            详情
                          </button>
                          <button
                            onClick={() => openEdit(row)}
                            className="px-2 py-1 text-xs text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                          >
                            编辑
                          </button>
                          <button
                            onClick={() => handleToggleStatus(row)}
                            className="px-2 py-1 text-xs text-gray-500 hover:text-orange-600 hover:bg-orange-50 rounded transition-colors"
                          >
                            {row.status === 'active' ? '停用' : '启用'}
                          </button>
                          <button
                            onClick={() => handleDelete(row.id)}
                            className="px-2 py-1 text-xs text-gray-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100">
          <span className="text-sm text-gray-500">共 {total} 条记录</span>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onChangePage={setPage}
            onChangePageSize={setPageSize}
          />
        </div>
      </div>

      {/* ConfirmDialog */}
      {confirmOpen && confirmProps && (
        <ConfirmDialog
          open={confirmOpen}
          title={confirmProps.title}
          description={confirmProps.description}
          confirmText={confirmProps.confirmText}
          confirmVariant={confirmProps.confirmVariant}
          onConfirm={() => {
            setConfirmOpen(false)
            confirmProps.onConfirm()
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      {/* 新建/编辑弹窗 */}
      {(modalType === 'create' || modalType === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold">
                {modalType === 'create' ? '新增供应商' : '编辑供应商'}
              </h3>
              <button
                onClick={() => setModalType(null)}
                className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    供应商名称 <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={form.name}
                    onChange={(e) =>
                      setForm({ ...form, name: e.target.value })
                    }
                    placeholder="请输入供应商名称"
                    className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    供应商编码
                    <span className="text-xs text-gray-400 font-normal ml-1">（自动生成）</span>
                  </label>
                  <input
                    value={form.code}
                    disabled
                    readOnly
                    placeholder="保存后自动生成"
                    className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    联系人 <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={form.contact}
                    onChange={(e) =>
                      setForm({ ...form, contact: e.target.value })
                    }
                    placeholder="请输入联系人姓名"
                    className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    联系电话 <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={form.phone}
                    onChange={(e) =>
                      setForm({ ...form, phone: e.target.value })
                    }
                    placeholder="请输入联系电话"
                    className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    电子邮箱
                  </label>
                  <input
                    value={form.email}
                    onChange={(e) =>
                      setForm({ ...form, email: e.target.value })
                    }
                    placeholder="请输入电子邮箱"
                    className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    合作状态 <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={form.status}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        status: e.target.value as 'active' | 'inactive',
                      })
                    }
                    className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="active">合作中</option>
                    <option value="inactive">已终止</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  公司地址
                </label>
                <input
                  value={form.address}
                  onChange={(e) =>
                    setForm({ ...form, address: e.target.value })
                  }
                  placeholder="请输入公司地址"
                  className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    开户银行
                  </label>
                  <input
                    value={form.bankName}
                    onChange={(e) =>
                      setForm({ ...form, bankName: e.target.value })
                    }
                    placeholder="请输入开户银行"
                    className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    银行账号
                  </label>
                  <input
                    value={form.bankAccount}
                    onChange={(e) =>
                      setForm({ ...form, bankAccount: e.target.value })
                    }
                    placeholder="请输入银行账号"
                    className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  纳税人识别号
                </label>
                <input
                  value={form.taxNo}
                  onChange={(e) =>
                    setForm({ ...form, taxNo: e.target.value })
                  }
                  placeholder="请输入纳税人识别号"
                  className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setModalType(null)}
                className="h-10 px-4 text-sm text-gray-600 hover:bg-gray-50 rounded-[6px] border border-gray-200 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSubmit}
                className="h-10 px-4 bg-[#3b82f6] text-white text-sm rounded-[6px] hover:bg-blue-700 transition-colors"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 详情弹窗 */}
      {modalType === 'detail' && detailRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold">供应商详情</h3>
              <button
                onClick={() => setModalType(null)}
                className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6">
              <div className="flex items-center gap-4 mb-6">
                <div
                  className="w-[60px] h-[60px] rounded-xl flex items-center justify-center font-semibold text-2xl"
                  style={{
                    backgroundColor: getAvatarColor(detailRow.name).bg,
                    color: getAvatarColor(detailRow.name).text,
                  }}
                >
                  {detailRow.name.charAt(0)}
                </div>
                <div>
                  <div className="text-lg font-semibold text-gray-900">
                    {detailRow.name}
                  </div>
                  <div className="text-sm text-gray-500">
                    {detailRow.code}
                  </div>
                </div>
                <span
                  className={`ml-auto inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    detailRow.status === 'active'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {detailRow.status === 'active' ? '合作中' : '已终止'}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="bg-gray-50 rounded-lg p-4 text-center">
                  <div className="text-xl font-semibold text-[#3b82f6]">
                    ¥{(detailRow.totalAmount || 0).toLocaleString()}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">年度采购额</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-4 text-center">
                  <div className="text-xl font-semibold text-gray-900">
                    {detailRow.cooperationCount || 0}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">合作次数</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-4 text-center">
                  <div className="text-xl font-semibold text-green-600">
                    {'★'.repeat(detailRow.rating || 5)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">信用评级</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-y-4 gap-x-6">
                <div>
                  <span className="text-sm text-gray-500">联系人：</span>
                  <span className="text-sm text-gray-900 ml-2">
                    {detailRow.contact || '-'}
                  </span>
                </div>
                <div>
                  <span className="text-sm text-gray-500">联系电话：</span>
                  <span className="text-sm text-gray-900 ml-2">
                    {detailRow.phone || '-'}
                  </span>
                </div>
                <div>
                  <span className="text-sm text-gray-500">电子邮箱：</span>
                  <span className="text-sm text-gray-900 ml-2">
                    {detailRow.email || '-'}
                  </span>
                </div>
                <div>
                  <span className="text-sm text-gray-500">公司地址：</span>
                  <span className="text-sm text-gray-900 ml-2">
                    {detailRow.address || '-'}
                  </span>
                </div>
                <div>
                  <span className="text-sm text-gray-500">开户银行：</span>
                  <span className="text-sm text-gray-900 ml-2">
                    {detailRow.bankName || '-'}
                  </span>
                </div>
                <div>
                  <span className="text-sm text-gray-500">银行账号：</span>
                  <span className="text-sm text-gray-900 ml-2">
                    {detailRow.bankAccount || '-'}
                  </span>
                </div>
                <div>
                  <span className="text-sm text-gray-500">纳税人识别号：</span>
                  <span className="text-sm text-gray-900 ml-2">
                    {detailRow.taxNo || '-'}
                  </span>
                </div>
                <div>
                  <span className="text-sm text-gray-500">创建时间：</span>
                  <span className="text-sm text-gray-900 ml-2">
                    {detailRow.createdAt
                      ? detailRow.createdAt.split('T')[0]
                      : '-'}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setModalType(null)}
                className="h-10 px-4 text-sm text-gray-600 hover:bg-gray-50 rounded-[6px] border border-gray-200 transition-colors"
              >
                关闭
              </button>
              <button
                onClick={() => {
                  setModalType(null)
                  openEdit(detailRow)
                }}
                className="h-10 px-4 bg-[#3b82f6] text-white text-sm rounded-[6px] hover:bg-blue-700 transition-colors"
              >
                编辑
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
