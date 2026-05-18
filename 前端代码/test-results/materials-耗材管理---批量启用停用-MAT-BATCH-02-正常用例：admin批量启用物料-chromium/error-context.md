# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: materials.spec.ts >> 耗材管理 -> 批量启用停用 >> MAT-BATCH-02. 正常用例：admin批量启用物料
- Location: e2e\materials.spec.ts:670:3

# Error details

```
Error: expect(received).toContain(expected) // indexOf

Expected value: 500
Received array: [200, 404]
```

# Test source

```ts
  575 |     if (!cid) { test.skip(); return }
  576 |     const create = await apiFetch(token, 'POST', '/materials', {
  577 |       code: `TEST-DEL-CON-${Date.now()}`, name: '并发删除', unit: '瓶', categoryId: cid,
  578 |     })
  579 |     const id = create.data?.data?.id
  580 |     if (!id) { test.skip(); return }
  581 |     const [r1, r2] = await Promise.all([
  582 |       apiFetch(token, 'DELETE', `/materials/${id}`),
  583 |       apiFetch(token, 'DELETE', `/materials/${id}`),
  584 |     ])
  585 |     expect(r1.status === 200 || r2.status === 200 || r1.status === 404 || r2.status === 404).toBe(true)
  586 |   })
  587 |   test('MAT-DEL-05. 异常恢复：删除时API 500后重试', async () => {
  588 |     const token = await apiLogin('admin')
  589 |     const cid = await getAnyCategoryId(token)
  590 |     if (!cid) { test.skip(); return }
  591 |     const create = await apiFetch(token, 'POST', '/materials', {
  592 |       code: `TEST-DEL-RET-${Date.now()}`, name: '恢复删除', unit: '瓶', categoryId: cid,
  593 |     })
  594 |     const id = create.data?.data?.id
  595 |     if (id) {
  596 |       const res = await apiFetch(token, 'DELETE', `/materials/${id}`)
  597 |       expect([200, 409, 404]).toContain(res.status)
  598 |     }
  599 |   })
  600 |   test('MAT-DEL-06. UI差异：admin显示删除按钮', async ({ page }) => {
  601 |     await loginAs(page, 'admin')
  602 |     await page.goto(`${FE_BASE}/materials`)
  603 |     await page.waitForTimeout(1000)
  604 |   })
  605 |   test('MAT-DEL-07. UI差异：procurement可能隐藏删除', async ({ page }) => {
  606 |     await loginAs(page, 'procurement')
  607 |     await page.goto(`${FE_BASE}/materials`)
  608 |     await page.waitForTimeout(1000)
  609 |   })
  610 |   test('MAT-DEL-08. 表单校验：删除不存在的物料返回404', async () => {
  611 |     const token = await apiLogin('admin')
  612 |     const res = await apiFetch(token, 'DELETE', '/materials/non-existent-id')
  613 |     expect(res.status).toBe(404)
  614 |   })
  615 |   test('MAT-DEL-09. 业务冲突：删除后再次删除返回404', async () => {
  616 |     const token = await apiLogin('admin')
  617 |     const cid = await getAnyCategoryId(token)
  618 |     if (!cid) { test.skip(); return }
  619 |     const create = await apiFetch(token, 'POST', '/materials', {
  620 |       code: `TEST-DEL-DUP-${Date.now()}`, name: '重复删除', unit: '瓶', categoryId: cid,
  621 |     })
  622 |     const id = create.data?.data?.id
  623 |     if (!id) { test.skip(); return }
  624 |     await apiFetch(token, 'DELETE', `/materials/${id}`)
  625 |     const res2 = await apiFetch(token, 'DELETE', `/materials/${id}`)
  626 |     expect([404, 409]).toContain(res2.status)
  627 |   })
  628 |   test('MAT-DEL-10. 异常恢复：删除后inventory联动删除', async () => {
  629 |     const token = await apiLogin('admin')
  630 |     const cid = await getAnyCategoryId(token)
  631 |     if (!cid) { test.skip(); return }
  632 |     const create = await apiFetch(token, 'POST', '/materials', {
  633 |       code: `TEST-DEL-INV-${Date.now()}`, name: '库存联动删除', unit: '瓶', categoryId: cid,
  634 |     })
  635 |     const id = create.data?.data?.id
  636 |     if (id) {
  637 |       await apiFetch(token, 'DELETE', `/materials/${id}`)
  638 |     }
  639 |   })
  640 |   test('MAT-DEL-11. 正常用例：删除后物料列表刷新', async ({ page }) => {
  641 |     const token = await apiLogin('admin')
  642 |     const cid = await getAnyCategoryId(token)
  643 |     if (!cid) { test.skip(); return }
  644 |     const create = await apiFetch(token, 'POST', '/materials', {
  645 |       code: `TEST-DEL-REF-${Date.now()}`, name: '刷新删除', unit: '瓶', categoryId: cid,
  646 |     })
  647 |     const id = create.data?.data?.id
  648 |     if (id) {
  649 |       await apiFetch(token, 'DELETE', `/materials/${id}`)
  650 |     }
  651 |   })
  652 |   test('MAT-DEL-12. UI差异：warehouse_manager不显示删除按钮', async ({ page }) => {
  653 |     await loginAs(page, 'warehouse_manager')
  654 |     await page.goto(`${FE_BASE}/materials`)
  655 |     await page.waitForTimeout(1000)
  656 |   })
  657 | })
  658 | 
  659 | // ────────────────────────────────────────────
  660 | // 8. 批量启用/停用 (8 tests)
  661 | // ────────────────────────────────────────────
  662 | test.describe('耗材管理 -> 批量启用停用', () => {
  663 |   test('MAT-BATCH-01. 正常用例：admin批量停用物料', async () => {
  664 |     const token = await apiLogin('admin')
  665 |     const id = await getAnyMaterialId(token)
  666 |     if (!id) { test.skip(); return }
  667 |     const res = await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'inactive' })
  668 |     expect([200, 404]).toContain(res.status)
  669 |   })
  670 |   test('MAT-BATCH-02. 正常用例：admin批量启用物料', async () => {
  671 |     const token = await apiLogin('admin')
  672 |     const id = await getAnyMaterialId(token)
  673 |     if (!id) { test.skip(); return }
  674 |     const res = await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'active' })
> 675 |     expect([200, 404]).toContain(res.status)
      |                        ^ Error: expect(received).toContain(expected) // indexOf
  676 |   })
  677 |   test('MAT-BATCH-03. 空数据边界：空数组ids返回400', async () => {
  678 |     const token = await apiLogin('admin')
  679 |     const res = await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [], status: 'inactive' })
  680 |     expect([200, 400]).toContain(res.status)
  681 |   })
  682 |   test('MAT-BATCH-04. 权限：technician批量操作返回403', async () => {
  683 |     const token = await apiLogin('technician')
  684 |     const adminToken = await apiLogin('admin')
  685 |     const id = await getAnyMaterialId(adminToken)
  686 |     if (!id) { test.skip(); return }
  687 |     const res = await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'inactive' })
  688 |     expect(res.status).toBe(403)
  689 |   })
  690 |   test('MAT-BATCH-05. 并发：快速点击批量停用多次', async () => {
  691 |     const token = await apiLogin('admin')
  692 |     const id = await getAnyMaterialId(token)
  693 |     if (!id) { test.skip(); return }
  694 |     await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'inactive' })
  695 |     await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'inactive' })
  696 |     await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'active' })
  697 |   })
  698 |   test('MAT-BATCH-06. UI差异：admin显示批量操作按钮', async ({ page }) => {
  699 |     await loginAs(page, 'admin')
  700 |     await page.goto(`${FE_BASE}/materials`)
  701 |     await page.waitForTimeout(1000)
  702 |   })
  703 |   test('MAT-BATCH-07. 异常恢复：批量操作时部分失败', async () => {
  704 |     const token = await apiLogin('admin')
  705 |     const res = await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: ['invalid-id-1', 'invalid-id-2'], status: 'inactive' })
  706 |     expect([200, 400, 404]).toContain(res.status)
  707 |   })
  708 |   test('MAT-BATCH-08. 正常用例：批量操作后列表状态标签更新', async ({ page }) => {
  709 |     const token = await apiLogin('admin')
  710 |     const id = await getAnyMaterialId(token)
  711 |     if (!id) { test.skip(); return }
  712 |     await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'inactive' })
  713 |     await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'active' })
  714 |   })
  715 | })
  716 | 
  717 | // ────────────────────────────────────────────
  718 | // 9. 查看物料详情 (6 tests)
  719 | // ────────────────────────────────────────────
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
```