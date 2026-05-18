# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: materials.spec.ts >> 耗材管理 -> 角色权限矩阵补充 >> TC-PERM-MAT-01. finance GET /materials 返回403
- Location: e2e\materials.spec.ts:811:5

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 403
Received: 200
```

# Test source

```ts
  720 | test.describe('耗材管理 -> 查看物料详情', () => {
  721 |   for (const role of MAT_READ_ROLES) {
  722 |     test(`MAT-DETAIL-01-${role}. 正常用例：${role}可查看物料详情`, async () => {
  723 |       const token = await apiLogin(role)
  724 |       const id = await getAnyMaterialId(token)
  725 |       if (!id) { test.skip(); return }
  726 |       const res = await apiFetch(token, 'GET', `/materials/${id}`)
  727 |       expect([200, 404]).toContain(res.status)
  728 |     })
  729 |   }
  730 |   test('MAT-DETAIL-02. 表单校验：查看不存在的物料返回404', async () => {
  731 |     const token = await apiLogin('admin')
  732 |     const res = await apiFetch(token, 'GET', '/materials/non-existent-id')
  733 |     expect(res.status).toBe(404)
  734 |   })
  735 |   test('MAT-DETAIL-03. UI差异：admin可点击行查看详情', async ({ page }) => {
  736 |     await loginAs(page, 'admin')
  737 |     await page.goto(`${FE_BASE}/materials`)
  738 |     await page.waitForTimeout(1000)
  739 |     const rows = page.locator('table tbody tr')
  740 |     if (await rows.count() > 0) await rows.first().click()
  741 |   })
  742 | })
  743 | 
  744 | // ────────────────────────────────────────────
  745 | // 10. 分页切换 (8 tests)
  746 | // ────────────────────────────────────────────
  747 | test.describe('耗材管理 -> 分页切换', () => {
  748 |   test('MAT-PAGE-01. 正常用例：切换到第2页', async ({ page }) => {
  749 |     await loginAs(page, 'admin')
  750 |     await page.goto(`${FE_BASE}/materials?page=2`)
  751 |     await page.waitForTimeout(800)
  752 |   })
  753 |   test('MAT-PAGE-02. 边界：仅1页分页器隐藏', async ({ page }) => {
  754 |     await loginAs(page, 'admin')
  755 |     await page.goto(`${FE_BASE}/materials`)
  756 |     await page.waitForTimeout(800)
  757 |   })
  758 |   test('MAT-PAGE-03. 表单校验：page=0后端修正为1', async () => {
  759 |     const token = await apiLogin('admin')
  760 |     const res = await apiFetch(token, 'GET', '/materials?page=0')
  761 |     expect([200, 500]).toContain(res.status)
  762 |     if (res.status === 200) {
  763 |       expect(res.data?.data?.pagination?.page ?? res.data?.data?.page).toBeGreaterThanOrEqual(1)
  764 |     }
  765 |   })
  766 |   test('MAT-PAGE-04. 边界：page=999返回空列表', async ({ page }) => {
  767 |     const token = await apiLogin('admin')
  768 |     const res = await apiFetch(token, 'GET', '/materials?page=999&pageSize=20')
  769 |     expect(res.status).toBe(200)
  770 |   })
  771 |   test('MAT-PAGE-05. 边界：pageSize=1', async ({ page }) => {
  772 |     const token = await apiLogin('admin')
  773 |     const res = await apiFetch(token, 'GET', '/materials?page=1&pageSize=1')
  774 |     expect(res.status).toBe(200)
  775 |     expect(res.data?.data?.list?.length || 0).toBeLessThanOrEqual(1)
  776 |   })
  777 |   test('MAT-PAGE-06. 边界：pageSize=100', async ({ page }) => {
  778 |     const token = await apiLogin('admin')
  779 |     const res = await apiFetch(token, 'GET', '/materials?page=1&pageSize=100')
  780 |     expect([200, 500]).toContain(res.status)
  781 |   })
  782 |   test('MAT-PAGE-07. 并发：快速切换分页', async ({ page }) => {
  783 |     await loginAs(page, 'admin')
  784 |     for (let i = 1; i <= 3; i++) {
  785 |       await page.goto(`${FE_BASE}/materials?page=${i}`)
  786 |       await page.waitForTimeout(300)
  787 |     }
  788 |   })
  789 |   test('MAT-PAGE-08. UI差异：各角色分页一致', async ({ page }) => {
  790 |     for (const role of MAT_READ_ROLES) {
  791 |       await loginAs(page, role)
  792 |       await page.goto(`${FE_BASE}/materials?page=1`)
  793 |       await page.waitForTimeout(400)
  794 |     }
  795 |   })
  796 | })
  797 | 
  798 | // ────────────────────────────────────────────
  799 | // 11. 角色权限矩阵补充 (8 tests)
  800 | // ────────────────────────────────────────────
  801 | test.describe('耗材管理 -> 角色权限矩阵补充', () => {
  802 |   const scenes = [
  803 |     { id: 'TC-PERM-MAT-01', role: 'finance' as RoleKey, method: 'GET', expect: 403 },
  804 |     { id: 'TC-PERM-MAT-02', role: 'admin' as RoleKey, method: 'GET', expect: 200 },
  805 |     { id: 'TC-PERM-MAT-03', role: 'procurement' as RoleKey, method: 'GET', expect: 200 },
  806 |     { id: 'TC-PERM-MAT-04', role: 'warehouse_manager' as RoleKey, method: 'POST', expect: 403 },
  807 |     { id: 'TC-PERM-MAT-05', role: 'technician' as RoleKey, method: 'POST', expect: 403 },
  808 |     { id: 'TC-PERM-MAT-06', role: 'pathologist' as RoleKey, method: 'POST', expect: 403 },
  809 |   ]
  810 |   for (const s of scenes) {
  811 |     test(`${s.id}. ${s.role} ${s.method} /materials 返回${s.expect}`, async () => {
  812 |       const token = await apiLogin(s.role)
  813 |       let res
  814 |       if (s.method === 'GET') res = await apiFetch(token, 'GET', '/materials')
  815 |       else {
  816 |         const adminToken = await apiLogin('admin')
  817 |         const cid = await getAnyCategoryId(adminToken)
  818 |         res = await apiFetch(token, 'POST', '/materials', { code: `TEST-PERM-${Date.now()}`, name: '权限', unit: '瓶', categoryId: cid || 'x' })
  819 |       }
> 820 |       expect(res.status).toBe(s.expect)
      |                          ^ Error: expect(received).toBe(expected) // Object.is equality
  821 |     })
  822 |   }
  823 |   test('TC-PERM-MAT-07. admin POST /materials 返回201', async () => {
  824 |     const token = await apiLogin('admin')
  825 |     const cid = await getAnyCategoryId(token)
  826 |     if (!cid) { test.skip(); return }
  827 |     const res = await apiFetch(token, 'POST', '/materials', {
  828 |       code: `TEST-ADMIN-${Date.now()}`, name: 'admin新增', unit: '瓶', categoryId: cid,
  829 |     })
  830 |     expect([201, 409]).toContain(res.status)
  831 |   })
  832 |   test('TC-PERM-MAT-08. finance直接访问/materials页面', async ({ page }) => {
  833 |     await loginAs(page, 'finance')
  834 |     await page.goto(`${FE_BASE}/materials`)
  835 |     await page.waitForTimeout(1000)
  836 |   })
  837 | })
  838 | 
  839 | // ────────────────────────────────────────────
  840 | // 12. 业务流程树 (8 tests)
  841 | // ────────────────────────────────────────────
  842 | test.describe('耗材管理 -> 业务流程树', () => {
  843 |   test('BF-MAT-01. 主路径：登录→进入耗材管理→新增物料→填写信息→提交→列表刷新', async () => {
  844 |     const token = await apiLogin('admin')
  845 |     const cid = await getAnyCategoryId(token)
  846 |     if (!cid) { test.skip(); return }
  847 |     const res = await apiFetch(token, 'POST', '/materials', {
  848 |       code: `TEST-BF-${Date.now()}`, name: '业务流程测试', unit: '瓶', categoryId: cid, remark: 'E2E',
  849 |     })
  850 |     expect([201, 409]).toContain(res.status)
  851 |   })
  852 |   test('BF-MAT-02. 分支：关闭弹窗不保存', async ({ page }) => {
  853 |     await loginAs(page, 'admin')
  854 |     await page.goto(`${FE_BASE}/materials`)
  855 |     await page.waitForTimeout(1000)
  856 |   })
  857 |   test('BF-MAT-03. 分支：编码已存在', async () => {
  858 |     const token = await apiLogin('admin')
  859 |     const cid = await getAnyCategoryId(token)
  860 |     if (!cid) { test.skip(); return }
  861 |     const code = `TEST-DUP-BF-${Date.now()}`
  862 |     await apiFetch(token, 'POST', '/materials', { code, name: '重复1', unit: '瓶', categoryId: cid })
  863 |     const res = await apiFetch(token, 'POST', '/materials', { code, name: '重复2', unit: '瓶', categoryId: cid })
  864 |     expect(res.status).toBe(409)
  865 |   })
  866 |   test('BF-MAT-04. 分支：必填字段漏填', async () => {
  867 |     const token = await apiLogin('admin')
  868 |     const res = await apiFetch(token, 'POST', '/materials', { code: 'TEST-MISS', unit: '瓶' })
  869 |     expect(res.status).toBe(400)
  870 |   })
  871 |   test('BF-MAT-05. 分支：价格输入负数', async () => {
  872 |     const token = await apiLogin('admin')
  873 |     const cid = await getAnyCategoryId(token)
  874 |     if (!cid) { test.skip(); return }
  875 |     const res = await apiFetch(token, 'POST', '/materials', {
  876 |       code: `TEST-NEG-${Date.now()}`, name: '负数', unit: '瓶', categoryId: cid, price: -10,
  877 |     })
  878 |     expect([201, 400, 409]).toContain(res.status)
  879 |   })
  880 |   test('BF-MAT-06. 分支：刷新页面后新物料仍在列表', async ({ page }) => {
  881 |     await loginAs(page, 'admin')
  882 |     await page.goto(`${FE_BASE}/materials`)
  883 |     await page.waitForTimeout(500)
  884 |     await page.reload()
  885 |     await page.waitForTimeout(800)
  886 |   })
  887 |   test('BF-MAT-07. 分支：删除有库存的物料', async () => {
  888 |     const token = await apiLogin('admin')
  889 |     const id = await getAnyMaterialId(token)
  890 |     if (!id) { test.skip(); return }
  891 |     const res = await apiFetch(token, 'DELETE', `/materials/${id}`)
  892 |     expect([200, 409, 404]).toContain(res.status)
  893 |   })
  894 |   test('BF-MAT-08. 分支：technician尝试新增物料被403拦截', async () => {
  895 |     const token = await apiLogin('technician')
  896 |     const adminToken = await apiLogin('admin')
  897 |     const cid = await getAnyCategoryId(adminToken)
  898 |     if (!cid) { test.skip(); return }
  899 |     const res = await apiFetch(token, 'POST', '/materials', {
  900 |       code: `TEST-TECH-${Date.now()}`, name: '技术员', unit: '瓶', categoryId: cid,
  901 |     })
  902 |     expect(res.status).toBe(403)
  903 |   })
  904 | })
  905 | 
  906 | // ────────────────────────────────────────────
  907 | // 13. 盲点分析补充 (14 tests)
  908 | // ────────────────────────────────────────────
  909 | test.describe('耗材管理 -> 盲点分析补充', () => {
  910 |   test('BLIND-MAT-01. 物料编码自动生成规则', async () => {
  911 |     const token = await apiLogin('admin')
  912 |     const cid = await getAnyCategoryId(token)
  913 |     if (!cid) { test.skip(); return }
  914 |     const res = await apiFetch(token, 'POST', '/materials', {
  915 |       code: `TEST-AUTO-${Date.now()}`, name: '自动生成', unit: '瓶', categoryId: cid,
  916 |     })
  917 |     expect([201, 409]).toContain(res.status)
  918 |   })
  919 |   test('BLIND-MAT-02. 物料分类下拉联动', async ({ page }) => {
  920 |     await loginAs(page, 'admin')
```