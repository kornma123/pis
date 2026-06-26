import React, { useEffect, useState } from 'react'
import { Plus, Edit, Trash2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/Modal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

interface ActivityCenter {
  id: string
  code: string
  name: string
  description: string
  costDriverType: string
  parentId: string | null
  parentName?: string | null
  sortOrder: number
  status: string
  createdAt: string
  updatedAt: string
}

interface CostDriverOption {
  value: string
  label: string
}

const DEFAULT_COST_DRIVER_TYPES = [
  { value: 'block_count', label: '蜡块数' },
  { value: 'slide_count', label: '切片数' },
  { value: 'stain_count', label: '染色次数' },
  { value: 'test_count', label: '检测项数' },
  { value: 'probe_locus_panel', label: '探针/位点/面板' },
  { value: 'report_count', label: '报告数' },
  { value: 'slide_block_count', label: '玻片数+蜡块数' },
]

export function ActivityCenterList() {
  const initialKeyword = new URLSearchParams(window.location.search).get('keyword') || ''
  const [activityCenters, setActivityCenters] = useState<ActivityCenter[]>([])
  const [costDriverTypes, setCostDriverTypes] = useState<CostDriverOption[]>(DEFAULT_COST_DRIVER_TYPES)
  const [loading, setLoading] = useState(true)
  const [searchKeyword, setSearchKeyword] = useState(initialKeyword)
  const [showDialog, setShowDialog] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editingCenter, setEditingCenter] = useState<ActivityCenter | null>(null)
  const [formData, setFormData] = useState({
    code: '',
    name: '',
    description: '',
    costDriverType: 'slide_count',
    parentId: '',
    sortOrder: 0,
    status: 'active',
  })

  useEffect(() => {
    loadActivityCenters()
    loadCostDriverTypes()
  }, [])

  const loadCostDriverTypes = async () => {
    try {
      const response = await fetch('/api/v1/abc/cost-drivers', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
      })
      const data = await response.json()
      if (data.success) {
        const list = data.data?.list || data.data?.items || data.data || []
        const activeOptions = list
          .filter((driver: any) => (driver.status || 'active') === 'active')
          .map((driver: any) => ({
            value: driver.code,
            label: `${driver.name}${driver.unit ? `（${driver.unit}）` : ''}`,
          }))
        if (activeOptions.length > 0) {
          setCostDriverTypes(activeOptions)
        }
      }
    } catch (error) {
      console.error('Failed to load cost drivers:', error)
    }
  }

  const loadActivityCenters = async (keywordOverride = searchKeyword) => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      const keyword = keywordOverride.trim()
      if (keyword) params.set('keyword', keyword)
      const url = `/api/v1/abc/activity-centers${params.toString() ? `?${params.toString()}` : ''}`
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
      })
      const data = await response.json()
      if (data.success) {
        // 兼容 list 和 items 两种数据结构
        setActivityCenters(data.data?.list || data.data?.items || data.data || [])
      }
    } catch (error) {
      console.error('Failed to load activity centers:', error)
      toast.error('加载作业中心失败')
    } finally {
      setLoading(false)
    }
  }

  const handleAdd = () => {
    setEditingCenter(null)
    setFormData({
      code: '',
      name: '',
      description: '',
      costDriverType: 'slide_count',
      parentId: '',
      sortOrder: 0,
      status: 'active',
    })
    setShowDialog(true)
  }

  const handleEdit = (center: ActivityCenter) => {
    setEditingCenter(center)
    setFormData({
      code: center.code,
      name: center.name,
      description: center.description || '',
      costDriverType: center.costDriverType,
      parentId: center.parentId || '',
      sortOrder: center.sortOrder,
      status: center.status || 'active',
    })
    setShowDialog(true)
  }

  const handleSave = async () => {
    if (!formData.code || !formData.name) {
      toast.error('请填写必填字段')
      return
    }

    try {
      const url = editingCenter
        ? `/api/v1/abc/activity-centers/${editingCenter.id}`
        : '/api/v1/abc/activity-centers'

      const method = editingCenter ? 'PUT' : 'POST'

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify(formData),
      })

      const data = await response.json()
      if (data.success) {
        const nextKeyword = editingCenter
          ? searchKeyword
          : String(data.data?.code || formData.code || '').trim()
        toast.success(editingCenter ? '更新成功' : '创建成功')
        setShowDialog(false)
        if (!editingCenter && nextKeyword) {
          setSearchKeyword(nextKeyword)
          await loadActivityCenters(nextKeyword)
        } else {
          await loadActivityCenters()
        }
      } else {
        toast.error(data.error?.message || '操作失败')
      }
    } catch (error) {
      console.error('Failed to save activity center:', error)
      toast.error('保存失败')
    }
  }

  const handleDeleteClick = (id: string) => {
    setDeletingId(id)
    setShowDeleteConfirm(true)
  }

  const handleDeleteConfirm = async () => {
    if (!deletingId) return

    try {
      const response = await fetch(`/api/v1/abc/activity-centers/${deletingId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
      })

      const data = await response.json()
      if (data.success) {
        toast.success('删除成功')
        loadActivityCenters()
      } else {
        toast.error(data.error?.message || '删除失败')
      }
    } catch (error) {
      console.error('Failed to delete activity center:', error)
      toast.error('删除失败')
    } finally {
      setShowDeleteConfirm(false)
      setDeletingId(null)
    }
  }

  const centerNameById = new Map(activityCenters.map(center => [center.id, center.name]))
  const getParentName = (center: ActivityCenter) => {
    if (!center.parentId) return '顶级作业中心'
    return center.parentName || centerNameById.get(center.parentId) || center.parentId
  }
  const selectableParentCenters = activityCenters.filter(center =>
    !editingCenter || center.id !== editingCenter.id
  )

  const filteredCenters = activityCenters.filter(center =>
    center.id.includes(searchKeyword) ||
    center.name.includes(searchKeyword) ||
    center.code.includes(searchKeyword) ||
    center.costDriverType.includes(searchKeyword) ||
    getParentName(center).includes(searchKeyword) ||
    center.description?.includes(searchKeyword)
  )

  return (
    <div className="p-6 space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">作业中心管理</h1>
          <p className="text-sm text-gray-500 mt-1">配置 ABC 作业成本法的作业中心</p>
        </div>
        <button
          onClick={handleAdd}
          className="h-10 px-4 bg-[#3b82f6] text-white rounded-md hover:bg-blue-600 transition-colors flex items-center gap-2"
        >
          <Plus className="h-4 w-4" />
          新增作业中心
        </button>
      </div>

      {/* 搜索栏 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
          <input
            type="text"
            placeholder="搜索作业中心..."
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            className="w-full h-10 pl-10 pr-4 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          />
        </div>
      </div>

      {/* 表格 */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">代码</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">名称</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">上级作业中心</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">描述</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">成本动因类型</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">排序</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">状态</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-gray-400">
                  加载中...
                </td>
              </tr>
            ) : filteredCenters.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-gray-400">
                  暂无数据
                </td>
              </tr>
            ) : (
              filteredCenters.map(center => (
                <tr key={center.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-mono text-gray-900">{center.code}</td>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{center.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{getParentName(center)}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{center.description || '-'}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {costDriverTypes.find(t => t.value === center.costDriverType)?.label || center.costDriverType}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">{center.sortOrder}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      center.status === 'active'
                        ? 'bg-green-100 text-green-800'
                        : 'bg-gray-100 text-gray-800'
                    }`}>
                      {center.status === 'active' ? '启用' : '禁用'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleEdit(center)}
                      aria-label={`编辑 ${center.name}`}
                      className="p-1 text-gray-400 hover:text-blue-600 transition-colors"
                      title="编辑"
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteClick(center.id)}
                      aria-label={`删除 ${center.name}`}
                      className="p-1 text-gray-400 hover:text-red-600 transition-colors ml-1"
                      title="删除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 新增/编辑弹窗 */}
      {showDialog && (
        <Modal
          onClose={() => setShowDialog(false)}
          title={editingCenter ? '编辑作业中心' : '新增作业中心'}
        >
          <div className="space-y-4">
            <div>
              <label htmlFor="activity-center-code" className="block text-sm font-medium text-gray-700 mb-1">代码 *</label>
              <input
                id="activity-center-code"
                type="text"
                value={formData.code}
                onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                placeholder="例如：SPECIMEN"
                disabled={!!editingCenter}
                className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 disabled:bg-gray-100"
              />
            </div>

            <div>
              <label htmlFor="activity-center-name" className="block text-sm font-medium text-gray-700 mb-1">名称 *</label>
              <input
                id="activity-center-name"
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="例如：标本处理中心"
                className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>

            <div>
              <label htmlFor="activity-center-description" className="block text-sm font-medium text-gray-700 mb-1">描述</label>
              <textarea
                id="activity-center-description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="作业中心的详细描述"
                rows={3}
                className="w-full px-3 py-2 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>

            <div>
              <label htmlFor="activity-center-cost-driver" className="block text-sm font-medium text-gray-700 mb-1">成本动因类型 *</label>
              <select
                id="activity-center-cost-driver"
                value={formData.costDriverType}
                onChange={(e) => setFormData({ ...formData, costDriverType: e.target.value })}
                className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              >
                {costDriverTypes.map(type => (
                  <option key={type.value} value={type.value}>{type.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="activity-center-parent" className="block text-sm font-medium text-gray-700 mb-1">上级作业中心</label>
              <select
                id="activity-center-parent"
                value={formData.parentId}
                onChange={(e) => setFormData({ ...formData, parentId: e.target.value })}
                className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              >
                <option value="">顶级作业中心</option>
                {selectableParentCenters.map(center => (
                  <option key={center.id} value={center.id}>{center.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="activity-center-status" className="block text-sm font-medium text-gray-700 mb-1">状态</label>
              <select
                id="activity-center-status"
                value={formData.status}
                onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              >
                <option value="active">启用</option>
                <option value="inactive">禁用</option>
              </select>
            </div>

            <div>
              <label htmlFor="activity-center-sort-order" className="block text-sm font-medium text-gray-700 mb-1">排序</label>
              <input
                id="activity-center-sort-order"
                type="number"
                value={formData.sortOrder}
                onChange={(e) => setFormData({ ...formData, sortOrder: parseInt(e.target.value) || 0 })}
                className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
            <button
              onClick={() => setShowDialog(false)}
              className="h-10 px-4 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="h-10 px-4 text-sm text-white bg-[#3b82f6] rounded-md hover:bg-blue-600 transition-colors"
            >
              {editingCenter ? '更新' : '创建'}
            </button>
          </div>
        </Modal>
      )}

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        open={showDeleteConfirm}
        title="确认删除"
        description="确定要删除此作业中心吗？删除后无法恢复。"
        confirmText="确认删除"
        onConfirm={handleDeleteConfirm}
        onCancel={() => {
          setShowDeleteConfirm(false)
          setDeletingId(null)
        }}
      />
    </div>
  )
}
