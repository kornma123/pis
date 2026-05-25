import { X, Plus } from 'lucide-react'
import type { typeOptions } from '../hooks/useLocationsPage'

interface Props {
  open: boolean
  levelTab: string
  levelConfigs: Record<string, string[]>
  onClose: () => void
  onChangeTab: (tab: string) => void
  onChangeConfigs: (configs: Record<string, string[]>) => void
  onSave: () => void
}

export function LevelConfigModal({ open, levelTab, levelConfigs, onClose, onChangeTab, onChangeConfigs, onSave }: Props) {
  if (!open) return null

  const currentLevels = levelConfigs[levelTab] || []

  const updateLevel = (index: number, value: string) => {
    const next = { ...levelConfigs }
    next[levelTab] = [...next[levelTab]]
    next[levelTab][index] = value
    onChangeConfigs(next)
  }

  const removeLevel = (index: number) => {
    const next = { ...levelConfigs }
    next[levelTab] = next[levelTab].filter((_, idx) => idx !== index)
    onChangeConfigs(next)
  }

  const addLevel = () => {
    const next = { ...levelConfigs }
    next[levelTab] = [...next[levelTab], `第${next[levelTab].length + 1}层`]
    onChangeConfigs(next)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">库位层级配置</h3>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-900 rounded-md transition-all">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div className="p-3 bg-blue-50 rounded-lg text-sm text-blue-800">
            <strong>提示：</strong>层级配置修改后，需要重新调整库位结构。建议在初始化时设置好层级。
          </div>
          <div className="flex gap-2 border-b border-gray-200 pb-2">
            {typeOptions.map(t => (
              <button
                key={t.value}
                onClick={() => onChangeTab(t.value)}
                className={`px-3 py-1.5 text-sm rounded-t-md transition-colors ${
                  levelTab === t.value
                    ? 'text-blue-500 border-b-2 border-blue-500 font-medium'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="space-y-2">
            {currentLevels.map((level, i) => (
              <div key={i} className="flex items-center gap-3 p-3 border border-gray-200 rounded-md">
                <span className="text-gray-400 text-xs">⋮⋮</span>
                <span className="text-sm font-medium w-12">第{i + 1}层</span>
                <input
                  value={level}
                  onChange={e => updateLevel(i, e.target.value)}
                  className="flex-1 h-9 px-3 border border-gray-300 rounded-md text-sm outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
                />
                {currentLevels.length > 1 && (
                  <button
                    onClick={() => removeLevel(i)}
                    className="p-1.5 hover:bg-red-50 text-gray-400 hover:text-red-500 rounded transition-colors"
                    title="删除层级"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <button
            onClick={addLevel}
            className="w-full h-10 inline-flex items-center justify-center gap-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300 transition-colors"
          >
            <Plus className="w-4 h-4" />
            添加层级
          </button>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">
            取消
          </button>
          <button onClick={onSave} className="h-10 px-4 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 transition-colors">
            保存配置
          </button>
        </div>
      </div>
    </div>
  )
}
