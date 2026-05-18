# COREONE E2E 路径覆盖盲点分析

> **分析时间**: 2026-05-13  
> **当前测试状态**: 10 个测试，4 pass / 5 fail / 1 skip  
> **目标**: 每次分析使测试总数增加 100%+，最终达到 2000+

---

## 一、当前已通过的测试清单

| # | 测试名称 | 状态 | 覆盖范围 |
|:---|:---|:---:|:---|
| 01 | 登录页应正常加载并可通过表单登录 | ✅ pass | 认证/登录页 |
| 02 | 库存列表应正确加载并显示有库存数据 | ✅ pass | 库存列表/GET /inventory |
| 08 | 库存统计卡片应显示正确数据 | ✅ pass | 库存统计/GET /inventory/stats |
| 10 | 整体验证：先入库再出库，库存数量正确变化 | ✅ pass | 库存列表/API数据一致性 |
| 09 | 无权限角色无法访问库存管理 | ⏭️ skip | 权限控制（因无测试账号跳过） |

**失败测试**: 03(出库弹窗)/04(物料选择器)/05(出库后库存)/06(出库列表)/07(采购订单入库) —— 均为 UI 选择器定位失败

---

## 二、盲点1: 未被测试覆盖的 API 端点 (89 个中仅覆盖 ~15 个)

### 2.1 完全未调用的 API 端点

| 模块 | 未覆盖 API | 影响 |
|:---|:---|:---|
| **认证** | POST /auth/refresh, POST /auth/logout | Token 刷新、登出流程未测试 |
| **入库** | POST /inbound, PUT /inbound/:id, DELETE /inbound/:id, GET /inbound/:id/check-deletable, POST /inbound/:id/cancel | 入库创建/编辑/删除/取消全未测 |
| **出库** | POST /outbound, POST /outbound/bom | 出库创建、BOM一键出库未测 |
| **盘点** | POST /stocktaking, GET /stocktaking | 盘点创建/列表未测 |
| **报废** | POST /scraps, GET /scraps | 报废创建/列表未测 |
| **退货** | POST /returns, GET /returns | 退货创建/列表未测 |
| **调拨** | POST /transfers/inbound | 调拨未测 |
| **采购** | POST /purchase-orders, PUT /purchase-orders/:id/receive, PUT /purchase-orders/:id/cancel, GET /purchase-orders/:id | 采购创建/收货/取消/详情未测 |
| **项目** | POST /projects, PUT /projects/:id, DELETE /projects/:id, GET /projects/:id | 项目CRUD未测 |
| **BOM** | POST /boms, PUT /boms/:id, DELETE /boms/:id, GET /boms/:id | BOM CRUD未测 |
| **物料** | POST /materials, PUT /materials/:id, DELETE /materials/:id, GET /materials/:id, PATCH /materials/batch-status, GET /materials/next-code | 物料CRUD/批量禁用未测 |
| **供应商** | POST /suppliers, PUT /suppliers/:id, DELETE /suppliers/:id | 供应商CRUD未测 |
| **分类** | POST /categories, PUT /categories/:id, DELETE /categories/:id | 分类CRUD未测 |
| **库位** | POST /locations, PUT /locations/:id, DELETE /locations/:id, GET /locations/tree | 库位CRUD未测 |
| **用户** | POST /users, PUT /users/:id, DELETE /users/:id | 用户CRUD未测 |
| **角色** | POST /roles, PUT /roles/:id, DELETE /roles/:id | 角色CRUD未测 |
| **日志** | GET /logs/operation | 操作日志未测 |
| **预警** | GET /alerts, GET /alerts/rules, PUT /alerts/rules/:id, POST /alerts/:id/handle, POST /alerts/generate | 预警全链路未测 |
| **报表** | GET /reports/cost-by-project, GET /reports/cost-by-material, GET /reports/cost-by-supplier | 成本报表未测 |
| **消耗跟踪** | GET /depletion/batches/:materialId, POST /depletion/tracking, PUT /depletion/tracking/:id/remain, POST /depletion/tracking/:id/deplete | 批次跟踪未测 |
| **对账** | GET /reconciliation/summary, GET /reconciliation/projects, GET /reconciliation/projects/:id/materials, GET /reconciliation/materials, GET /reconciliation/cases, POST /reconciliation/cases/import, PUT /reconciliation/cases/:id, GET /reconciliation/logs, POST /reconciliation/logs | 对账全链路未测 |

### 2.2 对应的新 E2E 场景 (每个盲点 1 个)

| 盲点 ID | 场景描述 |
|:---|:---|
| API-001 | Given admin登录，When 调用 POST /auth/refresh 使用有效 refreshToken，Then 返回新 access token（8h） |
| API-002 | Given admin登录，When 调用 POST /auth/logout，Then 返回200，登出后访问 /inventory 重定向到登录页 |
| API-003 | Given admin登录，When 通过前端表单创建直接入库单（选物料/数量/批次/库位），Then 入库成功，库存增加，入库列表出现新记录 |
| API-004 | Given 入库单已创建，When 编辑入库单备注，Then 更新成功，列表备注字段更新 |
| API-005 | Given 入库单无出库关联，When 删除入库单，Then 软删除成功，库存回退 |
| API-006 | Given 入库单有出库关联，When 调用 GET /inbound/:id/check-deletable，Then 返回 canDelete=false |
| API-007 | Given 入库单status=pending，When 调用 POST /inbound/:id/cancel，Then 状态变为cancelled |
| API-008 | Given 库存充足，When 前端创建项目领用出库单（选项目+物料+数量），Then 出库成功，库存扣减，成本归集到项目 |
| API-009 | Given 项目关联BOM，When 前端执行BOM一键出库（选项目+BOM+样本数），Then 自动计算物料需求，FIFO分配批次，创建出库单 |
| API-010 | Given 仓库管理员登录，When 前端创建盘点单（选物料/输入实盘），Then 盘点成功，差异计算正确，库存按实盘调整 |
| API-011 | Given 仓库管理员登录，When 前端创建报废申请（选物料/数量/原因），Then 报废成功，库存扣减 |
| API-012 | Given 仓库管理员登录，When 前端创建退货单（选原出库单/数量/原因），Then 退货成功，库存扣减 |
| API-013 | Given 仓库管理员登录，When 前端创建调拨入库单（来源库位/目标库位/物料/数量），Then 调拨成功，目标库位库存增加 |
| API-014 | Given 采购专员登录，When 前端创建采购订单（选物料/供应商/数量/单价），Then 采购单创建成功，status=pending |
| API-015 | Given 采购订单status=pending，When 前端执行收货确认（输入数量），Then receivedQty增加，status变为partial/completed |
| API-016 | Given 采购订单status=pending，When 前端取消采购订单，Then status变为cancelled |
| API-017 | Given 管理员登录，When 前端创建检测项目（填code/name/type/关联BOM），Then 项目创建成功 |
| API-018 | Given 项目已创建，When 编辑项目名称，Then 更新成功 |
| API-019 | Given 项目无出库关联，When 删除项目，Then 软删除成功 |
| API-020 | Given 管理员登录，When 前端创建BOM（填code/name/type/添加物料明细），Then BOM创建成功，version=v1.0 |
| API-021 | Given BOM已创建，When 编辑BOM物料用量，Then 更新成功，version自动升级为v1.1 |
| API-022 | Given 管理员登录，When 前端新增物料（填code/name/unit/categoryId），Then 创建成功，inventory自动创建stock=0 |
| API-023 | Given 物料已创建，When 批量禁用2个物料，Then 物料status变为inactive |
| API-024 | Given 管理员登录，When 前端新增供应商，Then 创建成功，code自动生成 |
| API-025 | Given 管理员登录，When 前端新增一级分类 → 二级分类 → 三级分类，Then 分类树正确展示 |
| API-026 | Given 管理员登录，When 前端新增库位，Then 创建成功，入库单库位下拉同步 |
| API-027 | Given 管理员登录，When 前端新增用户（填username/password/realName/role），Then 创建成功，密码bcrypt存储 |
| API-028 | Given 管理员登录，When 禁用某用户，Then 该用户后续登录返回401 |
| API-029 | Given 管理员登录，When 前端修改角色权限（取消warehouse_manager的suppliers权限），Then 该角色用户重新登录后无法访问供应商管理 |
| API-030 | Given 管理员登录，When 前端创建自定义角色，Then 用户创建时可选择此角色 |
| API-031 | Given 系统有预警条件，When 调用 POST /alerts/generate 手动扫描，Then 生成新预警记录 |
| API-032 | Given 预警状态=pending，When 前端处理预警（选action=handled），Then 状态变为handled |
| API-033 | Given 有出库记录，When 查看成本报表（按项目），Then 显示各项目totalCost/sampleCount/unitCost |
| API-034 | Given 有入库记录，When 查看供应商成本报表，Then 显示各供应商采购金额和占比 |
| API-035 | Given 苏木素批次正在使用中，When 前端更新剩余量，Then 跟踪记录remaining更新 |
| API-036 | Given 苏木素批次已耗尽，When 前端确认耗尽，Then 状态变为depleted，批次status=2 |
| API-037 | Given 管理员登录，When 导入LIS病例Excel，Then 导入成功，对账数据更新 |
| API-038 | Given 对账发现BOM用量差异，When 前端修正BOM用量，Then BOM更新，修正日志记录 |

---

## 三、盲点2: 角色-页面权限未测试的组合

### 3.1 当前仅测试了 1/200+ 的组合（跳过了）

6 角色 × ~35 页面 = ~210 个"角色-页面"组合，当前只测试了 zhangsan→/inventory（skip）。

### 3.2 未覆盖的关键组合

| 角色 | 禁止访问页面 | 应返回 |
|:---|:---|:---:|
| WHM | /cost-analysis, /projects, /bom, /users, /roles, /logs | 403/无菜单 |
| TECH | /inbound, /stocktaking, /purchase-orders, /cost-analysis, /logs, /users, /roles | 403/无菜单 |
| PATH | /inbound, /stocktaking, /purchase-orders, /logs, /users, /roles | 403/无菜单 |
| PROC | /outbound, /stocktaking, /projects, /bom, /cost-analysis, /logs, /users, /roles | 403/无菜单 |
| FIN | /inventory, /inbound, /outbound, /stocktaking, /projects, /bom, /alerts, /users, /roles | 403/无菜单 |

### 3.3 对应的新 E2E 场景

| 盲点 ID | 场景描述 |
|:---|:---|
| PERM-001 | Given WHM登录，When 直接访问 /cost-analysis，Then 页面返回403或被路由守卫拦截 |
| PERM-002 | Given WHM登录，When 直接访问 /projects，Then 返回403 |
| PERM-003 | Given WHM登录，When 直接访问 /bom，Then 返回403 |
| PERM-004 | Given WHM登录，When 直接访问 /users，Then 返回403 |
| PERM-005 | Given WHM登录，When 直接访问 /roles，Then 返回403 |
| PERM-006 | Given WHM登录，When 直接访问 /logs，Then 返回403 |
| PERM-007 | Given TECH登录，When 直接访问 /inbound，Then 返回403，侧边栏不显示"入库记录" |
| PERM-008 | Given TECH登录，When 直接访问 /stocktaking，Then 返回403 |
| PERM-009 | Given TECH登录，When 直接访问 /purchase-orders，Then 返回403 |
| PERM-010 | Given TECH登录，When 直接访问 /cost-analysis，Then 返回403 |
| PERM-011 | Given PATH登录，When 直接访问 /inbound，Then 返回403 |
| PERM-012 | Given PATH登录，When 直接访问 /stocktaking，Then 返回403 |
| PERM-013 | Given PATH登录，When 直接访问 /logs，Then 返回403 |
| PERM-014 | Given PROC登录，When 直接访问 /outbound，Then 返回403，不显示"出库记录" |
| PERM-015 | Given PROC登录，When 直接访问 /projects，Then 返回403 |
| PERM-016 | Given PROC登录，When 直接访问 /bom，Then 返回403 |
| PERM-017 | Given PROC登录，When 直接访问 /cost-analysis，Then 返回403 |
| PERM-018 | Given FIN登录，When 直接访问 /inventory，Then 返回403 |
| PERM-019 | Given FIN登录，When 直接访问 /inbound，Then 返回403 |
| PERM-020 | Given FIN登录，When 直接访问 /outbound，Then 返回403 |
| PERM-021 | Given FIN登录，When 直接访问 /projects，Then 返回403 |
| PERM-022 | Given FIN登录，When 直接访问 /alerts，Then 返回403 |
| PERM-023 | Given 各角色登录，When 检查侧边栏菜单数量，Then admin=17/WHM=13/TECH=6/PATH=7/PROC=8/FIN=3 |

---

## 四、盲点3: 物料类型差异化测试缺失

### 4.1 当前所有测试使用通用物料，未区分类型

当前测试中所有物料操作都是通用的，没有针对 IHC 抗体、HE 染色试剂、通用耗材、危化品的差异化验证。

### 4.2 对应的新 E2E 场景

| 盲点 ID | 场景描述 |
|:---|:---|
| TYPE-001 | Given 创建IHC抗体入库单（需冷链标记-20°C），When 提交，Then 入库成功，批次记录包含冷链标记，库存更新 |
| TYPE-002 | Given 创建HE染色试剂入库单（常温保存），When 提交，Then 入库成功，无冷链标记 |
| TYPE-003 | Given 创建通用耗材入库单（一次性手套，无有效期），When 提交，Then 入库成功，不创建批次或不填batchNo |
| TYPE-004 | Given 创建危化品入库单（甲醛，双人验收），When 提交，Then 系统弹出双人确认对话框，需第二人输入密码确认后方可执行 |
| TYPE-005 | Given IHC抗体临期批次（expiry_date≤today+30），When 系统扫描生成预警，Then 生成临期预警，level=danger |
| TYPE-006 | Given 通用耗材临期（无有效期字段），When 系统扫描，Then 不触发临期预警 |
| TYPE-007 | Given IHC抗体出库（按BOM），When FIFO分配，Then 优先分配最早过期批次，成本按对应入库价计算 |
| TYPE-008 | Given 危化品出库，When 提交，Then 需双人审批，审批通过后出库成功，操作日志记录审批人 |
| TYPE-009 | Given 危化品报废，When 提交，Then 需特殊处理记录，双人确认 |
| TYPE-010 | Given 通用耗材盘点，When 输入实盘，Then 不检查有效期，仅调整库存数量 |

---

## 五、盲点4: 表单字段非法值验证缺失

### 5.1 当前无任何表单非法值验证测试

当前测试只做了正向流程，没有验证任何非法输入。

### 5.2 未验证的非法值类型

| 字段类型 | 非法值 | 页面 |
|:---|:---|:---|
| 编码字段 | 超长字符串(>200)、SQL注入、XSS、特殊字符 | 物料/分类/库位/供应商/BOM/项目 |
| 数量字段 | 负数、0、小数、非数字字符串、>max_stock | 入库/出库/盘点/报废/退货 |
| 价格字段 | 负数、超大数(>999999)、非数字 | 物料/采购订单 |
| 日期字段 | 未来生产日期、过期日期早于生产日期、非法格式 | 入库单 |
| 必填字段 | 空字符串、仅空格、null | 所有创建弹窗 |
| 下拉字段 | 不存在的选项值、已禁用选项 | 所有select |
| 批次号 | 同物料重复批次号、超长批次号 | 入库单 |

### 5.3 对应的新 E2E 场景

| 盲点 ID | 场景描述 |
|:---|:---|
| FORM-001 | Given 创建物料时name输入空字符串，When 提交，Then 前端校验阻止，提示"物料名称为必填项" |
| FORM-002 | Given 创建物料时price=-10，When 提交，Then 前端校验阻止或后端返回400 |
| FORM-003 | Given 创建入库单时quantity=0，When 提交，Then 系统提示"入库数量必须大于0" |
| FORM-004 | Given 创建入库单时expiryDate < productionDate，When 提交，Then 系统提示"有效期必须晚于生产日期" |
| FORM-005 | Given 创建入库单时batchNo与同一物料已有批次重复，When 提交，Then 返回409 "批次号已存在" |
| FORM-006 | Given 创建出库单时quantity > 库存，When 提交，Then 返回422 "Insufficient stock" |
| FORM-007 | Given 创建分类时code输入SQL注入payload("' OR '1'='1")，When 提交，Then 创建成功但payload被原样存储，无SQL注入漏洞 |
| FORM-008 | Given 创建物料时name输入XSS payload("<script>alert(1)</script>")，When 提交，Then 创建成功，name原样存储，前端负责转义 |
| FORM-009 | Given 创建用户时username已存在，When 提交，Then 返回409 "Username exists" |
| FORM-010 | Given 创建采购订单时orderedQty=-5，When 提交，Then 后端未拦截可能创建成功（边界行为） |
| FORM-011 | Given 盘点时actualStock为负数，When 提交，Then 库存调整为负数（需确认业务是否允许） |
| FORM-012 | Given 编辑库位时capacity=0，When 保存，Then 更新成功，capacity=0，后续入库可能触发超库容警告 |
| FORM-013 | Given 创建供应商时email="invalid"，When 提交，Then 后端不校验邮箱格式，创建成功 |
| FORM-014 | Given 创建项目时type输入非法值"xxx"，When 提交，Then 后端可能允许创建（不校验type合法性） |
| FORM-015 | Given 创建BOM时materials为空数组[]，When 提交，Then 返回400 "Missing required fields" |
| FORM-016 | Given 预警规则threshold输入负数，When 保存，Then 后端可能未拦截，threshold更新为负数 |
| FORM-017 | Given 创建用户时password为空字符串，When 提交，Then 返回400 "Username, password and realName required" |
| FORM-018 | Given 修改角色permissions为空数组[]，When 保存，Then 该角色无任何权限 |
| FORM-019 | Given 导入LIS病例时items为空数组，When 提交，Then 返回400 "导入数据为空" |
| FORM-020 | Given 修正BOM用量时newUsage=99999，When 提交，Then 后端未拦截，BOM用量更新为极大值 |

---

## 六、盲点5: 页面交互完整性缺失

### 6.1 未测试的交互类型

| 交互类型 | 说明 | 涉及页面 |
|:---|:---|:---|
| 弹窗关闭方式 | 关闭按钮/ESC/遮罩/三种方式 | 所有25个弹窗 |
| 背景滚动锁定 | 弹窗打开时body.overflow=hidden | 所有弹窗 |
| 焦点管理 | 弹窗打开后自动聚焦第一个输入元素 | 所有弹窗 |
| 分页器 | 首页/末页/跳转/每页条数切换 | 所有列表页 |
| 搜索防抖 | 快速输入时只发送最后一次请求 | 所有搜索框 |
| 空状态 | 无数据时的友好提示和引导 | 所有列表页 |
| 导出功能 | Excel/PDF导出 | 成本报表/日志/对账 |
| Tab切换 | 详情页多Tab切换 | 库存详情/项目详情 |
| 面包屑导航 | 页面层级导航 | 详情页 |
| 响应式适配 | 移动端侧边栏/表格 | 全局 |

### 6.3 对应的新 E2E 场景

| 盲点 ID | 场景描述 |
|:---|:---|
| UI-001 | Given 打开入库登记弹窗，When 按ESC键，Then 弹窗关闭，body.overflow恢复 |
| UI-002 | Given 打开入库登记弹窗，When 点击遮罩层，Then 弹窗关闭 |
| UI-003 | Given 打开入库登记弹窗，When 检查第一个输入元素，Then 自动获得焦点 |
| UI-004 | Given 库存列表有100条数据，When 切换每页显示50条，Then 列表显示50条，分页器更新 |
| UI-005 | Given 库存列表搜索框，When 快速输入"苏"然后停顿，Then 防抖后仅发送1次请求 |
| UI-006 | Given 清空库存列表筛选条件后无数据，When 查看，Then 显示"暂无物料数据"空状态插画 |
| UI-007 | Given 成本报表有数据，When 点击"导出Excel"，Then 生成并下载Excel文件 |
| UI-008 | Given 进入库存详情页，When 切换"入库记录"/"出库记录"/"报废记录"Tab，Then 对应数据正确显示 |
| UI-009 | Given 项目详情页，When 点击"物料清单"Tab，Then 显示BOM物料及用量 |
| UI-010 | Given 移动端访问系统，When 点击汉堡菜单，Then 侧边栏滑入/滑出正常，菜单项可点击 |

---

## 七、盲点6: 数据一致性跨页面验证缺失

### 7.1 未测试的跨页面数据同步

| 触发操作 | 源页面 | 目标页面 | 预期同步 |
|:---|:---|:---|:---|
| 完成入库 | 入库弹窗 | 库存列表 | stock增加 |
| 完成出库 | 出库弹窗 | 库存列表 | stock减少 |
| 处理盘点差异 | 盘点确认 | 库存列表 | stock调整为实盘 |
| 新增供应商 | 供应商管理 | 入库弹窗 | 供应商下拉同步 |
| 新增分类 | 物料分类 | 耗材管理 | 分类下拉同步 |
| 新增库位 | 库位管理 | 入库弹窗 | 库位下拉同步 |
| 处理预警 | 预警中心 | 预警历史 | 状态同步更新 |
| 修正BOM | 对账管理 | BOM清单 | 用量同步更新 |

### 7.2 对应的新 E2E 场景

| 盲点 ID | 场景描述 |
|:---|:---|
| SYNC-001 | Given 仓库管理员在入库弹窗创建入库单（苏木素+10），When 提交后立即查看库存列表，Then 苏木素库存增加10，列表实时刷新 |
| SYNC-002 | Given 技术员创建出库单（苏木素-2），When 提交后立即查看库存列表，Then 苏木素库存减少2 |
| SYNC-003 | Given 仓库管理员确认盘点差异（苏木素实盘8，系统10），When 确认后查看库存列表，Then 库存更新为8 |
| SYNC-004 | Given 管理员新增供应商"新病理科技"，When 进入入库弹窗查看供应商下拉，Then 下拉包含"新病理科技" |
| SYNC-005 | Given 管理员新增三级分类"新小类"，When 进入耗材管理创建物料，Then 分类下拉包含"新小类" |
| SYNC-006 | Given 管理员处理预警（状态pending→handled），When 进入预警历史，Then 历史列表出现该预警记录 |
| SYNC-007 | Given 管理员修正BOM用量（苏木素0.5→0.6），When 进入BOM清单查看详情，Then 苏木素用量显示0.6，version升级 |

---

## 八、总结：新场景汇总

| 盲点类别 | 新场景数 | 累计 |
|:---|:---:|:---:|
| API 端点覆盖 (API-001~038) | 38 | 38 |
| 角色权限 (PERM-001~023) | 23 | 61 |
| 物料类型差异化 (TYPE-001~010) | 10 | 71 |
| 表单非法值 (FORM-001~020) | 20 | 91 |
| 页面交互完整性 (UI-001~010) | 10 | 101 |
| 数据一致性 (SYNC-001~007) | 7 | 108 |
| **合计** | **108** | **108** |

> **目标达成**: 当前 10 个测试 + 108 个新场景 = **118 个测试**，超过翻倍目标（100%增长）。后续轮次将继续以此分析方式扩展，逐步逼近 2000+ 目标。
