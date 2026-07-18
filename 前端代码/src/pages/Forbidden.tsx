import { useEffect, useRef } from 'react'
import { ArrowLeft, ShieldX } from 'lucide-react'
import { Link } from 'react-router-dom'

export default function Forbidden() {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <section
      aria-labelledby="forbidden-title"
      className="flex min-h-[60vh] items-center justify-center px-4 py-12"
    >
      <div className="w-full max-w-lg rounded-lg border border-gray-200 bg-white p-8 text-center shadow-sm">
        <div
          aria-hidden="true"
          className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-blue-600"
        >
          <ShieldX className="h-6 w-6" />
        </div>
        <p className="mb-2 text-sm font-semibold text-blue-600">403</p>
        <h1
          id="forbidden-title"
          ref={headingRef}
          tabIndex={-1}
          className="text-2xl font-semibold text-gray-900 outline-none"
        >
          无权访问此页面
        </h1>
        <p className="mt-3 text-sm leading-6 text-gray-600">
          你的账号没有查看这个页面的权限。请返回仪表盘，或联系管理员调整角色权限。
        </p>
        <Link
          to="/"
          className="mx-auto mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-blue-200 bg-white px-4 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/10"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          返回仪表盘
        </Link>
      </div>
    </section>
  )
}
