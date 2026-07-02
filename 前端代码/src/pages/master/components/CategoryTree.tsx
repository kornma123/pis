import { ChevronRight, ChevronDown, Folder, Circle, Plus, Edit2, Trash2, Search, X } from 'lucide-react'
import type { Category } from '@/types'

interface Props {
  tree: Category[]
  loading: boolean
  expandedIds: Set<string>
  selectedId: string | null
  searchKeyword: string
  onToggleExpand: (id: string) => void
  onSelectNode: (id: string) => void
  onSearchKeywordChange: (v: string) => void
  onOpenCreate: (parentId: string | null, level: number) => void
  onOpenEdit: (node: Category) => void
  onOpenDelete: (node: Category) => void
  onContextMenu: (e: React.MouseEvent, node: Category) => void
  filterMatch: (node: Category) => boolean
}

function TreeNodeItem({
  node,
  depth,
  expandedIds,
  selectedId,
  searchKeyword,
  onToggleExpand,
  onSelectNode,
  onOpenCreate,
  onOpenEdit,
  onOpenDelete,
  onContextMenu,
  filterMatch,
}: {
  node: Category
  depth: number
  expandedIds: Set<string>
  selectedId: string | null
  searchKeyword: string
  onToggleExpand: (id: string) => void
  onSelectNode: (id: string) => void
  onOpenCreate: (parentId: string | null, level: number) => void
  onOpenEdit: (node: Category) => void
  onOpenDelete: (node: Category) => void
  onContextMenu: (e: React.MouseEvent, node: Category) => void
  filterMatch: (node: Category) => boolean
}) {
  const hasChildren = node.children && node.children.length > 0
  const isExpanded = expandedIds.has(node.id)
  const isSelected = selectedId === node.id
  const matched = filterMatch(node)

  if (searchKeyword.trim() && !matched) return null

  return (
    <div>
      <div
        className={`group flex items-center gap-2 py-2.5 pr-3 cursor-pointer transition-colors select-none ${
          isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'
        }`}
        style={{ paddingLeft: `${depth * 20 + 12}px` }}
        onClick={() => onSelectNode(node.id)}
        onContextMenu={e => onContextMenu(e, node)}
      >
        <button
          className={`w-5 h-5 flex items-center justify-center rounded hover:bg-gray-200 transition-colors ${hasChildren ? '' : 'invisible'}`}
          onClick={e => { e.stopPropagation(); onToggleExpand(node.id) }}
        >
          {isExpanded
            ? <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
            : <ChevronRight className="w-3.5 h-3.5 text-gray-500" />
          }
        </button>
        {node.level === 3
          ? <Circle className="w-3.5 h-3.5 text-blue-400" />
          : <Folder className="w-4 h-4 text-blue-500" />
        }
        <span className={`text-sm flex-1 truncate ${isSelected ? 'font-semibold text-blue-700' : 'text-gray-700'}`}>
          {node.name}
        </span>
        <span className="text-xs text-gray-400">{node.count || 0}</span>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {node.level < 3 && (
            <button
              onClick={e => { e.stopPropagation(); onOpenCreate(node.id, node.level + 1) }}
              className="p-1 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded"
              title="添加子分类"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={e => { e.stopPropagation(); onOpenEdit(node) }}
            className="p-1 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded"
            title="编辑"
          >
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          {!hasChildren && (
            <button
              onClick={e => { e.stopPropagation(); onOpenDelete(node) }}
              className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"
              title="删除"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      {hasChildren && isExpanded && (
        <div>
          {node.children!.map(child => (
            <TreeNodeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              selectedId={selectedId}
              searchKeyword={searchKeyword}
              onToggleExpand={onToggleExpand}
              onSelectNode={onSelectNode}
              onOpenCreate={onOpenCreate}
              onOpenEdit={onOpenEdit}
              onOpenDelete={onOpenDelete}
              onContextMenu={onContextMenu}
              filterMatch={filterMatch}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function CategoryTree({
  tree,
  loading,
  expandedIds,
  selectedId,
  searchKeyword,
  onToggleExpand,
  onSelectNode,
  onSearchKeywordChange,
  onOpenCreate,
  onOpenEdit,
  onOpenDelete,
  onContextMenu,
  filterMatch,
}: Props) {
  return (
    <div className="w-[380px] flex-shrink-0 bg-white rounded-lg border border-gray-200 flex flex-col shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <h3 className="text-sm font-semibold text-gray-900">分类目录</h3>
      </div>
      <div className="p-3 border-b border-gray-200">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="搜索分类名称..."
            value={searchKeyword}
            onChange={e => onSearchKeywordChange(e.target.value)}
            className="w-full pl-9 pr-8 py-2 border border-gray-300 rounded-md text-sm outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
          />
          {searchKeyword && (
            <button
              onClick={() => onSearchKeywordChange('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">加载中...</div>
        ) : tree.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">暂无分类数据</div>
        ) : searchKeyword.trim() && !tree.some(filterMatch) ? (
          <div className="p-8 text-center text-gray-400 text-sm">未找到匹配的分类</div>
        ) : (
          tree.map(node => (
            <TreeNodeItem
              key={node.id}
              node={node}
              depth={0}
              expandedIds={expandedIds}
              selectedId={selectedId}
              searchKeyword={searchKeyword}
              onToggleExpand={onToggleExpand}
              onSelectNode={onSelectNode}
              onOpenCreate={onOpenCreate}
              onOpenEdit={onOpenEdit}
              onOpenDelete={onOpenDelete}
              onContextMenu={onContextMenu}
              filterMatch={filterMatch}
            />
          ))
        )}
      </div>
    </div>
  )
}
