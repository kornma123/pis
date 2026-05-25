const categoryMap: Record<string, { label: string; bg: string; text: string }> = {
  molecular: { label: '分子诊断', bg: 'bg-indigo-50', text: 'text-indigo-600' },
  pathology: { label: '病理技术', bg: 'bg-emerald-50', text: 'text-emerald-600' },
  cyto: { label: '细胞学', bg: 'bg-amber-50', text: 'text-amber-600' },
  ihc: { label: '免疫组化', bg: 'bg-rose-50', text: 'text-rose-600' },
  consumable: { label: '耗材', bg: 'bg-gray-100', text: 'text-gray-600' },
}

interface Props {
  category: string
}

export function CategoryTag({ category }: Props) {
  const cfg = categoryMap[category] || { label: '其他', bg: 'bg-gray-100', text: 'text-gray-600' }
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cfg.bg} ${cfg.text}`}>
      {cfg.label}
    </span>
  )
}
