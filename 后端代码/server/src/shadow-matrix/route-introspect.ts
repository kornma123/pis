/**
 * 权限影子断言矩阵 —— 运行时路由自省（端点集合的**地面真相**）。
 *
 * 终裁要求 3：端点清单地面真相 = **运行时路由器自省**（不是注册表/手工声明），两侧都和它对账——
 *   防「端点级迁移弄丢从两边同时消失 → 无 diff 假绿」。这里走 Express 的 app._router.stack，
 *   枚举实际挂载的 (method, 完整路径)，与静态守卫解析（source-parsers）解耦：集合取运行时、语义取静态。
 *
 * 注：Express 4 里 requirePermission 闭包是匿名的（probe 实证 name==''），故这里**只取端点集**、不试图
 *   从运行时链读守卫语义（那交给 source-parsers 静态抽）。运行时有、静态无守卫的端点 → UNGUARDED 待裁。
 */
import { normalizePath, joinPath } from './source-parsers.js'

export interface RuntimeEndpoint {
  method: string
  path: string // 完整归一路径
  key: string // "METHOD /path"
  handleCount: number // 该端点中间件+handler 数（用作静态解析的交叉核对信号）
}

/** Express mount 层 regexp → 前缀路径。形如 ^\/api\/v1\/users\/?(?=\/|$) → /api/v1/users。 */
function regexpToPrefix(rx: RegExp | undefined): string {
  if (!rx) return ''
  let s = rx.source
  s = s.replace(/^\^/, '')
  // 去掉 path-to-regexp 给挂载点加的尾巴：\/?(?=\/|$)
  s = s.replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
  s = s.replace(/\(\?=\\\/\|\$\)$/, '')
  s = s.replace(/\\\/\?$/, '')
  s = s.replace(/\$$/, '')
  s = s.replace(/\\\//g, '/')
  return normalizePath(s || '/')
}

function methodsOf(route: any): string[] {
  const m = route?.methods || {}
  return Object.keys(m).filter((k) => m[k] && k !== '_all').map((k) => k.toUpperCase())
}

function walk(stack: any[], prefix: string, out: RuntimeEndpoint[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const rel = layer.route.path
      // 数组路径（router.get(['/a','/b'])）——展开
      const rels: string[] = Array.isArray(rel) ? rel : [rel]
      const handleCount = (layer.route.stack || []).length
      for (const r of rels) {
        const full = joinPath(prefix, String(r))
        for (const method of methodsOf(layer.route)) {
          out.push({ method, path: full, key: `${method} ${full}`, handleCount })
        }
      }
    } else if (layer.handle && layer.handle.stack) {
      // 挂载的子路由器：从本层 regexp 复原挂载前缀，带入递归
      const sub = regexpToPrefix(layer.regexp)
      const nextPrefix = sub && sub !== '/' ? normalizePath(prefix + sub) : prefix
      walk(layer.handle.stack, nextPrefix, out)
    }
    // 其它顶层中间件（authenticateToken/requirePermission 闭包/auditWrite/cors...）不产端点，忽略。
  }
}

/** 枚举 app 的全部端点（去重按 key）。 */
export function introspectEndpoints(app: any): RuntimeEndpoint[] {
  const router = app?._router || app?.router
  if (!router || !Array.isArray(router.stack)) {
    throw new Error('shadow-matrix: 无法访问 app._router.stack（运行时自省失败）')
  }
  const out: RuntimeEndpoint[] = []
  walk(router.stack, '', out)
  // 去重（同 key 合并，保留最大 handleCount）
  const byKey = new Map<string, RuntimeEndpoint>()
  for (const e of out) {
    const prev = byKey.get(e.key)
    if (!prev || e.handleCount > prev.handleCount) byKey.set(e.key, e)
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
}
