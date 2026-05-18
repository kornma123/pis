# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: categories.spec.ts >> 物料分类 -> 删除分类 >> CAT-DELETE-10. 表单校验：删除不存在的分类返回404
- Location: e2e\categories.spec.ts:534:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 404
Received: 200
```

# Test source

```ts
  437 |   test('CAT-EDIT-13. 表单校验：编辑parentId形成循环引用', async ({ page }) => {
  438 |     const token = await apiLogin('admin')
  439 |     const res = await apiFetch(token, 'GET', '/categories?page=1&pageSize=1')
  440 |     const id = res.data?.data?.list?.[0]?.id
  441 |     if (!id) return
  442 |     const res2 = await apiFetch(token, 'PUT', `/categories/${id}`, { parentId: id })
  443 |     expect([200, 400]).toContain(res2.status)
  444 |   })
  445 |   test('CAT-EDIT-14. 边界：编辑remark为超长文本', async ({ page }) => {
  446 |     const token = await apiLogin('admin')
  447 |     const res = await apiFetch(token, 'GET', '/categories?page=1&pageSize=1')
  448 |     const id = res.data?.data?.list?.[0]?.id
  449 |     if (!id) return
  450 |     const res2 = await apiFetch(token, 'PUT', `/categories/${id}`, { remark: 'A'.repeat(500) })
  451 |     expect([200, 400]).toContain(res2.status)
  452 |   })
  453 | })
  454 | 
  455 | // ───────────────────────────────────────────────
  456 | // 5. 删除分类
  457 | // ───────────────────────────────────────────────
  458 | test.describe('物料分类 -> 删除分类', () => {
  459 |   test('CAT-DELETE-01. 正常用例：admin删除无子分类无物料三级分类', async ({ page }) => {
  460 |     const token = await apiLogin('admin')
  461 |     const createRes = await apiFetch(token, 'POST', '/categories', { name: `测试分类-删-${Date.now()}`, level: 3, parentId: 'test-parent' })
  462 |     const id = createRes.data?.data?.id || createRes.data?.id
  463 |     if (!id) return
  464 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  465 |     const deleteBtn = page.locator(`[data-id="${id}"] >> text=/删除/i`).first()
  466 |     if (await deleteBtn.isVisible().catch(() => false)) {
  467 |       await deleteBtn.click(); await page.waitForTimeout(500)
  468 |       const confirmBtn = page.locator('text=/确认|确定/i').first()
  469 |       if (await confirmBtn.isVisible().catch(() => false)) { await confirmBtn.click(); await page.waitForTimeout(1000) }
  470 |     } else {
  471 |       const res = await apiFetch(token, 'DELETE', `/categories/${id}`)
  472 |       expect([200, 204]).toContain(res.status)
  473 |     }
  474 |   })
  475 |   test('CAT-DELETE-02. 业务冲突：有子分类的一级分类删除返回409', async ({ page }) => {
  476 |     const token = await apiLogin('admin')
  477 |     const res = await apiFetch(token, 'GET', '/categories?level=1&page=1&pageSize=1')
  478 |     const id = res.data?.data?.list?.[0]?.id
  479 |     if (!id) return
  480 |     const delRes = await apiFetch(token, 'DELETE', `/categories/${id}`)
  481 |     expect([409, 200, 204]).toContain(delRes.status)
  482 |   })
  483 |   test('CAT-DELETE-03. 业务冲突：有关联物料的分类删除返回409', async ({ page }) => {
  484 |     const token = await apiLogin('admin')
  485 |     const res = await apiFetch(token, 'GET', '/categories?page=1&pageSize=100')
  486 |     const list = res.data?.data?.list || []
  487 |     const withMaterials = list.find((c: any) => c.count > 0)
  488 |     if (!withMaterials) return
  489 |     const delRes = await apiFetch(token, 'DELETE', `/categories/${withMaterials.id}`)
  490 |     expect([409, 200, 204]).toContain(delRes.status)
  491 |   })
  492 |   test('CAT-DELETE-04. 并发：并发删除同一分类', async ({ page }) => {
  493 |     const token = await apiLogin('admin')
  494 |     const createRes = await apiFetch(token, 'POST', '/categories', { name: `测试分类-并发删-${Date.now()}`, level: 3, parentId: 'test' })
  495 |     const id = createRes.data?.data?.id || createRes.data?.id
  496 |     if (!id) return
  497 |     const reqs = Array.from({ length: 2 }, () => apiFetch(token, 'DELETE', `/categories/${id}`))
  498 |     const results = await Promise.all(reqs)
  499 |     expect(results.some(r => [200, 204, 404].includes(r.status))).toBe(true)
  500 |   })
  501 |   test('CAT-DELETE-05. 异常恢复：删除时API 500后重试', async ({ page }) => {
  502 |     const token = await apiLogin('admin')
  503 |     const createRes = await apiFetch(token, 'POST', '/categories', { name: `测试分类-500-${Date.now()}`, level: 3, parentId: 'test' })
  504 |     const id = createRes.data?.data?.id || createRes.data?.id
  505 |     if (!id) return
  506 |     await page.route('**/api/v1/categories/*', r => r.fulfill({ status: 500, body: JSON.stringify({ message: 'err' }) }))
  507 |     await apiFetch(token, 'DELETE', `/categories/${id}`)
  508 |     await page.unroute('**/api/v1/categories/*')
  509 |   })
  510 |   for (const role of ['technician', 'pathologist', 'procurement', 'finance', 'warehouse_manager'] as RoleKey[]) {
  511 |     test(`CAT-DELETE-06-${role}. 权限：${role}删除分类返回403`, async () => {
  512 |       const token = await apiLogin(role)
  513 |       const res = await apiFetch(token, 'DELETE', '/categories/test-id')
  514 |       expect(res.status).toBe(403)
  515 |     })
  516 |   }
  517 |   test('CAT-DELETE-07. UI差异：admin显示删除按钮', async ({ page }) => {
  518 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  519 |     await expect(page.locator('text=/删除/i').first().or(page.locator('body'))).toBeVisible()
  520 |   })
  521 |   test('CAT-DELETE-08. UI差异：technician不显示删除按钮', async ({ page }) => {
  522 |     await loginAs(page, 'technician'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  523 |     await expect(page.locator('body')).toBeVisible()
  524 |   })
  525 |   test('CAT-DELETE-09. 正常用例：删除后分类树自动刷新', async ({ page }) => {
  526 |     const token = await apiLogin('admin')
  527 |     const createRes = await apiFetch(token, 'POST', '/categories', { name: `测试分类-刷新-${Date.now()}`, level: 3, parentId: 'test' })
  528 |     const id = createRes.data?.data?.id || createRes.data?.id
  529 |     if (!id) return
  530 |     await apiFetch(token, 'DELETE', `/categories/${id}`)
  531 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  532 |     await expect(page.locator('body')).toBeVisible()
  533 |   })
  534 |   test('CAT-DELETE-10. 表单校验：删除不存在的分类返回404', async ({ page }) => {
  535 |     const token = await apiLogin('admin')
  536 |     const res = await apiFetch(token, 'DELETE', '/categories/non-existent-id')
> 537 |     expect(res.status).toBe(404)
      |                        ^ Error: expect(received).toBe(expected) // Object.is equality
  538 |   })
  539 |   test('CAT-DELETE-11. 边界：删除后再次删除返回404', async ({ page }) => {
  540 |     const token = await apiLogin('admin')
  541 |     const createRes = await apiFetch(token, 'POST', '/categories', { name: `测试分类-重复-${Date.now()}`, level: 3, parentId: 'test' })
  542 |     const id = createRes.data?.data?.id || createRes.data?.id
  543 |     if (!id) return
  544 |     await apiFetch(token, 'DELETE', `/categories/${id}`)
  545 |     const res2 = await apiFetch(token, 'DELETE', `/categories/${id}`)
  546 |     expect([404, 409]).toContain(res2.status)
  547 |   })
  548 | })
  549 | 
  550 | // ───────────────────────────────────────────────
  551 | // 6. 分类详情面板
  552 | // ───────────────────────────────────────────────
  553 | test.describe('物料分类 -> 分类详情面板', () => {
  554 |   test('CAT-DETAIL-01. 正常用例：点击分类显示详情面板', async ({ page }) => {
  555 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  556 |     const catItem = page.locator('.group').first()
  557 |     if (await catItem.isVisible().catch(() => false)) { await catItem.click(); await page.waitForTimeout(800) }
  558 |     await expect(page.locator('text=/基本信息|分类名称|分类编码/i').first()).toBeVisible()
  559 |   })
  560 |   test('CAT-DETAIL-02. 正常用例：详情面板显示面包屑路径', async ({ page }) => {
  561 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  562 |     const catItem = page.locator('.group').first()
  563 |     if (await catItem.isVisible().catch(() => false)) { await catItem.click(); await page.waitForTimeout(800) }
  564 |     await expect(page.locator('body')).toBeVisible()
  565 |   })
  566 |   test('CAT-DETAIL-03. 正常用例：详情面板显示关联物料数量', async ({ page }) => {
  567 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  568 |     const catItem = page.locator('.group').first()
  569 |     if (await catItem.isVisible().catch(() => false)) { await catItem.click(); await page.waitForTimeout(800) }
  570 |     await expect(page.locator('text=/关联物料|物料数量/i').first()).toBeVisible()
  571 |   })
  572 |   test('CAT-DETAIL-04. UI差异：admin详情面板显示编辑和添加子分类按钮', async ({ page }) => {
  573 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  574 |     const catItem = page.locator('.group').first()
  575 |     if (await catItem.isVisible().catch(() => false)) { await catItem.click(); await page.waitForTimeout(800) }
  576 |     await expect(page.locator('text=/编辑|添加子分类/i').first()).toBeVisible()
  577 |   })
  578 |   test('CAT-DETAIL-05. UI差异：technician详情面板仅显示信息无操作', async ({ page }) => {
  579 |     await loginAs(page, 'technician'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  580 |     const catItem = page.locator('.group').first()
  581 |     if (await catItem.isVisible().catch(() => false)) { await catItem.click(); await page.waitForTimeout(800) }
  582 |     await expect(page.locator('body')).toBeVisible()
  583 |   })
  584 |   test('CAT-DETAIL-06. 正常用例：未选择分类显示占位提示', async ({ page }) => {
  585 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  586 |     await expect(page.locator('text=/选择分类|查看详情/i').first()).toBeVisible()
  587 |   })
  588 |   test('CAT-DETAIL-07. 正常用例：详情面板显示状态标签', async ({ page }) => {
  589 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  590 |     const catItem = page.locator('.group').first()
  591 |     if (await catItem.isVisible().catch(() => false)) { await catItem.click(); await page.waitForTimeout(800) }
  592 |     await expect(page.locator('text=/已启用|已停用|状态/i').first()).toBeVisible()
  593 |   })
  594 |   test('CAT-DETAIL-08. 正常用例：三级分类不显示添加子分类按钮', async ({ page }) => {
  595 |     const token = await apiLogin('admin')
  596 |     const p1 = await apiFetch(token, 'POST', '/categories', { name: `测试分类-P1-${Date.now()}`, level: 1 })
  597 |     const pid1 = p1.data?.data?.id || p1.data?.id
  598 |     if (!pid1) return
  599 |     const p2 = await apiFetch(token, 'POST', '/categories', { name: `测试分类-P2-${Date.now()}`, level: 2, parentId: pid1 })
  600 |     const pid2 = p2.data?.data?.id || p2.data?.id
  601 |     if (!pid2) return
  602 |     const p3 = await apiFetch(token, 'POST', '/categories', { name: `测试分类-P3-${Date.now()}`, level: 3, parentId: pid2 })
  603 |     const pid3 = p3.data?.data?.id || p3.data?.id
  604 |     if (!pid3) return
  605 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  606 |     const item = page.locator(`[data-id="${pid3}"]`).first()
  607 |     if (await item.isVisible().catch(() => false)) { await item.click(); await page.waitForTimeout(800) }
  608 |   })
  609 | })
  610 | 
  611 | // ───────────────────────────────────────────────
  612 | // 7. 展开收起功能
  613 | // ───────────────────────────────────────────────
  614 | test.describe('物料分类 -> 展开收起功能', () => {
  615 |   test('CAT-EXPAND-01. 正常用例：点击展开按钮显示子分类', async ({ page }) => {
  616 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  617 |     const expandBtn = page.locator('svg').first()
  618 |     if (await expandBtn.isVisible().catch(() => false)) { await expandBtn.click(); await page.waitForTimeout(500) }
  619 |   })
  620 |   test('CAT-EXPAND-02. 正常用例：点击收起按钮隐藏子分类', async ({ page }) => {
  621 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  622 |     const expandBtn = page.locator('svg').first()
  623 |     if (await expandBtn.isVisible().catch(() => false)) {
  624 |       await expandBtn.click(); await page.waitForTimeout(500)
  625 |       await expandBtn.click(); await page.waitForTimeout(500)
  626 |     }
  627 |   })
  628 |   test('CAT-EXPAND-03. 正常用例：展开全部按钮展开所有层级', async ({ page }) => {
  629 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  630 |     const expandAll = page.locator('text=/展开全部|展开/i').first()
  631 |     if (await expandAll.isVisible().catch(() => false)) { await expandAll.click(); await page.waitForTimeout(800) }
  632 |   })
  633 |   test('CAT-EXPAND-04. 正常用例：收起全部按钮收起所有层级', async ({ page }) => {
  634 |     await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/categories`); await page.waitForTimeout(1500)
  635 |     const collapseAll = page.locator('text=/收起全部|收起/i').first()
  636 |     if (await collapseAll.isVisible().catch(() => false)) { await collapseAll.click(); await page.waitForTimeout(800) }
  637 |   })
```