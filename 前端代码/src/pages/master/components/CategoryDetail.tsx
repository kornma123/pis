import { Folder, ChevronRight, Plus, Edit2 } from 'lucide-react'
import type { Category } from '@/types'

interface Props {
  node: Category | null
  breadcrumb: Category[]
  onEdit: (node: Category) => void
  onAddChild: (parentId: string, level: number) => void
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
      status === 'active' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-600'
    }`}>
      {status === 'active' ? '已启用' : '已停用'}
    </span>
  )
}

export function CategoryDetail({ node, breadcrumb, onEdit, onAddChild }: Props) {
  if (!node) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-16 text-center">
        <div className="w-14 h-14 rounded-full bg-gray-50 flex items-center justify-center mb-4">
          <Folder className="w-7 h-7 text-gray-300" />
        </div>
        <div className="text-base font-medium text-gray-900">选择分类查看详情</div>
        <p className="text-sm text-gray-500 mt-1 max-w-xs">从左侧分类树中点击任意分类，查看该分类下的物料信息和统计数据</p>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-lg font-semibold text-gray-900">{node.name}</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onEdit(node)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 text-sm transition-colors"
          >
            <Edit2 className="w-3.5 h-3.5" />
            编辑
          </button>
          {node.level < 3 && (
            <button
              onClick={() => onAddChild(node.id, node.level + 1)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              添加子分类
            </button>
          )}
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-sm text-gray-500 mb-5 flex-wrap">
        {breadcrumb.map((item, idx, arr) => (
          <span key={item.id} className="flex items-center gap-1">
            <span className={idx === arr.length - 1 ? 'text-gray-900 font-medium' : ''}>{item.name}</span>
            {idx < arr.length - 1 && <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
          </span>
        ))}
      </div>

      {/* Basic Info */}
      <div className="mb-6">
        <h4 className="text-sm font-semibold text-gray-900 mb-3">基本信息</h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 bg-gray-50 rounded-lg p-4">
          <div>
            <div className="text-xs text-gray-500 mb-1">分类名称</div>
            <div className="text-sm font-medium text-gray-900">{node.name}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">分类编码</div>
            <div className="text-sm font-mono text-gray-900">{node.code}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">分类层级</div>
            <div className="text-sm text-gray-900">
              {node.level === 1 ? '一级分类' : node.level === 2 ? '二级分类' : '三级分类'}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">物料数量</div>
            <div className="text-sm text-gray-900">{node.count || 0}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">状态</div>
            <div><StatusBadge status={node.status} /></div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">排序</div>
            <div className="text-sm text-gray-900">{node.sortOrder ?? 0}</div>
          </div>
        </div>
      </div>

      {/* Associated materials */}
      <div>
        <h4 className="text-sm font-semibold text-gray-900 mb-3">关联物料</h4>
        <div className="bg-gray-50 rounded-lg p-8 text-center">
          <div className="text-sm text-gray-500">该分类下共 {node.count || 0} 个物料</div>
          <p className="text-xs text-gray-400 mt-1">物料详情可在库存列表中查看</p>
        </div>
      </div>
    </div>
  )
}
