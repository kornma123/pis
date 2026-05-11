/**
 * 基于角色的功能测试脚本
 * 日期: 2026-05-11
 * 测试目标: 验证各角色的登录、权限和核心功能访问
 */

const BASE_URL = 'http://localhost:3001/api/v1'

interface TestAccount {
  role: string
  username: string
  password: string
  realName: string
  expectedPermissions: string[]
  expectedForbidden: string[]
}

const testAccounts: TestAccount[] = [
  {
    role: 'admin',
    username: 'admin',
    password: 'CoreOne2026!',
    realName: '系统管理员',
    expectedPermissions: ['users', 'roles', 'materials', 'inventory', 'inbound', 'outbound', 'suppliers', 'logs'],
    expectedForbidden: [],
  },
  {
    role: 'warehouse_manager',
    username: 'cangguan',
    password: 'CoreOne2026!',
    realName: '王仓库',
    expectedPermissions: ['inventory', 'inbound', 'outbound', 'materials', 'suppliers'],
    expectedForbidden: ['users', 'roles', 'logs'],
  },
  {
    role: 'technician',
    username: 'jishuyuan1',
    password: 'CoreOne2026!',
    realName: '张技术',
    expectedPermissions: ['inventory', 'outbound'],
    expectedForbidden: ['users', 'roles', 'inbound', 'suppliers', 'logs'],
  },
  {
    role: 'pathologist',
    username: 'yishi1',
    password: 'CoreOne2026!',
    realName: '刘医师',
    expectedPermissions: ['inventory', 'outbound', 'cost-analysis'],
    expectedForbidden: ['users', 'roles', 'inbound', 'suppliers'],
  },
  {
    role: 'procurement',
    username: 'caigou',
    password: 'CoreOne2026!',
    realName: '赵采购',
    expectedPermissions: ['inventory', 'inbound', 'materials', 'suppliers'],
    expectedForbidden: ['users', 'roles', 'outbound', 'logs'],
  },
  {
    role: 'finance',
    username: 'caiwu',
    password: 'CoreOne2026!',
    realName: '孙财务',
    expectedPermissions: ['cost-analysis', 'logs'],
    expectedForbidden: ['inventory', 'inbound', 'outbound', 'materials', 'users', 'roles'],
  },
]

const endpoints: Record<string, string> = {
  'dashboard': '/reports/dashboard',
  'inventory': '/inventory',
  'inbound': '/inbound',
  'outbound': '/outbound',
  'stocktaking': '/stocktaking',
  'categories': '/categories',
  'materials': '/materials',
  'suppliers': '/suppliers',
  'locations': '/locations',
  'projects': '/projects',
  'bom': '/bom',
  'cost-analysis': '/reports/cost-analysis',
  'alerts': '/alerts',
  'users': '/users',
  'roles': '/roles',
  'logs': '/logs',
}

async function login(username: string, password: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const data = await res.json()
    if (data.success && data.data?.token) {
      return data.data.token
    }
    return null
  } catch (e) {
    return null
  }
}

async function testEndpoint(token: string, path: string): Promise<{ status: number; ok: boolean; data?: any }> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json().catch(() => null)
    return { status: res.status, ok: res.ok && data?.success !== false, data }
  } catch (e) {
    return { status: 0, ok: false }
  }
}

function log(msg: string) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] ${msg}`)
}

function divider() {
  console.log('='.repeat(80))
}

async function runTests() {
  log('🧪 基于角色的功能测试开始')
  divider()

  const results: any[] = []

  for (const account of testAccounts) {
    log(`\n📋 测试账号: ${account.realName} [${account.role}]`)
    log(`   用户名: ${account.username}`)
    divider()

    // 1. 登录测试
    log('  [测试1] 登录验证...')
    const token = await login(account.username, account.password)
    if (!token) {
      log(`  ❌ 登录失败: ${account.username}`)
      results.push({ account: account.username, login: 'FAILED', tests: [] })
      continue
    }
    log(`  ✅ 登录成功，Token获取成功`)

    const accountResults: any[] = []

    // 2. 预期可访问的端点测试
    log('  [测试2] 预期可访问功能验证...')
    for (const perm of account.expectedPermissions) {
      const path = endpoints[perm]
      if (!path) continue
      const result = await testEndpoint(token, path)
      const pass = result.ok || result.status === 200
      log(`    ${pass ? '✅' : '❌'} ${perm} (${path}) - HTTP ${result.status}`)
      accountResults.push({ permission: perm, expected: 'allow', actual: pass ? 'allow' : 'deny', status: result.status })
    }

    // 3. 预期不可访问的端点测试
    log('  [测试3] 预期不可访问功能验证...')
    for (const perm of account.expectedForbidden) {
      const path = endpoints[perm]
      if (!path) continue
      const result = await testEndpoint(token, path)
      const denied = !result.ok || result.status === 403 || result.status === 401
      log(`    ${denied ? '✅' : '⚠️'} ${perm} (${path}) - HTTP ${result.status} ${denied ? '(已拦截)' : '(未拦截)'}`)
      accountResults.push({ permission: perm, expected: 'deny', actual: denied ? 'deny' : 'allow', status: result.status })
    }

    results.push({
      account: account.username,
      role: account.role,
      realName: account.realName,
      login: 'SUCCESS',
      tests: accountResults,
    })
  }

  // 汇总
  divider()
  log('📊 测试结果汇总')
  divider()

  let totalTests = 0
  let passedTests = 0

  for (const r of results) {
    if (r.login !== 'SUCCESS') {
      log(`❌ ${r.account}: 登录失败`)
      continue
    }
    const allowTests = r.tests.filter((t: any) => t.expected === 'allow')
    const denyTests = r.tests.filter((t: any) => t.expected === 'deny')
    const allowPassed = allowTests.filter((t: any) => t.actual === 'allow').length
    const denyPassed = denyTests.filter((t: any) => t.actual === 'deny').length

    totalTests += r.tests.length
    passedTests += allowPassed + denyPassed

    log(`\n👤 ${r.realName} [${r.role}]`)
    log(`   登录: ✅`)
    log(`   允许访问测试: ${allowPassed}/${allowTests.length} 通过`)
    log(`   禁止访问测试: ${denyPassed}/${denyTests.length} 通过`)
    log(`   综合: ${allowPassed + denyPassed}/${r.tests.length} 通过`)

    // 列出失败的测试
    const failures = r.tests.filter((t: any) => t.expected !== t.actual)
    if (failures.length > 0) {
      log(`   ⚠️ 异常项:`)
      for (const f of failures) {
        log(`      - ${f.permission}: 期望${f.expected}, 实际${f.actual} (HTTP ${f.status})`)
      }
    }
  }

  divider()
  log(`总计: ${passedTests}/${totalTests} 测试通过 (${Math.round((passedTests / totalTests) * 100)}%)`)
  divider()
  log('🧪 基于角色的功能测试结束')
}

runTests().catch(console.error)
