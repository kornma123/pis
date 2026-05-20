import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogIn, Lock, User, Eye, EyeOff } from 'lucide-react'
import request from '@/api/request'
import { toast } from 'sonner'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({})
  const navigate = useNavigate()

  // 已登录用户自动重定向到首页
  useEffect(() => {
    const token = localStorage.getItem('token')
    if (token) {
      navigate('/')
    }
  }, [navigate])

  const validate = () => {
    const newErrors: { username?: string; password?: string } = {}
    if (!username.trim()) {
      newErrors.username = '请输入用户名'
    }
    if (!password.trim()) {
      newErrors.password = '请输入密码'
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return

    setLoading(true)
    try {
      const res: any = await request.post('/auth/login', { username, password })
      if (res.token) {
        localStorage.setItem('token', res.token)
        localStorage.setItem('refreshToken', res.refreshToken)
        if (res.user) {
          localStorage.setItem('user', JSON.stringify(res.user))
        }
        if (rememberMe) {
          localStorage.setItem('rememberUsername', username)
        } else {
          localStorage.removeItem('rememberUsername')
        }
        toast.success('登录成功')
        navigate('/')
      }
    } catch (e) {
      toast.error('登录失败，请检查用户名和密码')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* 左侧品牌区域 */}
      <div className="hidden lg:flex lg:w-[45%] xl:w-[40%] flex-col justify-between relative overflow-hidden"
        style={{ background: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)' }}
      >
        <div className="relative z-10 p-12">
          <div className="flex items-center gap-3 mb-8">
            <svg width="40" height="40" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="white" />
              <path d="M8 16L14 10L20 16L14 22L8 16Z" fill="#3b82f6" />
              <path d="M14 16L20 10L26 16L20 22L14 16Z" fill="#3b82f6" opacity="0.6" />
            </svg>
            <span className="text-white text-xl font-semibold tracking-tight">COREONE</span>
          </div>
          <h2 className="text-white text-3xl font-semibold leading-tight mb-4">
            病理实验室<br />耗材管理系统
          </h2>
          <p className="text-white/80 text-base leading-relaxed max-w-sm">
            精准管理每一次入库与出库，<br />
            让实验室运营更高效、更透明。
          </p>
        </div>

        <div className="relative z-10 p-12">
          <div className="flex items-center gap-6 text-white/60 text-sm">
            <span>v2.2</span>
            <span className="w-1 h-1 rounded-full bg-white/40" />
            <span>Medical Grade</span>
            <span className="w-1 h-1 rounded-full bg-white/40" />
            <span>ISO 15189</span>
          </div>
        </div>

        {/* 装饰圆 */}
        <div className="absolute top-[-20%] right-[-10%] w-[400px] h-[400px] rounded-full bg-white/5" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[300px] h-[300px] rounded-full bg-white/5" />
      </div>

      {/* 右侧登录表单区域 */}
      <div className="flex-1 flex items-center justify-center p-6" style={{ background: '#f9fafb' }}>
        <div className="w-full max-w-[420px]">
          {/* 移动端Logo */}
          <div className="lg:hidden flex items-center justify-center gap-3 mb-10">
            <svg width="36" height="36" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="#3b82f6" />
              <path d="M8 16L14 10L20 16L14 22L8 16Z" fill="white" />
              <path d="M14 16L20 10L26 16L20 22L14 16Z" fill="white" opacity="0.6" />
            </svg>
            <span className="text-[#111827] text-lg font-semibold">COREONE</span>
          </div>

          <div className="bg-white rounded-lg p-8 shadow-sm" style={{ boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)' }}>
            <div className="mb-8">
              <h1 className="text-[22px] font-semibold text-[#111827] leading-tight mb-2">
                欢迎回来
              </h1>
              <p className="text-sm text-[#6b7280]">
                请登录您的账户以继续操作
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              {/* 用户名 */}
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">
                  用户名
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[#9ca3af]" />
                  <input
                    type="text"
                    value={username}
                    onChange={e => {
                      setUsername(e.target.value)
                      if (errors.username) setErrors(prev => ({ ...prev, username: undefined }))
                    }}
                    placeholder="请输入用户名"
                    className={`w-full h-10 pl-10 pr-4 text-sm rounded-md border transition-all duration-150 ease outline-none
                      ${errors.username
                        ? 'border-[#ef4444] focus:border-[#ef4444] focus:shadow-[0_0_0_3px_rgba(239,68,68,0.1)]'
                        : 'border-[#d1d5db] focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]'
                      }
                      placeholder:text-[#9ca3af]
                    `}
                    style={{ background: '#ffffff' }}
                  />
                </div>
                {errors.username && (
                  <p className="mt-1.5 text-xs text-[#ef4444]">{errors.username}</p>
                )}
              </div>

              {/* 密码 */}
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">
                  密码
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[#9ca3af]" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => {
                      setPassword(e.target.value)
                      if (errors.password) setErrors(prev => ({ ...prev, password: undefined }))
                    }}
                    placeholder="请输入密码"
                    className={`w-full h-10 pl-10 pr-10 text-sm rounded-md border transition-all duration-150 ease outline-none
                      ${errors.password
                        ? 'border-[#ef4444] focus:border-[#ef4444] focus:shadow-[0_0_0_3px_rgba(239,68,68,0.1)]'
                        : 'border-[#d1d5db] focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]'
                      }
                      placeholder:text-[#9ca3af]
                    `}
                    style={{ background: '#ffffff' }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9ca3af] hover:text-[#6b7280] transition-colors duration-150"
                  >
                    {showPassword ? (
                      <EyeOff className="w-[18px] h-[18px]" />
                    ) : (
                      <Eye className="w-[18px] h-[18px]" />
                    )}
                  </button>
                </div>
                {errors.password && (
                  <p className="mt-1.5 text-xs text-[#ef4444]">{errors.password}</p>
                )}
              </div>

              {/* 记住密码 */}
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={e => setRememberMe(e.target.checked)}
                    className="w-4 h-4 rounded border-[#d1d5db] text-[#3b82f6] focus:ring-[#3b82f6] focus:ring-offset-0 cursor-pointer"
                  />
                  <span className="text-sm text-[#374151]">记住我</span>
                </label>
              </div>

              {/* 登录按钮 */}
              <button
                type="submit"
                disabled={loading}
                className="w-full h-10 flex items-center justify-center gap-2 text-sm font-medium text-white rounded-md transition-all duration-150 ease disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  background: loading ? '#93bbfd' : '#3b82f6',
                  boxShadow: '0 1px 2px rgba(59, 130, 246, 0.1)',
                }}
                onMouseEnter={e => {
                  if (!loading) (e.target as HTMLElement).style.background = '#2563eb'
                }}
                onMouseLeave={e => {
                  if (!loading) (e.target as HTMLElement).style.background = '#3b82f6'
                }}
              >
                {loading ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    登录中...
                  </>
                ) : (
                  <>
                    <LogIn className="w-4 h-4" />
                    登录
                  </>
                )}
              </button>
            </form>

            <div className="mt-6 pt-5 border-t border-[#e5e7eb]">
              <p className="text-xs text-center text-[#9ca3af]">
                登录即表示您同意系统的使用条款和隐私政策
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
