interface Props {
  title: string
  data: { label: string; value: number }[]
  color?: string
}

export function SimpleBarChart({ title, data, color = '#3b82f6' }: Props) {
  const max = Math.max(...data.map(d => d.value), 1)

  return (
    <div className="bg-white rounded-lg p-5 border border-gray-200 shadow-sm">
      <h3 className="text-base font-semibold text-gray-900 mb-5">{title}</h3>
      <div className="flex items-end gap-3 h-40">
        {data.map((d, i) => (
          <div key={i} className="flex-1 flex flex-col items-center gap-2">
            <div className="w-full flex flex-col items-center justify-end h-28">
              <span className="text-[10px] text-gray-500 mb-1">{d.value}</span>
              <div
                className="w-full max-w-[28px] rounded-t-sm transition-all duration-500 ease-out"
                style={{
                  height: `${(d.value / max) * 100}%`,
                  background: color,
                  opacity: 0.7 + (i / data.length) * 0.3,
                }}
              />
            </div>
            <span className="text-[11px] text-gray-400">{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
