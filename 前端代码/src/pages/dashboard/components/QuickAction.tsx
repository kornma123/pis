import { ChevronRight } from 'lucide-react'

interface Props {
  label: string
  desc: string
  icon: React.ElementType
  colorClass: string
  bgClass: string
  onClick?: () => void
}

export function QuickAction({ label, desc, icon: Icon, colorClass, bgClass, onClick }: Props) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-4 w-full text-left p-4 rounded-lg border border-gray-200 bg-white shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5 hover:border-blue-500 group"
    >
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${bgClass}`}>
        <Icon className={`w-5 h-5 ${colorClass}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-900 group-hover:text-blue-500 transition-colors">
          {label}
        </p>
        <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
      </div>
      <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-blue-500 transition-colors flex-shrink-0" />
    </button>
  )
}
