import { ChevronDown, ChevronRight } from 'lucide-react'
import type { TreeNode } from '../hooks/useLocationsPage'
import { getTypeIcon } from '../hooks/useLocationsPage'

interface Props {
  treeData: TreeNode[]
  selectedNodeId: string | null
  expandedIds: Set<string>
  onToggleExpand: (id: string) => void
  onSelectNode: (id: string) => void
  onExpandAll: () => void
  onCollapseAll: () => void
}

function TreeNodeItem({
  node,
  depth,
  selectedNodeId,
  expandedIds,
  onToggleExpand,
  onSelectNode,
}: {
  node: TreeNode
  depth: number
  selectedNodeId: string | null
  expandedIds: Set<string>
  onToggleExpand: (id: string) => void
  onSelectNode: (id: string) => void
}) {
  const hasChildren = node.children && node.children.length > 0
  const isExpanded = expandedIds.has(node.id)

  return (
    <div>
      <div
        className={`flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer text-sm ${
          selectedNodeId === node.id ? 'bg-blue-50 text-blue-500' : 'hover:bg-gray-50 text-gray-700'
        }`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => onSelectNode(node.id)}
      >
        {hasChildren ? (
          <button
            onClick={e => { e.stopPropagation(); onToggleExpand(node.id) }}
            className="p-0.5 hover:bg-gray-200 rounded"
          >
            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        ) : (
          <span className="w-5" />
        )}
        <span className="text-base">{getTypeIcon(node.type)}</span>
        <span className="flex-1">{node.name}</span>
        {hasChildren && <span className="text-xs text-gray-400">{node.children!.length}</span>}
      </div>
      {isExpanded && node.children && (
        <div>
          {node.children.map(child => (
            <TreeNodeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedNodeId={selectedNodeId}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
              onSelectNode={onSelectNode}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function LocationTree({
  treeData,
  selectedNodeId,
  expandedIds,
  onToggleExpand,
  onSelectNode,
  onExpandAll,
  onCollapseAll,
}: Props) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm">
      <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-900">库位结构</span>
        <div className="flex gap-2">
          <button onClick={onExpandAll} className="text-xs text-blue-500 hover:underline">展开</button>
          <button onClick={onCollapseAll} className="text-xs text-gray-500 hover:underline">收起</button>
        </div>
      </div>
      <div className="p-3">
        {treeData.length === 0 ? (
          <div className="text-center text-sm text-gray-400 py-8">暂无库位数据</div>
        ) : (
          treeData.map(node => (
            <TreeNodeItem
              key={node.id}
              node={node}
              depth={0}
              selectedNodeId={selectedNodeId}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
              onSelectNode={onSelectNode}
            />
          ))
        )}
      </div>
    </div>
  )
}
