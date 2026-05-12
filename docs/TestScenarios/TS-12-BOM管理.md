# TS-12 BOM 管理 — 测试场景清单

> **模块**: BOM 管理 (BOM Management)  
> **对应FRS**: [FRS-12 BOM管理](../FRS/FRS-12-BOM管理.md)  
> **生成时间**: 2026-05-12  

---

## 测试维度覆盖

- ✅ 正常流程
- ✅ 异常/校验
- ✅ RBAC 权限控制
- ✅ 数据一致性
- ✅ 边界条件
- ✅ 安全测试
- ✅ 交互/认知走查

---

## 测试场景

| 场景ID | 场景描述 |
|--------|----------|
| BOM-01 | Given admin 用户已登录，When 调用 POST /api/v1/boms 创建 BOM，Then 返回 201，version="v1.0"，status="active" |
| BOM-02 | Given 创建 BOM 时传入 materials=[{materialId:"xxx", usagePerSample:0.5, unit:"ml"}]，When 调用 POST，Then 返回 201，bom_items 正确创建 |
| BOM-03 | Given 创建 BOM 时传入 code="BOM-TEST"、name="测试BOM"、type="ihc"，When 调用 POST，Then 返回 201，所有字段正确存储 |
| BOM-04 | Given admin 用户编辑 BOM，When 调用 PUT /api/v1/boms/:id，Then 返回 200，version 自动升级（如 v1.0→v1.1） |
| BOM-05 | Given 编辑 BOM 时传入新的 materials 列表，When 调用 PUT，Then 返回 200，旧 bom_items 全部删除，新列表全量替换 |
| BOM-06 | Given 编辑 BOM 时不传 materials 字段，When 调用 PUT，Then 返回 200，仅基础字段更新，bom_items 保持不变 |
| BOM-07 | Given admin 用户删除 BOM，When 调用 DELETE /api/v1/boms/:id，Then 返回 200，逻辑删除 |
| BOM-08 | Given technician 用户，When 调用 GET /api/v1/boms，Then 返回 200，正常读取 |
| BOM-09 | Given pathologist 用户，When 调用 GET /api/v1/boms，Then 返回 200，正常读取 |
| BOM-10 | Given technician 用户，When 调用 POST /api/v1/boms，Then 返回 403 Forbidden |
| BOM-11 | Given finance 用户，When 调用 GET /api/v1/boms，Then 返回 403 Forbidden |
| BOM-12 | Given 按类型筛选 type="ihc"，When 调用 GET /api/v1/boms?type=ihc，Then 仅返回免疫组化类型的 BOM |
| BOM-13 | Given BOM 详情查询，When 调用 GET /api/v1/boms/:id，Then 返回 200，包含 materials 明细和 costRatio |
| BOM-14 | Given costRatio 计算验证，When 检查 BOM 详情，Then 各物料 costRatio = (price × usagePerSample) / totalCost，且所有 costRatio 之和 ≈ 1 |
| BOM-15 | Given 创建重复(code,version) 的 BOM，When 调用 POST，Then 返回 409 "Code version exists" |
| BOM-16 | Given 创建 BOM 时未传 code 字段，When 调用 POST，Then 返回 400 "Missing required fields" |
| BOM-17 | Given 创建 BOM 时未传 name 字段，When 调用 POST，Then 返回 400 "Missing required fields" |
| BOM-18 | Given 创建 BOM 时未传 type 字段，When 调用 POST，Then 返回 400 "Missing required fields" |
| BOM-19 | Given 创建 BOM 时 materials=[]（空数组），When 调用 POST，Then 返回 400 "Missing required fields" |
| BOM-20 | Given 无 Token 请求，When 调用 GET /api/v1/boms，Then 返回 401 Unauthorized |
| BOM-21 | Given 过期 Token，When 调用 POST /api/v1/boms，Then 返回 401 Unauthorized |
| BOM-22 | Given SQL 注入 payload（code="' OR '1'='1"），When 调用 POST，Then 创建成功，无 SQL 注入漏洞 |
| BOM-23 | Given XSS payload（name="<script>alert(1)</script>"），When 调用 POST，Then 创建成功，name 原样存储 |
| BOM-24 | Given 分页 page=0，When 调用 GET /api/v1/boms?page=0，Then page=0 被修正为 1 |
| BOM-25 | Given BOM 列表中 materialCount 字段，When 检查返回值，Then 固定返回 0（后端未实现统计） |
| BOM-26 | Given 版本递增验证，When 连续编辑同一 BOM 3 次，Then 版本依次为 v1.0→v1.1→v1.2→v1.3 |
| BOM-27 | Given 编辑 BOM 时传入 supportableSamples=50，When 调用 PUT，Then 返回 200，supportableSamples 更新成功 |
| BOM-28 | Given 搜索 BOM keyword="HER2"，When 调用 GET /api/v1/boms?keyword=HER2，Then 返回名称或编码包含"HER2"的 BOM |
| BOM-29 | Given 删除 BOM 后，When 查询项目关联的 bomId，Then 项目表中 bomId 成为悬空引用 |
| BOM-30 | Given 响应结构检查，When 调用 GET /api/v1/boms，Then 每条记录包含 id、code、name、version、type、materialCount、unitCost、status |

---

*文档版本: v1.1.0*  
*最后更新: 2026-05-12*
