# COREONE 实验室耗材管理系统 - 全量任务流程测试清单

> **生成依据**：PROJECT_RULES.md 第3章业务模块、第5章页面跳转关系、第7章设计规范、第9章自动化审计配置
> **数据源**：mock-config.js
> **覆盖范围**：20个页面、25个弹窗、6个测试维度
> **生成日期**：2026-04-20

---

## 目录

- [模块一：库存管理模块](#模块一库存管理模块)
- [模块二：检测项目模块](#模块二检测项目模块)
- [模块三：BOM管理模块](#模块三bom管理模块)
- [模块四：基础数据模块](#模块四基础数据模块)
- [模块五：预警管理模块](#模块五预警管理模块)
- [模块六：报表统计模块](#模块六报表统计模块)
- [模块七：系统管理模块](#模块七系统管理模块)
- [跨页面数据同步测试](#跨页面数据同步测试)
- [弹窗完整性测试](#弹窗完整性测试)

---

## 模块一：库存管理模块

### 1.1 库存列表页 (inventory-list.html)

#### 数据展示验证

- [ ] **INV-LIST-001** 物料列表数据渲染验证 | 📍 位置：[pages/inventory-list.html](pages/inventory-list.html) | 📊 涉及数据：`mockData.inventory` | ✅ 预期结果：列表显示所有物料，字段包括编码、名称、规格、库存、位置、供应商、状态
- [ ] **INV-LIST-002** 库存状态标签验证 | 📍 位置：[pages/inventory-list.html](pages/inventory-list.html) | 📊 涉及数据：`stock > minStock` 判断逻辑 | ✅ 预期结果：库存充足显示🟢、库存偏低显示🟡、库存不足显示🔴
- [ ] **INV-LIST-003** 分类筛选下拉验证 | 📍 位置：[pages/inventory-list.html](pages/inventory-list.html) | 📊 涉及数据：`mockData.leafCategories` | ✅ 预期结果：下拉选项与leafCategories数组一致
- [ ] **INV-LIST-004** 供应商筛选下拉验证 | 📍 位置：[pages/inventory-list.html](pages/inventory-list.html) | 📊 涉及数据：`mockData.suppliers` | ✅ 预期结果：下拉选项与suppliers数组name字段一致
- [ ] **INV-LIST-005** 库位筛选下拉验证 | 📍 位置：[pages/inventory-list.html](pages/inventory-list.html) | 📊 涉及数据：`mockData.locations` | ✅ 预期结果：下拉选项与locations数组name字段一致
- [ ] **INV-LIST-006** 统计卡片数据验证 | 📍 位置：[pages/inventory-list.html](pages/inventory-list.html) | 📊 涉及数据：`mockData.inventory` 聚合计算 | ✅ 预期结果：物料总数、库存预警数、总价值与mock数据计算结果一致

#### 搜索筛选功能

- [ ] **INV-LIST-007** 关键词搜索验证 | 📍 位置：[pages/inventory-list.html](pages/inventory-list.html) | 📊 涉及数据：`mockData.inventory` 过滤 | ✅ 预期结果：输入物料名称/编码可正确筛选
- [ ] **INV-LIST-008** 组合筛选验证 | 📍 位置：[pages/inventory-list.html](pages/inventory-list.html) | 📊 涉及数据：多条件过滤 | ✅ 预期结果：分类+状态+供应商组合筛选结果正确
- [ ] **INV-LIST-009** 重置筛选验证 | 📍 位置：[pages/inventory-list.html](pages/inventory-list.html) | 📊 涉及数据：无 | ✅ 预期结果：点击重置按钮后恢复默认显示

#### 边界与异常测试

- [ ] **INV-LIST-010** 空状态显示验证 | 📍 位置：[pages/inventory-list.html](pages/inventory-list.html) | 📊 涉及数据：空数组 | ✅ 预期结果：显示"暂无物料数据"空状态提示
- [ ] **INV-LIST-011** Toast反馈验证 | 📍 位置：[pages/inventory-list.html](pages/inventory-list.html) | 📊 涉及数据：无 | ✅ 预期结果：操作成功/失败时显示对应Toast提示

#### 页面跳转验证

- [ ] **INV-LIST-012** 跳转库存详情验证 | 📍 位置：[pages/inventory-list.html](pages/inventory-list.html) → [pages/inventory-detail.html](pages/inventory-detail.html) | 📊 涉及数据：`?id=MAT-001` | ✅ 预期结果：点击物料行跳转到详情页并传递物料ID
- [ ] **INV-LIST-013** 跳转入库记录验证 | 📍 位置：[pages/inventory-list.html](pages/inventory-list.html) → [pages/inbound.html](pages/inbound.html) | 📊 涉及数据：无 | ✅ 预期结果：侧边栏导航正确跳转
- [ ] **INV-LIST-014** 跳转出库记录验证 | 📍 位置：[pages/inventory-list.html](pages/inventory-list.html) → [pages/outbound.html](pages/outbound.html) | 📊 涉及数据：无 | ✅ 预期结果：侧边栏导航正确跳转

---

### 1.2 库存详情页 (inventory-detail.html)

#### 数据展示验证

- [ ] **INV-DET-001** 物料基本信息验证 | 📍 位置：[pages/inventory-detail.html](pages/inventory-detail.html) | 📊 涉及数据：`mockData.inventory[0]` | ✅ 预期结果：显示物料编码、名称、规格、单位、位置、供应商
- [ ] **INV-DET-002** 库存数量验证 | 📍 位置：[pages/inventory-detail.html](pages/inventory-detail.html) | 📊 涉及数据：`mockData.inventory[0].stock` | ✅ 预期结果：当前库存显示正确数值
- [ ] **INV-DET-003** 库存状态判断验证 | 📍 位置：[pages/inventory-detail.html](pages/inventory-detail.html) | 📊 涉及数据：`stock vs minStock` | ✅ 预期结果：状态标签与库存数量关系正确
- [ ] **INV-DET-004** 入库记录Tab验证 | 📍 位置：[pages/inventory-detail.html](pages/inventory-detail.html) | 📊 涉及数据：`mockData.inboundRecords` 过滤 | ✅ 预期结果：显示该物料的所有入库记录
- [ ] **INV-DET-005** 出库记录Tab验证 | 📍 位置：[pages/inventory-detail.html](pages/inventory-detail.html) | 📊 涉及数据：`mockData.outboundRecords` 过滤 | ✅ 预期结果：显示该物料的所有出库记录
- [ ] **INV-DET-006** 报废记录Tab验证 | 📍 位置：[pages/inventory-detail.html](pages/inventory-detail.html) | 📊 涉及数据：`mockData.scrapRecords` 过滤 | ✅ 预期结果：显示该物料的所有报废记录

#### CRUD操作验证

- [ ] **INV-DET-007** 编辑物料信息验证 | 📍 位置：[pages/inventory-detail.html](pages/inventory-detail.html) → 编辑弹窗 | 📊 涉及数据：`mockData.inventory` 更新 | ✅ 预期结果：修改后信息保存成功，页面刷新显示新数据
- [ ] **INV-DET-008** 快捷入库验证 | 📍 位置：[pages/inventory-detail.html](pages/inventory-detail.html) → [pages/inbound.html](pages/inbound.html) | 📊 涉及数据：URL参数 `?action=add&materialId=MAT-001` | ✅ 预期结果：跳转入库页并预填物料信息

---

### 1.3 入库记录页 (inbound.html)

#### 数据展示验证

- [ ] **INB-001** 入库记录列表验证 | 📍 位置：[pages/inbound.html](pages/inbound.html) | 📊 涉及数据：`mockData.inboundRecords` | ✅ 预期结果：列表显示所有入库记录，字段包括单号、物料、数量、供应商、操作人、时间、状态
- [ ] **INB-002** 状态标签验证 | 📍 位置：[pages/inbound.html](pages/inbound.html) | 📊 涉及数据：`status: pending/completed` | ✅ 预期结果：待入库显示黄色、已完成显示绿色
- [ ] **INB-003** 供应商下拉验证 | 📍 位置：[pages/inbound.html](pages/inbound.html) 筛选区 | 📊 涉及数据：`mockData.suppliers` | ✅ 预期结果：下拉选项与suppliers数组一致

#### CRUD闭环测试

- [ ] **INB-004** 创建入库单验证 | 📍 位置：[pages/inbound.html](pages/inbound.html) → 入库弹窗 | 📊 涉及数据：`mockApi.createInboundRecord()` | ✅ 预期结果：新增入库记录出现在列表顶部
- [ ] **INB-005** 查看入库详情验证 | 📍 位置：[pages/inbound.html](pages/inbound.html) → 详情弹窗 | 📊 涉及数据：`mockData.inboundRecords[0]` | ✅ 预期结果：弹窗显示完整入库信息
- [ ] **INB-006** 取消入库验证 | 📍 位置：[pages/inbound.html](pages/inbound.html) | 📊 涉及数据：`status: cancelled` | ✅ 预期结果：待入库状态可取消，取消后状态变更

#### 状态流转测试

- [ ] **INB-007** 入库状态流转验证 | 📍 位置：[pages/inbound.html](pages/inbound.html) | 📊 涉及数据：`pending → completed` | ✅ 预期结果：确认入库后状态变为已完成

---

### 1.4 出库记录页 (outbound.html)

#### 数据展示验证

- [ ] **OUT-001** 出库记录列表验证 | 📍 位置：[pages/outbound.html](pages/outbound.html) | 📊 涉及数据：`mockData.outboundRecords` | ✅ 预期结果：列表显示所有出库记录
- [ ] **OUT-002** 关联检测项目验证 | 📍 位置：[pages/outbound.html](pages/outbound.html) | 📊 涉及数据：`mockData.outboundRecords.projectName` | ✅ 预期结果：出库记录显示关联的检测项目名称
- [ ] **OUT-003** 物料选择器验证 | 📍 位置：[pages/outbound.html](pages/outbound.html) 出库弹窗 | 📊 涉及数据：`mockData.inventory` | ✅ 预期结果：物料选择器显示所有可用物料

#### CRUD闭环测试

- [ ] **OUT-004** 创建出库单验证 | 📍 位置：[pages/outbound.html](pages/outbound.html) → 出库弹窗 | 📊 涉及数据：`mockApi.createOutboundRecord()` | ✅ 预期结果：新增出库记录出现在列表顶部
- [ ] **OUT-005** 查看出库详情验证 | 📍 位置：[pages/outbound.html](pages/outbound.html) → 详情弹窗 | 📊 涉及数据：`mockData.outboundRecords[0]` | ✅ 预期结果：弹窗显示完整出库信息

#### 边界与异常测试

- [ ] **OUT-006** 库存不足出库限制验证 | 📍 位置：[pages/outbound.html](pages/outbound.html) 出库弹窗 | 📊 涉及数据：`stock < quantity` | ✅ 预期结果：Toast提示"库存不足，无法出库"，阻止提交

---

### 1.5 库存盘点页 (stocktaking.html)

#### 数据展示验证

- [ ] **STK-001** 盘点记录列表验证 | 📍 位置：[pages/stocktaking.html](pages/stocktaking.html) | 📊 涉及数据：`mockData.stocktakingRecords` | ✅ 预期结果：列表显示所有盘点记录
- [ ] **STK-002** 差异数量验证 | 📍 位置：[pages/stocktaking.html](pages/stocktaking.html) | 📊 涉及数据：`totalCount - matchedCount` | ✅ 预期结果：差异数量计算正确
- [ ] **STK-003** 盘点状态验证 | 📍 位置：[pages/stocktaking.html](pages/stocktaking.html) | 📊 涉及数据：`status: in_progress/completed` | ✅ 预期结果：状态标签显示正确

#### CRUD闭环测试

- [ ] **STK-004** 新建盘点单验证 | 📍 位置：[pages/stocktaking.html](pages/stocktaking.html) → 新建盘点弹窗 | 📊 涉及数据：新建盘点记录 | ✅ 预期结果：盘点单创建成功，状态为"进行中"
- [ ] **STK-005** 查看盘点详情验证 | 📍 位置：[pages/stocktaking.html](pages/stocktaking.html) → 详情弹窗 | 📊 涉及数据：`mockData.stocktakingRecords[0]` | ✅ 预期结果：弹窗显示盘点明细和差异项

#### 状态流转测试

- [ ] **STK-006** 处理盘点差异验证 | 📍 位置：[pages/stocktaking.html](pages/stocktaking.html) → 处理差异弹窗 | 📊 涉及数据：`stock` 更新 | ✅ 预期结果：确认调整后库存数量更新，盘点状态变为已完成

---

### 1.6 退货管理页 (return.html)

#### 数据展示验证

- [ ] **RET-001** 退货记录列表验证 | 📍 位置：[pages/return.html](pages/return.html) | 📊 涉及数据：退货记录数据 | ✅ 预期结果：列表显示所有退货记录
- [ ] **RET-002** 供应商下拉验证 | 📍 位置：[pages/return.html](pages/return.html) 筛选区 | 📊 涉及数据：`mockData.suppliers` | ✅ 预期结果：下拉选项与suppliers数组一致

#### CRUD闭环测试

- [ ] **RET-003** 创建退货单验证 | 📍 位置：[pages/return.html](pages/return.html) → 退货弹窗 | 📊 涉及数据：新建退货记录 | ✅ 预期结果：退货记录创建成功

---

### 1.7 报废管理页 (scrap.html)

#### 数据展示验证

- [ ] **SCP-001** 报废记录列表验证 | 📍 位置：[pages/scrap.html](pages/scrap.html) | 📊 涉及数据：`mockData.scrapRecords` | ✅ 预期结果：列表显示所有报废记录
- [ ] **SCP-002** 报废原因验证 | 📍 位置：[pages/scrap.html](pages/scrap.html) | 📊 涉及数据：`reason` 字段 | ✅ 预期结果：报废原因显示正确

#### CRUD闭环测试

- [ ] **SCP-003** 创建报废申请验证 | 📍 位置：[pages/scrap.html](pages/scrap.html) → 报废申请弹窗 | 📊 涉及数据：`mockApi.createScrapRecord()` | ✅ 预期结果：报废申请创建成功

#### 状态流转测试

- [ ] **SCP-004** 报废状态流转验证 | 📍 位置：[pages/scrap.html](pages/scrap.html) | 📊 涉及数据：`pending → approved → executed` | ✅ 预期结果：报废申请经审批后执行

---

## 模块二：检测项目模块

### 2.1 检测项目列表页 (projects.html)

#### 数据展示验证

- [ ] **PRJ-001** 检测项目列表验证 | 📍 位置：[pages/projects.html](pages/projects.html) | 📊 涉及数据：`mockData.projects` | ✅ 预期结果：列表显示所有检测项目
- [ ] **PRJ-002** 项目类型标签验证 | 📍 位置：[pages/projects.html](pages/projects.html) | 📊 涉及数据：`mockData.projectTypes` | ✅ 预期结果：类型标签颜色和文字与定义一致
- [ ] **PRJ-003** 可支撑样本数验证 | 📍 位置：[pages/projects.html](pages/projects.html) | 📊 涉及数据：`supportableSamples` | ✅ 预期结果：显示BOM物料可支撑的样本数
- [ ] **PRJ-004** BOM下拉选项验证 | 📍 位置：[pages/projects.html](pages/projects.html) 新建/编辑弹窗 | 📊 涉及数据：`mockData.boms` | ✅ 预期结果：BOM下拉选项从boms数组动态渲染

#### CRUD闭环测试

- [ ] **PRJ-005** 新建检测项目验证 | 📍 位置：[pages/projects.html](pages/projects.html) → 新建项目弹窗 | 📊 涉及数据：`mockApi.createProject()` | ✅ 预期结果：项目创建成功，列表新增记录
- [ ] **PRJ-006** 编辑检测项目验证 | 📍 位置：[pages/projects.html](pages/projects.html) → 编辑项目弹窗 | 📊 涉及数据：`mockApi.updateProject()` | ✅ 预期结果：项目信息更新成功
- [ ] **PRJ-007** 删除检测项目验证 | 📍 位置：[pages/projects.html](pages/projects.html) | 📊 涉及数据：`mockApi.deleteProject()` | ✅ 预期结果：项目删除成功，列表移除记录

#### 边界与异常测试

- [ ] **PRJ-008** 空状态显示验证 | 📍 位置：[pages/projects.html](pages/projects.html) | 📊 涉及数据：空数组 | ✅ 预期结果：显示"暂无检测服务数据"空状态提示

#### 页面跳转验证

- [ ] **PRJ-009** 跳转项目详情验证 | 📍 位置：[pages/projects.html](pages/projects.html) → [pages/project-detail.html](pages/project-detail.html) | 📊 涉及数据：`?id=HE-001` | ✅ 预期结果：跳转到详情页并传递项目ID
- [ ] **PRJ-010** 跳转BOM清单验证 | 📍 位置：[pages/projects.html](pages/projects.html) → [pages/bom.html](pages/bom.html) | 📊 涉及数据：无 | ✅ 预期结果：点击BOM名称跳转到BOM详情

---

### 2.2 项目详情页 (project-detail.html)

#### 数据展示验证

- [ ] **PRJ-DET-001** 项目基本信息验证 | 📍 位置：[pages/project-detail.html](pages/project-detail.html) | 📊 涉及数据：`mockData.projects[0]` | ✅ 预期结果：显示项目编码、名称、类型、周期、负责人
- [ ] **PRJ-DET-002** 关联BOM信息验证 | 📍 位置：[pages/project-detail.html](pages/project-detail.html) | 📊 涉及数据：`bomId, bomName, bomVersion` | ✅ 预期结果：显示关联的BOM名称和版本
- [ ] **PRJ-DET-003** 物料清单Tab验证 | 📍 位置：[pages/project-detail.html](pages/project-detail.html) | 📊 涉及数据：`mockData.boms[0].materials` | ✅ 预期结果：显示BOM中的所有物料及用量
- [ ] **PRJ-DET-004** 使用记录Tab验证 | 📍 位置：[pages/project-detail.html](pages/project-detail.html) | 📊 涉及数据：`mockData.outboundRecords` 过滤 | ✅ 预期结果：显示该项目的出库使用记录

---

## 模块三：BOM管理模块

### 3.1 BOM清单页 (bom.html)

#### 数据展示验证

- [ ] **BOM-001** BOM列表验证 | 📍 位置：[pages/bom.html](pages/bom.html) | 📊 涉及数据：`mockData.boms` | ✅ 预期结果：列表显示所有BOM记录
- [ ] **BOM-002** 物料状态标签验证 | 📍 位置：[pages/bom.html](pages/bom.html) | 📊 涉及数据：`materialStatus: sufficient/low/insufficient` | ✅ 预期结果：🟢充足、🟡偏低、🔴不足
- [ ] **BOM-003** 物料搜索验证 | 📍 位置：[pages/bom.html](pages/bom.html) 添加物料弹窗 | 📊 涉及数据：`mockData.materials` | ✅ 预期结果：搜索结果从materials数组动态渲染

#### CRUD闭环测试

- [ ] **BOM-004** 新建BOM验证 | 📍 位置：[pages/bom.html](pages/bom.html) → 新建BOM弹窗 | 📊 涉及数据：`mockApi.createBom()` | ✅ 预期结果：BOM创建成功，版本为v1.0
- [ ] **BOM-005** 编辑BOM验证 | 📍 位置：[pages/bom.html](pages/bom.html) → 编辑BOM弹窗 | 📊 涉及数据：`mockApi.updateBom()` | ✅ 预期结果：编辑后版本号自动递增
- [ ] **BOM-006** 删除BOM验证 | 📍 位置：[pages/bom.html](pages/bom.html) | 📊 涉及数据：`mockApi.deleteBom()` | ✅ 预期结果：BOM删除成功

#### 边界与异常测试

- [ ] **BOM-007** 空状态显示验证 | 📍 位置：[pages/bom.html](pages/bom.html) | 📊 涉及数据：空数组 | ✅ 预期结果：显示"暂无BOM数据"空状态提示

---

### 3.2 BOM版本页 (bom-versions.html)

#### 数据展示验证

- [ ] **BOM-VER-001** 版本历史列表验证 | 📍 位置：[pages/bom-versions.html](pages/bom-versions.html) | 📊 涉及数据：BOM版本历史 | ✅ 预期结果：显示BOM的所有历史版本
- [ ] **BOM-VER-002** 版本变更记录验证 | 📍 位置：[pages/bom-versions.html](pages/bom-versions.html) | 📊 涉及数据：版本变更详情 | ✅ 预期结果：显示每个版本的变更内容

---

## 模块四：基础数据模块

### 4.1 物料分类页 (categories.html)

#### 数据展示验证

- [ ] **CAT-001** 分类树结构验证 | 📍 位置：[pages/categories.html](pages/categories.html) | 📊 涉及数据：`mockData.categories` | ✅ 预期结果：三级分类树正确展示
- [ ] **CAT-002** 分类统计验证 | 📍 位置：[pages/categories.html](pages/categories.html) | 📊 涉及数据：`mockData.categoryStats` | ✅ 预期结果：统计卡片显示各级分类数量

#### CRUD闭环测试

- [ ] **CAT-003** 新建分类验证 | 📍 位置：[pages/categories.html](pages/categories.html) → 新建分类弹窗 | 📊 涉及数据：新增分类节点 | ✅ 预期结果：分类创建成功，树结构更新
- [ ] **CAT-004** 编辑分类验证 | 📍 位置：[pages/categories.html](pages/categories.html) → 编辑分类弹窗 | 📊 涉及数据：更新分类信息 | ✅ 预期结果：分类名称更新成功
- [ ] **CAT-005** 删除分类验证 | 📍 位置：[pages/categories.html](pages/categories.html) | 📊 涉及数据：删除分类节点 | ✅ 预期结果：分类删除成功

#### 边界与异常测试

- [ ] **CAT-006** 删除有物料的分类验证 | 📍 位置：[pages/categories.html](pages/categories.html) | 📊 涉及数据：`count > 0` 的分类 | ✅ 预期结果：Toast提示"该分类下存在物料，无法删除"

---

### 4.2 耗材配置页 (consumable-config.html)

#### 数据展示验证

- [ ] **CON-001** 耗材列表验证 | 📍 位置：[pages/consumable-config.html](pages/consumable-config.html) | 📊 涉及数据：`mockData.consumables` | ✅ 预期结果：列表显示所有耗材配置
- [ ] **CON-002** 分类下拉验证 | 📍 位置：[pages/consumable-config.html](pages/consumable-config.html) | 📊 涉及数据：`mockData.leafCategories` | ✅ 预期结果：分类下拉从leafCategories动态渲染
- [ ] **CON-003** 供应商下拉验证 | 📍 位置：[pages/consumable-config.html](pages/consumable-config.html) | 📊 涉及数据：`mockData.suppliers` | ✅ 预期结果：供应商下拉从suppliers动态渲染
- [ ] **CON-004** 单位下拉验证 | 📍 位置：[pages/consumable-config.html](pages/consumable-config.html) | 📊 涉及数据：`mockData.units` | ✅ 预期结果：单位下拉从units动态渲染

#### CRUD闭环测试

- [ ] **CON-005** 新增耗材验证 | 📍 位置：[pages/consumable-config.html](pages/consumable-config.html) → 新增耗材弹窗 | 📊 涉及数据：`mockApi.createConsumable()` | ✅ 预期结果：耗材创建成功
- [ ] **CON-006** 编辑耗材验证 | 📍 位置：[pages/consumable-config.html](pages/consumable-config.html) → 编辑耗材弹窗 | 📊 涉及数据：`mockApi.updateConsumable()` | ✅ 预期结果：耗材信息更新成功
- [ ] **CON-007** 删除耗材验证 | 📍 位置：[pages/consumable-config.html](pages/consumable-config.html) | 📊 涉及数据：`mockApi.deleteConsumable()` | ✅ 预期结果：耗材删除成功

---

## 模块五：预警管理模块

### 5.1 规则配置页 (rules.html)

#### 数据展示验证

- [ ] **RULE-001** 规则列表验证 | 📍 位置：[pages/rules.html](pages/rules.html) | 📊 涉及数据：预警规则数据 | ✅ 预期结果：列表显示所有预警规则
- [ ] **RULE-002** 规则类型标签验证 | 📍 位置：[pages/rules.html](pages/rules.html) | 📊 涉及数据：规则类型枚举 | ✅ 预期结果：类型标签显示正确

#### CRUD闭环测试

- [ ] **RULE-003** 新建规则验证 | 📍 位置：[pages/rules.html](pages/rules.html) → 新建规则弹窗 | 📊 涉及数据：新增预警规则 | ✅ 预期结果：规则创建成功
- [ ] **RULE-004** 编辑规则验证 | 📍 位置：[pages/rules.html](pages/rules.html) → 编辑规则弹窗 | 📊 涉及数据：更新规则信息 | ✅ 预期结果：规则更新成功
- [ ] **RULE-005** 删除规则验证 | 📍 位置：[pages/rules.html](pages/rules.html) | 📊 涉及数据：删除规则 | ✅ 预期结果：规则删除成功

---

### 5.2 预警中心页 (alerts.html)

#### 数据展示验证

- [ ] **ALERT-001** 预警列表验证 | 📍 位置：[pages/alerts.html](pages/alerts.html) | 📊 涉及数据：预警数据 | ✅ 预期结果：列表显示所有待处理预警
- [ ] **ALERT-002** 预警类型标签验证 | 📍 位置：[pages/alerts.html](pages/alerts.html) | 📊 涉及数据：`alertTypes` 枚举 | ✅ 预期结果：库存不足🔴、即将过期🟡、消耗异常🟢
- [ ] **ALERT-003** 预警状态下拉验证 | 📍 位置：[pages/alerts.html](pages/alerts.html) 筛选区 | 📊 涉及数据：`alertStatuses` 枚举 | ✅ 预期结果：待处理、已处理选项正确

#### 状态流转测试

- [ ] **ALERT-004** 处理预警验证 | 📍 位置：[pages/alerts.html](pages/alerts.html) → 处理预警弹窗 | 📊 涉及数据：`status: pending → processed` | ✅ 预期结果：预警状态变为已处理

#### 批量操作测试

- [ ] **ALERT-005** 批量选择验证 | 📍 位置：[pages/alerts.html](pages/alerts.html) | 📊 涉及数据：无 | ✅ 预期结果：全选/单选功能正常
- [ ] **ALERT-006** 批量处理验证 | 📍 位置：[pages/alerts.html](pages/alerts.html) | 📊 涉及数据：多条预警 | ✅ 预期结果：批量处理成功

---

### 5.3 预警历史页 (alert-history.html)

#### 数据展示验证

- [ ] **ALERT-HIST-001** 历史记录列表验证 | 📍 位置：[pages/alert-history.html](pages/alert-history.html) | 📊 涉及数据：已处理预警 | ✅ 预期结果：列表显示所有历史预警
- [ ] **ALERT-HIST-002** 处理人验证 | 📍 位置：[pages/alert-history.html](pages/alert-history.html) | 📊 涉及数据：`processedBy` 字段 | ✅ 预期结果：显示处理人信息

---

## 模块六：报表统计模块

### 6.1 成本报表页 (cost-report.html)

#### 数据展示验证

- [ ] **COST-RPT-001** 成本汇总卡片验证 | 📍 位置：[pages/cost-report.html](pages/cost-report.html) | 📊 涉及数据：`mockData.costAnalysis.summary` | ✅ 预期结果：总成本、项目成本、公共成本显示正确
- [ ] **COST-RPT-002** 项目成本列表验证 | 📍 位置：[pages/cost-report.html](pages/cost-report.html) | 📊 涉及数据：`mockData.costAnalysis.projectCosts` | ✅ 预期结果：列表显示各项目成本明细
- [ ] **COST-RPT-003** 图表数据验证 | 📍 位置：[pages/cost-report.html](pages/cost-report.html) | 📊 涉及数据：成本分析图表数据 | ✅ 预期结果：图表数据与mock数据一致

#### 页面跳转验证

- [ ] **COST-RPT-004** 跳转检测项目验证 | 📍 位置：[pages/cost-report.html](pages/cost-report.html) → [pages/projects.html](pages/projects.html) | 📊 涉及数据：筛选条件传递 | ✅ 预期结果：点击项目名称跳转并传递筛选条件
- [ ] **COST-RPT-005** 跳转供应商管理验证 | 📍 位置：[pages/cost-report.html](pages/cost-report.html) → [pages/suppliers.html](pages/suppliers.html) | 📊 涉及数据：筛选条件传递 | ✅ 预期结果：点击供应商名称跳转

---

### 6.2 物料成本分析页 (cost-analysis.html)

#### 数据展示验证

- [ ] **COST-ANA-001** 成本分析Tab验证 | 📍 位置：[pages/cost-analysis.html](pages/cost-analysis.html) | 📊 涉及数据：`mockData.costAnalysis` | ✅ 预期结果：各Tab数据正确显示
- [ ] **COST-ANA-002** 供应商成本验证 | 📍 位置：[pages/cost-analysis.html](pages/cost-analysis.html) | 📊 涉及数据：`mockData.costAnalysis.supplierCosts` | ✅ 预期结果：供应商成本数据与suppliersData一致
- [ ] **COST-ANA-003** 公共成本验证 | 📍 位置：[pages/cost-analysis.html](pages/cost-analysis.html) | 📊 涉及数据：`mockData.costAnalysis.publicCosts` | ✅ 预期结果：公共成本明细显示正确

---

## 模块七：系统管理模块

### 7.1 供应商管理页 (suppliers.html)

#### 数据展示验证

- [ ] **SUP-001** 供应商列表验证 | 📍 位置：[pages/suppliers.html](pages/suppliers.html) | 📊 涉及数据：`mockData.suppliers` | ✅ 预期结果：列表显示所有供应商
- [ ] **SUP-002** 合作状态标签验证 | 📍 位置：[pages/suppliers.html](pages/suppliers.html) | 📊 涉及数据：`status: active/inactive` | ✅ 预期结果：合作中显示绿色、已暂停显示灰色

#### CRUD闭环测试

- [ ] **SUP-003** 新增供应商验证 | 📍 位置：[pages/suppliers.html](pages/suppliers.html) → 新增供应商弹窗 | 📊 涉及数据：新增供应商记录 | ✅ 预期结果：供应商创建成功
- [ ] **SUP-004** 编辑供应商验证 | 📍 位置：[pages/suppliers.html](pages/suppliers.html) → 编辑供应商弹窗 | 📊 涉及数据：更新供应商信息 | ✅ 预期结果：供应商信息更新成功
- [ ] **SUP-005** 删除供应商验证 | 📍 位置：[pages/suppliers.html](pages/suppliers.html) | 📊 涉及数据：删除供应商 | ✅ 预期结果：供应商删除成功

---

### 7.2 库位管理页 (locations.html)

#### 数据展示验证

- [ ] **LOC-001** 库位树结构验证 | 📍 位置：[pages/locations.html](pages/locations.html) | 📊 涉及数据：`mockData.locations` | ✅ 预期结果：库位树按区域正确展示
- [ ] **LOC-002** 库位卡片验证 | 📍 位置：[pages/locations.html](pages/locations.html) | 📊 涉及数据：`mockData.locations` | ✅ 预期结果：卡片显示库位详情和利用率
- [ ] **LOC-003** 库位状态标签验证 | 📍 位置：[pages/locations.html](pages/locations.html) | 📊 涉及数据：`status: active/inactive` | ✅ 预期结果：在用/空闲标签显示正确

#### CRUD闭环测试

- [ ] **LOC-004** 新增库位验证 | 📍 位置：[pages/locations.html](pages/locations.html) → 新增库位弹窗 | 📊 涉及数据：新增库位记录 | ✅ 预期结果：库位创建成功
- [ ] **LOC-005** 编辑库位验证 | 📍 位置：[pages/locations.html](pages/locations.html) → 编辑库位弹窗 | 📊 涉及数据：更新库位信息 | ✅ 预期结果：库位信息更新成功

---

### 7.3 用户管理页 (users.html)

#### 数据展示验证

- [ ] **USR-001** 用户列表验证 | 📍 位置：[pages/users.html](pages/users.html) | 📊 涉及数据：用户数据 | ✅ 预期结果：列表显示所有系统用户
- [ ] **USR-002** 角色标签验证 | 📍 位置：[pages/users.html](pages/users.html) | 📊 涉及数据：角色枚举 | ✅ 预期结果：角色标签显示正确

#### CRUD闭环测试

- [ ] **USR-003** 新增用户验证 | 📍 位置：[pages/users.html](pages/users.html) → 新增用户弹窗 | 📊 涉及数据：新增用户记录 | ✅ 预期结果：用户创建成功
- [ ] **USR-004** 编辑用户验证 | 📍 位置：[pages/users.html](pages/users.html) → 编辑用户弹窗 | 📊 涉及数据：更新用户信息 | ✅ 预期结果：用户信息更新成功
- [ ] **USR-005** 删除用户验证 | 📍 位置：[pages/users.html](pages/users.html) | 📊 涉及数据：删除用户 | ✅ 预期结果：用户删除成功

---

## 跨页面数据同步测试

### 入库→库存同步

- [ ] **SYNC-001** 入库后库存增加验证 | 📍 位置：[pages/inbound.html](pages/inbound.html) → [pages/inventory-list.html](pages/inventory-list.html) | 📊 涉及数据：`stateManager.addInboundRecord()` | ✅ 预期结果：入库完成后，库存列表对应物料stock增加

### 出库→库存同步

- [ ] **SYNC-002** 出库后库存减少验证 | 📍 位置：[pages/outbound.html](pages/outbound.html) → [pages/inventory-list.html](pages/inventory-list.html) | 📊 涉及数据：`stateManager.addOutboundRecord()` | ✅ 预期结果：出库完成后，库存列表对应物料stock减少

### 盘点差异→库存同步

- [ ] **SYNC-003** 盘点差异处理后库存更新验证 | 📍 位置：[pages/stocktaking.html](pages/stocktaking.html) → [pages/inventory-list.html](pages/inventory-list.html) | 📊 涉及数据：盘点调整 | ✅ 预期结果：差异确认后，库存数量调整为盘点值

### 报废→库存同步

- [ ] **SYNC-004** 报废后库存减少验证 | 📍 位置：[pages/scrap.html](pages/scrap.html) → [pages/inventory-list.html](pages/inventory-list.html) | 📊 涉及数据：`stateManager.addScrapRecord()` | ✅ 预期结果：报废完成后，库存列表对应物料stock减少

### 分类→耗材配置同步

- [ ] **SYNC-005** 新增分类后耗材配置下拉同步验证 | 📍 位置：[pages/categories.html](pages/categories.html) → [pages/consumable-config.html](pages/consumable-config.html) | 📊 涉及数据：`mockData.leafCategories` | ✅ 预期结果：新增分类后，耗材配置页分类下拉包含新分类

### 供应商→入库下拉同步

- [ ] **SYNC-006** 新增供应商后入库下拉同步验证 | 📍 位置：[pages/suppliers.html](pages/suppliers.html) → [pages/inbound.html](pages/inbound.html) | 📊 涉及数据：`mockData.suppliers` | ✅ 预期结果：新增供应商后，入库页供应商下拉包含新供应商

### 规则→预警同步

- [ ] **SYNC-007** 新增规则后预警产生验证 | 📍 位置：[pages/rules.html](pages/rules.html) → [pages/alerts.html](pages/alerts.html) | 📊 涉及数据：预警规则触发 | ✅ 预期结果：满足规则条件时，预警中心产生新预警

### 预警处理→历史同步

- [ ] **SYNC-008** 预警处理后历史记录验证 | 📍 位置：[pages/alerts.html](pages/alerts.html) → [pages/alert-history.html](pages/alert-history.html) | 📊 涉及数据：已处理预警 | ✅ 预期结果：预警处理后，预警历史页出现新记录

---

## 弹窗完整性测试

> 依据 PROJECT_RULES.md 第7.2节弹窗规范，对25个弹窗逐一验证以下功能：
> - [ ] 三种关闭方式（按钮、遮罩、ESC）
> - [ ] 打开时背景滚动锁定
> - [ ] 打开后焦点自动聚焦第一个输入元素
> - [ ] 关闭后焦点返回触发元素

### 库存管理模块弹窗

- [ ] **MODAL-001** inventory-detail-modal.html 弹窗完整性验证 | 📍 位置：[modals/inventory-detail-modal.html](modals/inventory-detail-modal.html)
- [ ] **MODAL-002** inbound-modal.html 弹窗完整性验证 | 📍 位置：[modals/inbound-modal.html](modals/inbound-modal.html)
- [ ] **MODAL-003** inbound-detail-modal.html 弹窗完整性验证 | 📍 位置：[modals/inbound-detail-modal.html](modals/inbound-detail-modal.html)
- [ ] **MODAL-004** outbound-modal.html 弹窗完整性验证 | 📍 位置：[modals/outbound-modal.html](modals/outbound-modal.html)
- [ ] **MODAL-005** outbound-detail-modal.html 弹窗完整性验证 | 📍 位置：[modals/outbound-detail-modal.html](modals/outbound-detail-modal.html)
- [ ] **MODAL-006** create-stocktaking-modal.html 弹窗完整性验证 | 📍 位置：[modals/create-stocktaking-modal.html](modals/create-stocktaking-modal.html)
- [ ] **MODAL-007** stocktaking-detail-modal.html 弹窗完整性验证 | 📍 位置：[modals/stocktaking-detail-modal.html](modals/stocktaking-detail-modal.html)
- [ ] **MODAL-008** stocktaking-adjust-modal.html 弹窗完整性验证 | 📍 位置：[modals/stocktaking-adjust-modal.html](modals/stocktaking-adjust-modal.html)
- [ ] **MODAL-009** scrap-apply-modal.html 弹窗完整性验证 | 📍 位置：[modals/scrap-apply-modal.html](modals/scrap-apply-modal.html)

### 检测项目模块弹窗

- [ ] **MODAL-010** create-project-modal.html 弹窗完整性验证 | 📍 位置：[modals/create-project-modal.html](modals/create-project-modal.html)
- [ ] **MODAL-011** edit-project-modal.html 弹窗完整性验证 | 📍 位置：[modals/edit-project-modal.html](modals/edit-project-modal.html)

### BOM管理模块弹窗

- [ ] **MODAL-012** create-bom-modal.html 弹窗完整性验证 | 📍 位置：[modals/create-bom-modal.html](modals/create-bom-modal.html)
- [ ] **MODAL-013** edit-bom-modal.html 弹窗完整性验证 | 📍 位置：[modals/edit-bom-modal.html](modals/edit-bom-modal.html)
- [ ] **MODAL-014** bom-detail-modal.html 弹窗完整性验证 | 📍 位置：[modals/bom-detail-modal.html](modals/bom-detail-modal.html)
- [ ] **MODAL-015** add-bom-modal.html 弹窗完整性验证 | 📍 位置：[modals/add-bom-modal.html](modals/add-bom-modal.html)
- [ ] **MODAL-016** edit-bom-item-modal.html 弹窗完整性验证 | 📍 位置：[modals/edit-bom-item-modal.html](modals/edit-bom-item-modal.html)

### 基础数据模块弹窗

- [ ] **MODAL-017** create-category-modal.html 弹窗完整性验证 | 📍 位置：[modals/create-category-modal.html](modals/create-category-modal.html)
- [ ] **MODAL-018** edit-category-modal.html 弹窗完整性验证 | 📍 位置：[modals/edit-category-modal.html](modals/edit-category-modal.html)
- [ ] **MODAL-019** create-consumable-modal.html 弹窗完整性验证 | 📍 位置：[modals/create-consumable-modal.html](modals/create-consumable-modal.html)
- [ ] **MODAL-020** edit-consumable-modal.html 弹窗完整性验证 | 📍 位置：[modals/edit-consumable-modal.html](modals/edit-consumable-modal.html)
- [ ] **MODAL-021** consumable-detail-modal.html 弹窗完整性验证 | 📍 位置：[modals/consumable-detail-modal.html](modals/consumable-detail-modal.html)

### 预警管理模块弹窗

- [ ] **MODAL-022** create-rule-modal.html 弹窗完整性验证 | 📍 位置：[modals/create-rule-modal.html](modals/create-rule-modal.html)
- [ ] **MODAL-023** edit-rule-modal.html 弹窗完整性验证 | 📍 位置：[modals/edit-rule-modal.html](modals/edit-rule-modal.html)
- [ ] **MODAL-024** alert-handle-modal.html 弹窗完整性验证 | 📍 位置：[modals/alert-handle-modal.html](modals/alert-handle-modal.html)
- [ ] **MODAL-025** alert-history-detail-modal.html 弹窗完整性验证 | 📍 位置：[modals/alert-history-detail-modal.html](modals/alert-history-detail-modal.html)

---

## 测试统计

| 模块 | 页面数 | 弹窗数 | 测试项数 |
|:---|:---:|:---:|:---:|
| 库存管理模块 | 7 | 9 | 42 |
| 检测项目模块 | 2 | 2 | 10 |
| BOM管理模块 | 2 | 5 | 7 |
| 基础数据模块 | 2 | 5 | 11 |
| 预警管理模块 | 3 | 4 | 12 |
| 报表统计模块 | 2 | 0 | 8 |
| 系统管理模块 | 3 | 0 | 8 |
| 跨页面数据同步 | - | - | 8 |
| 弹窗完整性测试 | - | 25 | 25 |
| **总计** | **20** | **25** | **131** |

---

## 测试执行说明

1. **执行顺序**：建议按模块顺序执行，先完成单个页面的功能测试，再执行跨页面同步测试
2. **环境要求**：使用本地浏览器打开HTML文件，确保mock-config.js正确加载
3. **数据重置**：每次测试前刷新页面，确保mock数据恢复初始状态
4. **问题记录**：发现问题时记录具体步骤、预期结果和实际结果

---

*本测试清单由任务流程测试清单生成器自动生成，基于 PROJECT_RULES.md 和 mock-config.js*
