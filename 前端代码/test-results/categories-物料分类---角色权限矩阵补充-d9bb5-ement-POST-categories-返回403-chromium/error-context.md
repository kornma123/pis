# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: categories.spec.ts >> 物料分类 -> 角色权限矩阵补充 >> TC-PERM-CAT-03. procurement POST /categories 返回403
- Location: e2e\categories.spec.ts:776:5

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 403
Received: 201
```

# Test source

```ts
  679 |     const res = await apiFetch(token, 'GET', '/categories?level=1&page=1&pageSize=1')
  680 |     const id = res.data?.data?.list?.[0]?.id
  681 |     if (!id) return
  682 |     const res2 = await apiFetch(token, 'PUT', `/categories/${id}`, { status: 'inactive' })
  683 |     expect([200, 400]).toContain(res2.status)
  684 |   })
  685 |   test('CAT-STATUS-04. UI差异：停用分类显示灰色标签', async ({ page }) => {
  686 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  687 |     await expect(page.locator('text=/已停用|已启用/i').first()).toBeVisible()
  688 |   })
  689 |   test('CAT-STATUS-05. 正常用例：停用分类后物料仍可查询', async ({ page }) => {
  690 |     const token = await apiLogin('admin')
  691 |     const res = await apiFetch(token, 'GET', '/categories?page=1&pageSize=1')
  692 |     const id = res.data?.data?.list?.[0]?.id
  693 |     if (!id) return
  694 |     await apiFetch(token, 'PUT', `/categories/${id}`, { status: 'inactive' })
  695 |     const matRes = await apiFetch(token, 'GET', `/materials?categoryId=${id}`)
  696 |     expect([200]).toContain(matRes.status)
  697 |   })
  698 |   test('CAT-STATUS-06. 并发：快速切换状态多次', async ({ page }) => {
  699 |     const token = await apiLogin('admin')
  700 |     const createRes = await apiFetch(token, 'POST', '/categories', { name: `测试分类-切换-${Date.now()}`, level: 1 })
  701 |     const id = createRes.data?.data?.id || createRes.data?.id
  702 |     if (!id) return
  703 |     await apiFetch(token, 'PUT', `/categories/${id}`, { status: 'inactive' })
  704 |     await apiFetch(token, 'PUT', `/categories/${id}`, { status: 'active' })
  705 |     await apiFetch(token, 'PUT', `/categories/${id}`, { status: 'inactive' })
  706 |     expect(true).toBe(true)
  707 |   })
  708 | })
  709 | 
  710 | // ───────────────────────────────────────────────
  711 | // 9. 右键菜单
  712 | // ───────────────────────────────────────────────
  713 | test.describe('物料分类 -> 右键菜单', () => {
  714 |   test('CAT-CTX-01. 正常用例：右键点击分类显示上下文菜单', async ({ page }) => {
  715 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  716 |     const catItem = page.locator('text=/分类/i').first()
  717 |     if (await catItem.isVisible().catch(() => false)) {
  718 |       await catItem.click({ button: 'right' }); await page.waitForTimeout(500)
  719 |     }
  720 |   })
  721 |   test('CAT-CTX-02. 正常用例：右键菜单点击编辑打开弹窗', async ({ page }) => {
  722 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  723 |     const catItem = page.locator('text=/分类/i').first()
  724 |     if (await catItem.isVisible().catch(() => false)) {
  725 |       await catItem.click({ button: 'right' }); await page.waitForTimeout(500)
  726 |       const edit = page.locator('text=/编辑/i').first()
  727 |       if (await edit.isVisible().catch(() => false)) { await edit.click(); await page.waitForTimeout(800) }
  728 |     }
  729 |   })
  730 |   test('CAT-CTX-03. 正常用例：右键菜单点击添加子分类', async ({ page }) => {
  731 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  732 |     const catItem = page.locator('text=/分类/i').first()
  733 |     if (await catItem.isVisible().catch(() => false)) {
  734 |       await catItem.click({ button: 'right' }); await page.waitForTimeout(500)
  735 |       const add = page.locator('text=/添加子|新增子/i').first()
  736 |       if (await add.isVisible().catch(() => false)) { await add.click(); await page.waitForTimeout(800) }
  737 |     }
  738 |   })
  739 |   test('CAT-CTX-04. 边界：三级分类右键菜单不显示添加子分类', async ({ page }) => {
  740 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  741 |     await expect(page.locator('body')).toBeVisible()
  742 |   })
  743 |   test('CAT-CTX-05. UI差异：非admin右键点击不显示操作菜单', async ({ page }) => {
  744 |     await loginAs(page, 'technician'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  745 |     const catItem = page.locator('text=/分类/i').first()
  746 |     if (await catItem.isVisible().catch(() => false)) {
  747 |       await catItem.click({ button: 'right' }); await page.waitForTimeout(500)
  748 |     }
  749 |     await expect(page.locator('body')).toBeVisible()
  750 |   })
  751 |   test('CAT-CTX-06. 异常恢复：点击其他地方右键菜单消失', async ({ page }) => {
  752 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  753 |     const catItem = page.locator('text=/分类/i').first()
  754 |     if (await catItem.isVisible().catch(() => false)) {
  755 |       await catItem.click({ button: 'right' }); await page.waitForTimeout(500)
  756 |       await page.click('body'); await page.waitForTimeout(500)
  757 |     }
  758 |   })
  759 | })
  760 | 
  761 | // ───────────────────────────────────────────────
  762 | // 10. 角色权限矩阵补充
  763 | // ───────────────────────────────────────────────
  764 | test.describe('物料分类 -> 角色权限矩阵补充', () => {
  765 |   const permScenes = [
  766 |     { id: 'TC-PERM-CAT-01', role: 'technician' as RoleKey, method: 'POST', path: '/categories', expect: 403 },
  767 |     { id: 'TC-PERM-CAT-02', role: 'pathologist' as RoleKey, method: 'POST', path: '/categories', expect: 403 },
  768 |     { id: 'TC-PERM-CAT-03', role: 'procurement' as RoleKey, method: 'POST', path: '/categories', expect: 403 },
  769 |     { id: 'TC-PERM-CAT-04', role: 'finance' as RoleKey, method: 'POST', path: '/categories', expect: 403 },
  770 |     { id: 'TC-PERM-CAT-05', role: 'warehouse_manager' as RoleKey, method: 'POST', path: '/categories', expect: 403 },
  771 |     { id: 'TC-PERM-CAT-06', role: 'technician' as RoleKey, method: 'PUT', path: '/categories/test-id', expect: 403 },
  772 |     { id: 'TC-PERM-CAT-07', role: 'pathologist' as RoleKey, method: 'DELETE', path: '/categories/test-id', expect: 403 },
  773 |     { id: 'TC-PERM-CAT-08', role: 'procurement' as RoleKey, method: 'PUT', path: '/categories/test-id', expect: 403 },
  774 |   ]
  775 |   for (const scene of permScenes) {
  776 |     test(`${scene.id}. ${scene.role} ${scene.method} ${scene.path} 返回${scene.expect}`, async () => {
  777 |       const token = await apiLogin(scene.role)
  778 |       const res = await apiFetch(token, scene.method, scene.path, scene.method === 'POST' ? { name: 'TEST', level: 1 } : { name: 'test' })
> 779 |       expect(res.status).toBe(scene.expect)
      |                          ^ Error: expect(received).toBe(expected) // Object.is equality
  780 |     })
  781 |   }
  782 |   test('TC-PERM-CAT-09. admin GET /categories/tree 返回200', async () => {
  783 |     const token = await apiLogin('admin')
  784 |     const res = await apiFetch(token, 'GET', '/categories/tree')
  785 |     expect(res.status).toBe(200)
  786 |   })
  787 |   test('TC-PERM-CAT-10. technician GET /categories/tree 返回200', async () => {
  788 |     const token = await apiLogin('technician')
  789 |     const res = await apiFetch(token, 'GET', '/categories/tree')
  790 |     expect(res.status).toBe(200)
  791 |   })
  792 |   test('TC-PERM-CAT-11. admin GET /categories 返回200', async () => {
  793 |     const token = await apiLogin('admin')
  794 |     const res = await apiFetch(token, 'GET', '/categories')
  795 |     expect(res.status).toBe(200)
  796 |   })
  797 |   test('TC-PERM-CAT-12. warehouse_manager GET /categories 返回200', async () => {
  798 |     const token = await apiLogin('warehouse_manager')
  799 |     const res = await apiFetch(token, 'GET', '/categories')
  800 |     expect(res.status).toBe(200)
  801 |   })
  802 | })
  803 | 
  804 | // ───────────────────────────────────────────────
  805 | // 11. 业务流程树
  806 | // ───────────────────────────────────────────────
  807 | test.describe('物料分类 -> 业务流程树', () => {
  808 |   test('BF-CAT-01. 主路径：创建一级→二级→三级分类', async ({ page }) => {
  809 |     const token = await apiLogin('admin')
  810 |     const p1 = await apiFetch(token, 'POST', '/categories', { name: `测试分类-BF1-${Date.now()}`, level: 1 })
  811 |     const pid1 = p1.data?.data?.id || p1.data?.id
  812 |     expect([200, 201]).toContain(p1.status)
  813 |     if (pid1) {
  814 |       const p2 = await apiFetch(token, 'POST', '/categories', { name: `测试分类-BF2-${Date.now()}`, level: 2, parentId: pid1 })
  815 |       expect([200, 201]).toContain(p2.status)
  816 |     }
  817 |   })
  818 |   test('BF-CAT-02. 分支：创建分类时不填名称被阻止', async ({ page }) => {
  819 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1200)
  820 |     await page.locator('button').filter({ hasText: /^新建分类$/ }).first().click(); await page.waitForTimeout(500)
  821 |     const save = page.locator('.fixed button').filter({ hasText: /^保存$/ }).first()
  822 |     if (await save.isVisible().catch(() => false)) { await save.click(); await page.waitForTimeout(500) }
  823 |   })
  824 |   test('BF-CAT-03. 分支：编辑分类后取消不保存', async ({ page }) => {
  825 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  826 |     const editBtn = page.locator('text=/编辑|修改/i').first()
  827 |     if (await editBtn.isVisible().catch(() => false)) {
  828 |       await editBtn.click(); await page.waitForTimeout(500)
  829 |       const cancel = page.locator('text=/取消|关闭/i').first()
  830 |       if (await cancel.isVisible().catch(() => false)) { await cancel.click(); await page.waitForTimeout(500) }
  831 |     }
  832 |   })
  833 |   test('BF-CAT-04. 分支：删除有子分类的分类被拦截', async ({ page }) => {
  834 |     const token = await apiLogin('admin')
  835 |     const res = await apiFetch(token, 'GET', '/categories?level=1&page=1&pageSize=1')
  836 |     const id = res.data?.data?.list?.[0]?.id
  837 |     if (!id) return
  838 |     const delRes = await apiFetch(token, 'DELETE', `/categories/${id}`)
  839 |     expect([409, 200, 204]).toContain(delRes.status)
  840 |   })
  841 |   test('BF-CAT-05. 分支：删除弹窗点击取消', async ({ page }) => {
  842 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  843 |     const delBtn = page.locator('text=/删除/i').first()
  844 |     if (await delBtn.isVisible().catch(() => false)) {
  845 |       await delBtn.click(); await page.waitForTimeout(500)
  846 |       const cancel = page.locator('text=/取消/i').first()
  847 |       if (await cancel.isVisible().catch(() => false)) { await cancel.click(); await page.waitForTimeout(500) }
  848 |     }
  849 |   })
  850 |   test('BF-CAT-06. 分支：搜索分类后点击结果查看详情', async ({ page }) => {
  851 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  852 |     const search = page.locator('input[placeholder*="搜索"]').first()
  853 |     if (await search.isVisible().catch(() => false)) {
  854 |       await search.fill('试剂'); await page.waitForTimeout(800)
  855 |       const item = page.locator('text=/试剂/i').first()
  856 |       if (await item.isVisible().catch(() => false)) { await item.click(); await page.waitForTimeout(500) }
  857 |     }
  858 |   })
  859 |   test('BF-CAT-07. 分支：展开全部分类后收起', async ({ page }) => {
  860 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  861 |     const expandAll = page.locator('text=/展开全部|展开/i').first()
  862 |     if (await expandAll.isVisible().catch(() => false)) {
  863 |       await expandAll.click(); await page.waitForTimeout(800)
  864 |       const collapseAll = page.locator('text=/收起全部|收起/i').first()
  865 |       if (await collapseAll.isVisible().catch(() => false)) { await collapseAll.click(); await page.waitForTimeout(800) }
  866 |     }
  867 |   })
  868 |   test('BF-CAT-08. 分支：右键菜单添加子分类完整流程', async ({ page }) => {
  869 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  870 |     const catItem = page.locator('.group').first()
  871 |     if (await catItem.isVisible().catch(() => false)) {
  872 |       await catItem.click({ button: 'right' }); await page.waitForTimeout(500)
  873 |       const add = page.locator('text=/添加子|新增子/i').first()
  874 |       if (await add.isVisible().catch(() => false)) {
  875 |         await add.click(); await page.waitForTimeout(500)
  876 |         const name = page.locator('.fixed input[placeholder*="名称"]').first()
  877 |         if (await name.isVisible().catch(() => false)) { await name.fill(`子分类-${Date.now()}`); await page.locator('.fixed button').filter({ hasText: /^保存$/ }).first().click(); await page.waitForTimeout(1000) }
  878 |       }
  879 |     }
```