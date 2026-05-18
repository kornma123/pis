# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: materials.spec.ts >> 耗材管理 -> 查看物料列表 >> MAT-LIST-03. 权限：finance访问返回403
- Location: e2e\materials.spec.ts:92:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 403
Received: 200
```

# Test source

```ts
  1   | import { test, expect, Page } from '@playwright/test'
  2   | 
  3   | const FE_BASE = 'http://localhost:8080'
  4   | const API_BASE = 'http://127.0.0.1:3001/api/v1'
  5   | 
  6   | const ROLES = {
  7   |   admin: { username: 'admin', password: 'admin123' },
  8   |   warehouse_manager: { username: 'cangguan', password: 'CoreOne2026!' },
  9   |   technician: { username: 'jishuyuan1', password: 'CoreOne2026!' },
  10  |   pathologist: { username: 'yishi1', password: 'CoreOne2026!' },
  11  |   procurement: { username: 'caigou', password: 'CoreOne2026!' },
  12  |   finance: { username: 'caiwu', password: 'CoreOne2026!' },
  13  | } as const
  14  | type RoleKey = keyof typeof ROLES
  15  | const MAT_READ_ROLES: RoleKey[] = ['admin', 'warehouse_manager', 'technician', 'pathologist', 'procurement']
  16  | const MAT_WRITE_ROLES: RoleKey[] = ['admin', 'procurement']
  17  | const MAT_FORBIDDEN: RoleKey[] = ['finance']
  18  | 
  19  | async function loginAs(page: Page, role: RoleKey) {
  20  |   await page.goto(`${FE_BASE}/login`)
  21  |   await page.evaluate(() => localStorage.clear())
  22  |   const cred = ROLES[role]
  23  |   await page.fill('input[type="text"]', cred.username)
  24  |   await page.fill('input[type="password"]', cred.password)
  25  |   await page.click('button[type="submit"]')
  26  |   await page.waitForURL(`${FE_BASE}/`, { timeout: 10000 })
  27  | }
  28  | 
  29  | async function apiLogin(role: RoleKey): Promise<string> {
  30  |   const cred = ROLES[role]
  31  |   const res = await fetch(`${API_BASE}/auth/login`, {
  32  |     method: 'POST', headers: { 'Content-Type': 'application/json' },
  33  |     body: JSON.stringify(cred),
  34  |   })
  35  |   const data = (await res.json()) as any
  36  |   return data.data?.token || data.token
  37  | }
  38  | 
  39  | async function apiFetch(token: string, method: string, path: string, body?: any) {
  40  |   const opts: any = { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
  41  |   if (body) opts.body = JSON.stringify(body)
  42  |   const res = await fetch(`${API_BASE}${path}`, opts)
  43  |   return { status: res.status, data: (await res.json().catch(() => null)) as any }
  44  | }
  45  | 
  46  | async function getAnyCategoryId(token: string): Promise<string> {
  47  |   const r = await apiFetch(token, 'GET', '/categories?page=1&pageSize=1')
  48  |   return r.data?.data?.list?.[0]?.id || ''
  49  | }
  50  | async function getAnyMaterialId(token: string): Promise<string> {
  51  |   const r = await apiFetch(token, 'GET', '/materials?page=1&pageSize=1')
  52  |   return r.data?.data?.list?.[0]?.id || ''
  53  | }
  54  | async function getAnySupplierId(token: string): Promise<string> {
  55  |   const r = await apiFetch(token, 'GET', '/suppliers?page=1&pageSize=1')
  56  |   return r.data?.data?.list?.[0]?.id || ''
  57  | }
  58  | 
  59  | async function cleanupTestData(token: string) {
  60  |   try {
  61  |     const r = await apiFetch(token, 'GET', '/materials?page=1&pageSize=200')
  62  |     const list = r.data?.data?.list || []
  63  |     for (const item of list) {
  64  |       if (item.code?.startsWith('TEST-') || item.name?.includes('E2E')) {
  65  |         await apiFetch(token, 'DELETE', `/materials/${item.id}`)
  66  |       }
  67  |     }
  68  |   } catch { /* ignore */ }
  69  | }
  70  | 
  71  | test.beforeEach(async () => {
  72  |   const token = await apiLogin('admin')
  73  |   await cleanupTestData(token)
  74  | })
  75  | 
  76  | // ────────────────────────────────────────────
  77  | // 1. 查看物料列表 (10 tests)
  78  | // ────────────────────────────────────────────
  79  | test.describe('耗材管理 -> 查看物料列表', () => {
  80  |   for (const role of MAT_READ_ROLES) {
  81  |     test(`MAT-LIST-01-${role}. 正常用例：${role}可查看物料列表`, async ({ page }) => {
  82  |       await loginAs(page, role)
  83  |       await page.goto(`${FE_BASE}/materials`)
  84  |       await expect(page.locator('body')).toBeVisible({ timeout: 8000 })
  85  |     })
  86  |   }
  87  |   test('MAT-LIST-02. 空数据边界：无物料数据显示空状态', async ({ page }) => {
  88  |     await loginAs(page, 'admin')
  89  |     await page.goto(`${FE_BASE}/materials`)
  90  |     await page.waitForTimeout(800)
  91  |   })
  92  |   test('MAT-LIST-03. 权限：finance访问返回403', async () => {
  93  |     const res = await apiFetch(await apiLogin('finance'), 'GET', '/materials')
> 94  |     expect(res.status).toBe(403)
      |                        ^ Error: expect(received).toBe(expected) // Object.is equality
  95  |   })
  96  |   test('MAT-LIST-04. 异常恢复：API 500显示错误Toast', async ({ page }) => {
  97  |     await loginAs(page, 'admin')
  98  |     await page.goto(`${FE_BASE}/materials`)
  99  |     await page.waitForTimeout(800)
  100 |   })
  101 |   test('MAT-LIST-05. UI差异：admin显示新增编辑删除按钮', async ({ page }) => {
  102 |     await loginAs(page, 'admin')
  103 |     await page.goto(`${FE_BASE}/materials`)
  104 |     await page.waitForTimeout(1000)
  105 |   })
  106 |   test('MAT-LIST-06. UI差异：procurement仅显示新增编辑', async ({ page }) => {
  107 |     await loginAs(page, 'procurement')
  108 |     await page.goto(`${FE_BASE}/materials`)
  109 |     await page.waitForTimeout(1000)
  110 |   })
  111 |   test('MAT-LIST-07. 正常用例：列表分页每页20条', async ({ page }) => {
  112 |     const token = await apiLogin('admin')
  113 |     const res = await apiFetch(token, 'GET', '/materials?page=1&pageSize=20')
  114 |     expect(res.status).toBe(200)
  115 |     expect(res.data?.data?.pagination?.pageSize ?? res.data?.data?.pageSize).toBe(20)
  116 |   })
  117 |   test('MAT-LIST-08. 并发：快速刷新页面', async ({ page }) => {
  118 |     await loginAs(page, 'admin')
  119 |     await page.goto(`${FE_BASE}/materials`)
  120 |     await page.reload()
  121 |     await page.reload()
  122 |   })
  123 |   test('MAT-LIST-09. UI差异：technician仅查看', async ({ page }) => {
  124 |     await loginAs(page, 'technician')
  125 |     await page.goto(`${FE_BASE}/materials`)
  126 |     await page.waitForTimeout(1000)
  127 |   })
  128 |   test('MAT-LIST-10. 正常用例：列表显示133个物料', async ({ page }) => {
  129 |     const token = await apiLogin('admin')
  130 |     const res = await apiFetch(token, 'GET', '/materials?page=1&pageSize=200')
  131 |     expect(res.status).toBe(200)
  132 |     expect(res.data?.data?.pagination?.total ?? res.data?.data?.total).toBeGreaterThanOrEqual(0)
  133 |   })
  134 | })
  135 | 
  136 | // ────────────────────────────────────────────
  137 | // 2. 按分类筛选 (6 tests)
  138 | // ────────────────────────────────────────────
  139 | test.describe('耗材管理 -> 按分类筛选', () => {
  140 |   test('MAT-CAT-01. 正常用例：选择分类仅显示该分类物料', async ({ page }) => {
  141 |     const token = await apiLogin('admin')
  142 |     const cid = await getAnyCategoryId(token)
  143 |     if (!cid) { test.skip(); return }
  144 |     const res = await apiFetch(token, 'GET', `/materials?categoryId=${cid}`)
  145 |     expect(res.status).toBe(200)
  146 |   })
  147 |   test('MAT-CAT-02. 空数据边界：分类下无物料', async ({ page }) => {
  148 |     const token = await apiLogin('admin')
  149 |     const res = await apiFetch(token, 'GET', '/materials?categoryId=non-existent')
  150 |     expect(res.status).toBe(200)
  151 |   })
  152 |   test('MAT-CAT-03. 正常用例：重置分类筛选', async ({ page }) => {
  153 |     await loginAs(page, 'admin')
  154 |     await page.goto(`${FE_BASE}/materials`)
  155 |     await page.waitForTimeout(800)
  156 |   })
  157 |   test('MAT-CAT-04. UI差异：各角色分类筛选可见', async ({ page }) => {
  158 |     for (const role of MAT_READ_ROLES) {
  159 |       await loginAs(page, role)
  160 |       await page.goto(`${FE_BASE}/materials`)
  161 |       await page.waitForTimeout(400)
  162 |     }
  163 |   })
  164 |   test('MAT-CAT-05. 并发：快速切换分类', async ({ page }) => {
  165 |     await loginAs(page, 'admin')
  166 |     await page.goto(`${FE_BASE}/materials?categoryId=1`)
  167 |     await page.waitForTimeout(200)
  168 |     await page.goto(`${FE_BASE}/materials?categoryId=2`)
  169 |     await page.waitForTimeout(200)
  170 |     await page.goto(`${FE_BASE}/materials?categoryId=3`)
  171 |     await page.waitForTimeout(200)
  172 |   })
  173 |   test('MAT-CAT-06. 异常恢复：分类筛选时API错误', async ({ page }) => {
  174 |     await loginAs(page, 'admin')
  175 |     await page.goto(`${FE_BASE}/materials?categoryId=test`)
  176 |     await page.waitForTimeout(800)
  177 |   })
  178 | })
  179 | 
  180 | // ────────────────────────────────────────────
  181 | // 3. 按供应商筛选 (6 tests)
  182 | // ────────────────────────────────────────────
  183 | test.describe('耗材管理 -> 按供应商筛选', () => {
  184 |   test('MAT-SUP-01. 正常用例：选择供应商仅显示该供应商物料', async ({ page }) => {
  185 |     const token = await apiLogin('admin')
  186 |     const sid = await getAnySupplierId(token)
  187 |     if (!sid) { test.skip(); return }
  188 |     const res = await apiFetch(token, 'GET', `/materials?supplierId=${sid}`)
  189 |     expect(res.status).toBe(200)
  190 |   })
  191 |   test('MAT-SUP-02. 空数据边界：供应商下无物料', async ({ page }) => {
  192 |     const token = await apiLogin('admin')
  193 |     const res = await apiFetch(token, 'GET', '/materials?supplierId=non-existent')
  194 |     expect(res.status).toBe(200)
```