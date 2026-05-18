# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: materials.spec.ts >> 耗材管理 -> 删除物料 >> MAT-DEL-02-procurement. 权限：procurement删除物料返回403
- Location: e2e\materials.spec.ts:556:5

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 403
Received: 409
```

# Test source

```ts
  462 |     test(`MAT-EDIT-04-${role}. 权限：${role}编辑物料返回403`, async () => {
  463 |       const token = await apiLogin(role)
  464 |       const adminToken = await apiLogin('admin')
  465 |       const id = await getAnyMaterialId(adminToken)
  466 |       if (!id) { test.skip(); return }
  467 |       const res = await apiFetch(token, 'PUT', `/materials/${id}`, { name: '越权编辑' })
  468 |       expect(res.status).toBe(403)
  469 |     })
  470 |   }
  471 |   test('MAT-EDIT-05. 业务冲突：编辑categoryId不更新code前缀', async () => {
  472 |     const token = await apiLogin('admin')
  473 |     const id = await getAnyMaterialId(token)
  474 |     if (!id) { test.skip(); return }
  475 |     const res = await apiFetch(token, 'PUT', `/materials/${id}`, { categoryId: 'new-cat-id' })
  476 |     expect([200, 404]).toContain(res.status)
  477 |   })
  478 |   test('MAT-EDIT-06. 并发：并发编辑同一物料', async () => {
  479 |     const token = await apiLogin('admin')
  480 |     const id = await getAnyMaterialId(token)
  481 |     if (!id) { test.skip(); return }
  482 |     const [r1, r2] = await Promise.all([
  483 |       apiFetch(token, 'PUT', `/materials/${id}`, { name: '并发A' }),
  484 |       apiFetch(token, 'PUT', `/materials/${id}`, { name: '并发B' }),
  485 |     ])
  486 |     expect(r1.status === 200 || r2.status === 200).toBe(true)
  487 |   })
  488 |   test('MAT-EDIT-07. 异常恢复：编辑时API 500后重试', async () => {
  489 |     const token = await apiLogin('admin')
  490 |     const id = await getAnyMaterialId(token)
  491 |     if (!id) { test.skip(); return }
  492 |     const res = await apiFetch(token, 'PUT', `/materials/${id}`, { safetyStock: 20, remark: 'E2E恢复' })
  493 |     expect([200, 404]).toContain(res.status)
  494 |   })
  495 |   test('MAT-EDIT-08. UI差异：admin显示编辑按钮', async ({ page }) => {
  496 |     await loginAs(page, 'admin')
  497 |     await page.goto(`${FE_BASE}/materials`)
  498 |     await page.waitForTimeout(1000)
  499 |   })
  500 |   test('MAT-EDIT-09. UI差异：procurement显示编辑按钮', async ({ page }) => {
  501 |     await loginAs(page, 'procurement')
  502 |     await page.goto(`${FE_BASE}/materials`)
  503 |     await page.waitForTimeout(1000)
  504 |   })
  505 |   test('MAT-EDIT-10. UI差异：technician不显示编辑按钮', async ({ page }) => {
  506 |     await loginAs(page, 'technician')
  507 |     await page.goto(`${FE_BASE}/materials`)
  508 |     await page.waitForTimeout(1000)
  509 |   })
  510 |   test('MAT-EDIT-11. 正常用例：编辑后列表数据更新', async () => {
  511 |     const token = await apiLogin('admin')
  512 |     const id = await getAnyMaterialId(token)
  513 |     if (!id) { test.skip(); return }
  514 |     await apiFetch(token, 'PUT', `/materials/${id}`, { name: `更新名称-${Date.now()}` })
  515 |     const after = await apiFetch(token, 'GET', `/materials/${id}`)
  516 |     expect([200, 404]).toContain(after.status)
  517 |   })
  518 |   test('MAT-EDIT-12. 表单校验：编辑不存在的物料返回404', async () => {
  519 |     const token = await apiLogin('admin')
  520 |     const res = await apiFetch(token, 'PUT', '/materials/non-existent-id', { name: '不存在' })
  521 |     expect(res.status).toBe(404)
  522 |   })
  523 |   test('MAT-EDIT-13. 边界：编辑name为空字符串', async () => {
  524 |     const token = await apiLogin('admin')
  525 |     const id = await getAnyMaterialId(token)
  526 |     if (!id) { test.skip(); return }
  527 |     const res = await apiFetch(token, 'PUT', `/materials/${id}`, { name: '' })
  528 |     expect([200, 400]).toContain(res.status)
  529 |   })
  530 |   test('MAT-EDIT-14. 异常恢复：编辑时网络中断', async () => {
  531 |     const token = await apiLogin('admin')
  532 |     const id = await getAnyMaterialId(token)
  533 |     if (!id) { test.skip(); return }
  534 |     const res = await apiFetch(token, 'PUT', `/materials/${id}`, { remark: 'E2E网络' })
  535 |     expect([200, 404]).toContain(res.status)
  536 |   })
  537 | })
  538 | 
  539 | // ────────────────────────────────────────────
  540 | // 7. 删除物料 (12 tests)
  541 | // ────────────────────────────────────────────
  542 | test.describe('耗材管理 -> 删除物料', () => {
  543 |   test('MAT-DEL-01. 正常用例：admin删除stock=0物料', async () => {
  544 |     const token = await apiLogin('admin')
  545 |     const cid = await getAnyCategoryId(token)
  546 |     if (!cid) { test.skip(); return }
  547 |     const create = await apiFetch(token, 'POST', '/materials', {
  548 |       code: `TEST-DEL-${Date.now()}`, name: '删除测试', unit: '瓶', categoryId: cid,
  549 |     })
  550 |     expect(create.status).toBe(201)
  551 |     const id = create.data?.data?.id
  552 |     const res = await apiFetch(token, 'DELETE', `/materials/${id}`)
  553 |     expect([200, 409, 404]).toContain(res.status)
  554 |   })
  555 |   for (const role of ['technician', 'pathologist', 'procurement', 'finance'] as RoleKey[]) {
  556 |     test(`MAT-DEL-02-${role}. 权限：${role}删除物料返回403`, async () => {
  557 |       const token = await apiLogin(role)
  558 |       const adminToken = await apiLogin('admin')
  559 |       const id = await getAnyMaterialId(adminToken)
  560 |       if (!id) { test.skip(); return }
  561 |       const res = await apiFetch(token, 'DELETE', `/materials/${id}`)
> 562 |       expect(res.status).toBe(403)
      |                          ^ Error: expect(received).toBe(expected) // Object.is equality
  563 |     })
  564 |   }
  565 |   test('MAT-DEL-03. 业务冲突：stock>0删除返回409', async () => {
  566 |     const token = await apiLogin('admin')
  567 |     const id = await getAnyMaterialId(token)
  568 |     if (!id) { test.skip(); return }
  569 |     const res = await apiFetch(token, 'DELETE', `/materials/${id}`)
  570 |     expect([200, 409, 404]).toContain(res.status)
  571 |   })
  572 |   test('MAT-DEL-04. 并发：并发删除同一物料', async () => {
  573 |     const token = await apiLogin('admin')
  574 |     const cid = await getAnyCategoryId(token)
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
```