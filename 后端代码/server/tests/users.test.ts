/**
 * TS-02 用户管理 — 测试场景
 * 运行: cd 后端代码/server && npx tsx tests/users.test.ts
 */

import { getJSON, postJSON, putJSON, delJSON, login, generateUnique } from './setup.js'

function assertEqual(actual: any, expected: any, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`)
}

function assertTrue(value: any, msg: string) {
  if (!value) throw new Error(`${msg}: got ${value}`)
}

async function run() {
  let passed = 0, failed = 0
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`✅ ${name}`); passed++ }
    catch (e: any) { console.log(`❌ ${name}: ${e.message}`); failed++ }
  }

  const adminToken = await login('admin', 'admin123')
  const whmToken = await login('cangguan', 'CoreOne2026!')
  const techToken = await login('jishuyuan1', 'CoreOne2026!')

  const uniqueUser = generateUnique('testuser')

  await test('USER-01 admin获取用户列表', async () => {
    const res = await getJSON('/users?page=1&pageSize=10', adminToken)
    assertTrue(res.success, 'success')
    assertTrue(res.data.list.length > 0, 'has users')
    assertTrue(res.data.pagination.total, 'has pagination')
  })

  await test('USER-03 keyword搜索', async () => {
    const res = await getJSON('/users?keyword=admin', adminToken)
    assertTrue(res.success, 'success')
    assertTrue(res.data.list.length >= 1, 'found admin')
  })

  await test('USER-04 创建用户', async () => {
    const res = await postJSON('/users', { username: uniqueUser, password: 'User-N7v!Q2m@R8x#', realName: '测试用户', role: 'technician' }, adminToken)
    assertTrue(res.success, 'success')
    assertTrue(res.data.id, 'has id')
  })

  await test('USER-11 重复用户名409', async () => {
    try {
      await postJSON('/users', { username: uniqueUser, password: 'User-T4k%Z9p&L3d^', realName: '测试用户2', role: 'technician' }, adminToken)
      throw new Error('should fail')
    } catch (e: any) {
      assertTrue(e.message.includes('409') || e.message.includes('exists'), 'should be 409')
    }
  })

  await test('USER-12 缺少username返回400', async () => {
    try {
      await postJSON('/users', { password: 'User-B6y*C1w(H5s)', realName: '测试用户' }, adminToken)
      throw new Error('should fail')
    } catch (e: any) {
      assertTrue(e.message.includes('400') || e.message.includes('required'), 'should be 400')
    }
  })

  await test('USER-15 编辑不存在的用户返回404', async () => {
    try {
      await putJSON('/users/non-existent-id', { realName: '修改' }, adminToken)
      throw new Error('should fail')
    } catch (e: any) {
      assertTrue(e.message.includes('404') || e.message.includes('not found') || e.message.includes('Not found'), 'should be 404')
    }
  })

  await test('USER-17 WHM访问用户列表返回403', async () => {
    try {
      await getJSON('/users', whmToken)
      throw new Error('should fail')
    } catch (e: any) {
      assertTrue(e.message.includes('403') || e.message.includes('Forbidden'), 'should be 403')
    }
  })

  await test('USER-18 TECH访问用户列表返回403', async () => {
    try {
      await getJSON('/users', techToken)
      throw new Error('should fail')
    } catch (e: any) {
      assertTrue(e.message.includes('403') || e.message.includes('Forbidden'), 'should be 403')
    }
  })

  // 清理
  await test('USER-09 删除用户', async () => {
    const users = await getJSON(`/users?keyword=${uniqueUser}`, adminToken)
    const userId = users.data.list[0]?.id
    if (!userId) throw new Error('User not found')
    const res = await delJSON(`/users/${userId}`, adminToken)
    assertTrue(res.success, 'delete success')
  })

  console.log(`\n📊 Users Test Results: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

run()
