# COREONE 病理科耗材管理系统 — 项目说明文档

> **版本**: v1.1.0  
> **用途**: DeepSeek / AI 生成测试提示词参考  
> **生成时间**: 2026-05-12  
> **测试通过率**: 161/161 (100.0%)

---

## 一、项目概述

COREONE 是一个面向**大型三甲医院病理科**的耗材与试剂库存管理系统，覆盖从采购、入库、出库到成本分析的全生命周期管理。

### 1.1 核心业务场景

| 场景 | 描述 |
|------|------|
| **试剂管理** | 免疫组化(IHC)抗体、HE染色试剂、分子诊断试剂等，支持批号追踪和有效期预警 |
| **耗材管理** | 载玻片、刀片、手套、固定液等一次性耗材 |
| **设备耗材** | 切片机刀片、染色机试剂等 |
| **BOM管理** | 每种检测项目对应的标准物料清单（如HE染色、Ki-67检测、FISH等） |
| **成本归集** | 按项目/病种归集耗材成本，支持科室成本核算 |
| **库存预警** | 低库存、临期、过期三级预警 |

### 1.2 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                        前端 (React + Vite)                   │
│  React 18 + TypeScript + TailwindCSS + shadcn/ui + Axios    │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP/REST API
┌──────────────────────────▼──────────────────────────────────┐
│                      后端 (Express + TS)                     │
│  Express.js + TypeScript + JWT + RBAC + SQLite(node:sqlite) │
│  端口: 3001, API前缀: /api/v1                                │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                      数据库 (SQLite)                         │
│  文件: data/coreone.db                                       │
│  引擎: node:sqlite (实验性特性)                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、技术栈详情

### 2.1 前端

| 技术 | 版本 | 用途 |
|------|------|------|
| React | 18.x | UI框架 |
| TypeScript | 5.x | 类型安全 |
| Vite | 5.x | 构建工具 |
| TailwindCSS | 3.x | CSS框架 |
| shadcn/ui | latest | UI组件库 |
| Axios | 1.x | HTTP客户端 |
| React Router | 6.x | 路由管理 |
| date-fns | 3.x | 日期处理 |

### 2.2 后端

| 技术 | 版本 | 用途 |
|------|------|------|
| Express.js | 4.x | Web框架 |
| TypeScript | 5.x | 类型安全 |
| node:sqlite | 实验性 | SQLite数据库 |
| jsonwebtoken | 9.x | JWT认证 |
| bcryptjs | 2.x | 密码加密 |
| uuid | 9.x | UUID生成 |
| tsx | latest | TS运行时 |

### 2.3 数据库

- **类型**: SQLite (文件型)
- **文件**: `后端代码/server/data/coreone.db`
- **特性**: WAL模式、外键约束、PRAGMA兼容
- **初始化**: `DatabaseManager.ts` 自动建表+兼容旧数据库ALTER

---

## 三、数据库模型

### 3.1 核心表结构

```sql
-- 1. 物料分类 (三级分类树)
material_categories: id, code(UNIQUE), name, parent_id, level(1/2/3), 
                     sort_order, status, created_at, updated_at, is_deleted

-- 2. 物料主数据
materials: id, code(UNIQUE), name, spec, unit, spec_qty, spec_unit,
           category_id, supplier_id, price, min_stock, max_stock, safety_stock,
           location_id, status, remark, created_at, updated_at, is_deleted

-- 3. 供应商
suppliers: id, code(UNIQUE), name, contact, phone, email, address,
           tax_no, bank_name, bank_account, status, cooperation_count,
           total_amount, rating, created_at, updated_at, is_deleted

-- 4. 库位
locations: id, code(UNIQUE), name, type(shelf/room/cabinet/refrigerator),
           parent_id, zone, shelf, position, capacity, used, status,
           created_at, updated_at, is_deleted

-- 5. 库存汇总
inventory: id, material_id(UNIQUE), stock, locked_stock, location_id,
           last_inbound_id, last_inbound_date, last_outbound_id,
           last_outbound_date, update_time, created_at, updated_at

-- 6. 批次管理 (FIFO)
batches: id, material_id, batch_no, quantity, remaining,
         production_date, expiry_date, inbound_id, inbound_price,
         supplier_id, status, created_at, updated_at

-- 7. 入库记录
inbound_records: id, inbound_no(UNIQUE), type(purchase/return/transfer),
                 material_id, batch_id, batch_no, quantity, unit, price, amount,
                 supplier_id, location_id, production_date, expiry_date,
                 operator, status(completed/pending/cancelled), remark,
                 cancel_reason, purchase_order_id, purchase_order_no,
                 created_at, updated_at, is_deleted

-- 8. 出库记录
outbound_records: id, outbound_no(UNIQUE), type(project/transfer/scrap),
                  project_id, total_cost, operator, approver, approved_at,
                  status, remark, created_at, updated_at, is_deleted

-- 9. 出库明细
outbound_items: id, outbound_id, material_id, batch_id, batch_no,
                quantity, unit, unit_cost, total_cost, usage(self/return),
                receiver, created_at

-- 10. 项目/BOM
projects: id, code(UNIQUE), name, type(ihc/he/mp/fish/cyto/ss),
          cycle, bom_id, supportable_samples, manager, description,
          status, created_at, updated_at, is_deleted

boms: id, code, name, version, type, service_id, description,
      supportable_samples, unit_cost, status, created_at, updated_at, is_deleted

bom_items: id, bom_id, material_id, usage_per_sample, unit,
           is_alternative, main_item_id, sort_order, created_at

-- 11. 采购订单
purchase_orders: id, order_no(UNIQUE), material_id, material_name,
                 supplier_id, ordered_qty, received_qty, unit, unit_price,
                 total_amount, expected_date, status(pending/partial/completed),
                 remark, created_at, updated_at

-- 12. 盘点
stocktaking_records: id, stocktaking_no(UNIQUE), material_id, system_stock,
                     actual_stock, difference, operator, status, remark, created_at

-- 13. 退货/报废
return_records: id, return_no(UNIQUE), material_id, batch_id, quantity,
                reason, operator, status, remark, created_at

scrap_records: id, scrap_no(UNIQUE), material_id, batch_id, quantity,
               reason, operator, status, remark, created_at

-- 14. 库存流水
stock_logs: id, type(inbound/outbound/return/scrap/stocktaking),
            material_id, quantity, before_stock, after_stock,
            related_id, related_type, operator, remark, created_at

-- 15. 预警
alert_rules: id, type, name, threshold, threshold_days, enabled, created_at, updated_at
alerts: id, type, level, material_id, material_name, current_stock,
        threshold, message, status(pending/handled/ignored), handled_by,
        handled_at, remark, created_at

-- 16. 用户/角色
users: id, username(UNIQUE), password, real_name, role, department,
       phone, email, status, created_at, updated_at, is_deleted

roles: id, code(UNIQUE), name, description, permissions(JSON), status,
       created_at, updated_at, is_deleted

-- 17. 操作日志
operation_logs: id, user_id, username, operation, description,
                request_data, response_data, ip, user_agent, created_at

-- 18. 批次追踪
batch_usage_tracking: id, material_id, material_name, batch, spec,
                      total_qty, remaining, unit, start_date, days_used,
                      expected_days, progress, usage, receiver,
                      status(in-use/empty/expired/paused), created_at, updated_at

batch_depletion: id, batch_id, material_id, depletion_rate, 
                 estimated_empty_date, last_usage_date, created_at, updated_at
```

### 3.2 关键约束

- 物料编码 `code` 全局唯一
- 批次 `(material_id, batch_no)` 联合唯一
- BOM `(code, version)` 联合唯一
- 入库单号 `inbound_no` 全局唯一
- 出库单号 `outbound_no` 全局唯一
- 采购单号 `order_no` 全局唯一

---

## 四、角色与权限 (RBAC)

### 4.1 六角色体系

| 角色编码 | 角色名称 | 核心职责 | 可访问模块 |
|---------|---------|---------|-----------|
| `admin` | 系统管理员 | 全系统管理 | **全部** (含用户/角色管理) |
| `warehouse_manager` | 仓库管理员 | 库存管理 | 入库、出库、库存、库位、预警 |
| `technician` | 技术员 | 实验操作 | 出库、项目、BOM、库存查看 |
| `pathologist` | 病理医师 | 诊断与成本 | 库存、项目、BOM、成本分析 |
| `procurement` | 采购员 | 采购管理 | 入库、分类、物料、供应商、采购单 |
| `finance` | 财务人员 | 成本核算 | 成本分析、操作日志 |

### 4.2 权限控制矩阵

| 模块 | admin | warehouse_manager | technician | pathologist | procurement | finance |
|------|-------|-------------------|------------|-------------|-------------|---------|
| 用户管理 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 角色管理 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 供应商 | ✅ | ✅(读) | ❌ | ❌ | ✅ | ❌ |
| 物料分类 | ✅ | ✅(读) | ✅(读) | ✅(读) | ✅ | ❌ |
| 物料 | ✅ | ✅(读) | ✅(读) | ✅(读) | ✅ | ❌ |
| 库存 | ✅ | ✅ | ✅ | ✅ | ✅(读) | ❌ |
| 入库 | ✅ | ✅ | ❌ | ❌ | ✅(读) | ❌ |
| 出库 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 库位 | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| 项目/BOM | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |
| 采购订单 | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| 成本分析 | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ |
| 操作日志 | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| 预警 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |

### 4.3 JWT 认证

- **Secret**: `coreone-secret-key-2024`
- **Token有效期**: 8小时 (28800秒)
- **RefreshToken有效期**: 7天
- **认证头**: `Authorization: Bearer <token>`

---

## 五、API 接口设计

### 5.1 认证接口

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/auth/login` | 登录，返回token+refreshToken+用户信息 |
| POST | `/auth/refresh` | 刷新access token |
| POST | `/auth/logout` | 登出 |

### 5.2 用户管理 (admin)

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/users` | 用户列表(分页+搜索) |
| POST | `/users` | 创建用户 |
| PUT | `/users/:id` | 编辑用户 |
| DELETE | `/users/:id` | 删除用户(逻辑删除) |

### 5.3 角色管理 (admin)

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/roles` | 角色列表(分页) |
| POST | `/roles` | 创建角色 |
| PUT | `/roles/:id` | 编辑角色 |
| DELETE | `/roles/:id` | 删除角色 |

### 5.4 供应商

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/suppliers` | 列表(分页+搜索) |
| POST | `/suppliers` | 创建 |
| PUT | `/suppliers/:id` | 编辑 |
| DELETE | `/suppliers/:id` | 删除 |

### 5.5 物料分类

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/categories` | 三级分类树 |
| POST | `/categories` | 创建分类 |
| PUT | `/categories/:id` | 编辑 |
| DELETE | `/categories/:id` | 删除 |

### 5.6 物料

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/materials` | 列表(分页+搜索+分类/供应商筛选) |
| GET | `/materials/:id` | 详情(含批次+流水) |
| POST | `/materials` | 创建(自动生成code或用户指定) |
| PUT | `/materials/:id` | 编辑 |
| DELETE | `/materials/:id` | 删除(有库存禁止) |

### 5.7 库存

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/inventory` | 库存列表(分页+状态筛选) |
| GET | `/inventory/stats` | 库存统计 |

### 5.8 入库

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/inbound` | 入库列表 |
| GET | `/inbound/:id/check-deletable` | 检查可否删除 |
| POST | `/inbound` | 创建入库单 |
| PUT | `/inbound/:id` | 编辑 |
| DELETE | `/inbound/:id` | 删除(同步更新库存和PO收货量) |
| POST | `/inbound/:id/cancel` | 取消 |

### 5.9 出库

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/outbound` | 出库列表 |
| POST | `/outbound` | 创建出库单(自动FIFO批次分配) |

### 5.10 库位

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/locations` | 库位列表 |
| POST | `/locations` | 创建 |

### 5.11 项目/BOM

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/projects` | 项目列表 |
| GET | `/boms` | BOM列表 |
| GET | `/boms/:id` | BOM详情(含物料明细) |

### 5.12 采购订单

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/purchase-orders` | 列表(状态筛选) |
| POST | `/purchase-orders` | 创建 |
| PUT | `/purchase-orders/:id/receive` | 更新收货数量 |

### 5.13 成本分析

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/reports/cost-by-project` | 按项目成本 |
| GET | `/reports/cost-by-material` | 按物料成本 |
| GET | `/reports/cost-by-supplier` | 按供应商成本 |

### 5.14 操作日志

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/logs/operation` | 操作日志列表 |

### 5.15 预警

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/alerts` | 预警记录 |
| GET | `/alerts/rules` | 预警规则 |

---

## 六、基础数据规模

### 6.1 角色与用户

| 角色 | 用户数 | 说明 |
|------|--------|------|
| admin | 1 | admin / admin123 |
| warehouse_manager | 1 | 仓库管理员 |
| technician | 2 | 技术员1、技术员2 |
| pathologist | 2 | 医师1、医师2 |
| procurement | 1 | 采购员 |
| finance | 1 | 财务 |
| **合计** | **8** | |

### 6.2 供应商

10家核心供应商：DAKO、Ventana、Leica、Thermo Fisher、Roche、Agilent、BioCare、BD、国药集团、宇华生物

### 6.3 库位

26个库位，按区域划分：A区(试剂)、B区(耗材)、C区(IHC专用)、D区(分子诊断)、E区(细胞学)、F区(常规试剂)、G区(设备耗材)、H区(危化品)、冷藏区、冷冻区

### 6.4 物料分类

176个分类，三级结构：
- **试剂类**: HE染色、免疫组化(IHC)、特殊染色、分子诊断、细胞学
- **耗材类**: 载玻片、盖玻片、刀片、包埋盒、手套
- **设备耗材**: 切片机配件、染色机配件、封片机配件
- **危化品**: 甲醛、乙醇、二甲苯

### 6.5 物料

181个物料，含96+种IHC抗体，覆盖：
- HE染色全套试剂（苏木素、伊红、分化液、返蓝液、乙醇系列）
- IHC抗体（CKpan、CD20、CD3、Ki-67、HER2、PD-L1、ER、PR、p53、CD34等）
- 分子诊断试剂（DNA提取、PCR、FISH、NGS文库制备）
- 细胞学试剂（液基保存液、染色液）
- 通用耗材（玻片、刀片、手套、包埋盒）

### 6.6 BOM

113个BOM，覆盖病理科全部检测项目：
- HE染色（常规/快速/冰冻）
- IHC检测（乳腺癌全套、淋巴瘤全套、肺癌全套、消化道全套）
- 分子诊断（NGS 425基因Panel、FISH、PCR）
- 特殊染色（PAS、网状纤维、抗酸染色等）
- 细胞学（TCT、细针穿刺）

### 6.7 业务数据

| 数据类型 | 数量 |
|---------|------|
| 采购订单 | 18笔 (15笔completed, 3笔pending) |
| 入库记录 | 35笔 (含多批次) |
| 出库记录 | 16笔 |
| 盘点记录 | 6笔 |
| 退货记录 | 2笔 |
| 报废记录 | 2笔 |
| 操作日志 | 13条 |

---

## 七、自动化测试架构

### 7.1 测试覆盖

**20个测试套件，161个测试用例**

| 套件 | 用例数 | 维度 |
|------|--------|------|
| AUTH | 14 | 认证与登录 |
| USER | 10 | 用户管理 |
| ROLE | 6 | 角色管理 |
| SUPPLIER | 7 | 供应商 |
| CATEGORY | 7 | 分类 |
| MATERIAL | 9 | 物料 |
| INVENTORY | 11 | 库存 |
| INBOUND | 11 | 入库 |
| OUTBOUND | 9 | 出库 |
| LOCATION | 5 | 库位 |
| PROJECT | 5 | 项目 |
| BOM | 6 | BOM |
| ALERT | 7 | 预警 |
| PURCHASE | 5 | 采购订单 |
| COST | 6 | 成本分析 |
| LOG | 5 | 操作日志 |
| DATA | 10 | 数据一致性 |
| UX | 10 | 认知走查 |
| BOUNDARY | 10 | 边界条件 |
| SECURITY | 8 | 安全测试 |

### 7.2 测试维度

1. **功能测试**: API 正常调用，CRUD完整验证
2. **权限测试**: 6角色分别验证可访问/不可访问接口
3. **数据一致性**: 入库=库存+出库-退货+报废、FIFO批次消耗、PO收货数量
4. **边界条件**: 分页(page=0, pageSize=1000)、空搜索、特殊字符、价格=0/负数
5. **安全测试**: 无Token、无效Token、SQL注入、XSS、并发登录、越权访问
6. **认知走查**: 响应格式、分页信息、关键字段完整性

### 7.3 测试执行

```bash
cd 后端代码/server
# 1. 重置数据库
npx tsx scripts/seed-pathology-data.ts
npx tsx scripts/seed-test-transactions.ts

# 2. 启动服务
npx tsx src/app.ts

# 3. 运行测试
npx tsx tests/auto-api-test.ts
```

### 7.4 当前通过率

**161/161 全部通过，通过率 100.0%**  
执行耗时约 5-12 秒  
报告文件: `tests/auto-api-test-report-2026-05-11.json`

---

## 八、关键业务规则

### 8.1 FIFO批次管理

出库时按**过期日期升序**选择批次：
```sql
SELECT * FROM batches 
WHERE material_id = ? AND remaining > 0 AND status = 1 
ORDER BY expiry_date ASC
```

### 8.2 库存计算

```
库存 = SUM(入库数量) - SUM(出库数量) + SUM(退货数量) - SUM(报废数量)
```

### 8.3 采购订单状态

| 状态 | 条件 |
|------|------|
| pending | 未开始收货 |
| partial | 部分收货 |
| completed | received_qty >= ordered_qty |

### 8.4 入库单删除

删除入库单时：
1. 减少对应物料库存
2. 更新批次剩余数量
3. 更新采购订单 received_qty

### 8.5 预警规则

| 类型 | 触发条件 |
|------|---------|
| low-stock | stock <= min_stock |
| warning | expiry_date <= today + 30天 |
| expired | expiry_date < today |

---

## 九、已知边界与限制

1. **SQLite并发**: 文件锁限制高并发写入
2. **node:sqlite实验性**: Node.js实验特性，可能变化
3. **JWT无黑名单**: 登出仅前端清除token，服务端无黑名单
4. **物料删除限制**: 有库存的物料禁止删除
5. **入库单删除**: 只能删除未关联出库的入库单
6. **批次分配**: 出库时若最早批次不足，只消耗该批次剩余（不完全FIFO跨批次）
7. **成本计算**: 出库成本按最早批次入库价计算

---

## 十、文件结构

```
COREONE/
├── .gitignore
├── 前端代码/                          # React前端
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   └── src/
│       ├── App.tsx
│       ├── api/                       # Axios封装
│       ├── components/layout/         # 布局组件
│       ├── pages/                     # 页面组件
│       └── types/
├── 后端代码/server/                   # Express后端
│   ├── package.json
│   ├── tsconfig.json
│   ├── data/coreone.db               # SQLite数据库
│   ├── src/
│   │   ├── app.ts                    # Express入口
│   │   ├── database/DatabaseManager.ts
│   │   ├── middleware/
│   │   │   ├── auth.ts               # JWT+RBAC
│   │   │   └── errorHandler.ts
│   │   ├── routes/                   # API路由
│   │   │   ├── auth.ts
│   │   │   ├── users-v1.1.ts
│   │   │   ├── roles-v1.1.ts
│   │   │   ├── materials.ts
│   │   │   ├── categories-v1.1.ts
│   │   │   ├── suppliers-v1.1.ts
│   │   │   ├── locations-v1.1.ts
│   │   │   ├── inventory-v1.1.ts
│   │   │   ├── inbound-v1.1.ts
│   │   │   ├── outbound-v1.1.ts
│   │   │   ├── projects-v1.1.ts
│   │   │   ├── bom-v1.1.ts
│   │   │   ├── purchase-orders-v1.1.ts
│   │   │   ├── alerts-v1.1.ts
│   │   │   ├── reports-v1.1.ts
│   │   │   ├── logs-v1.1.ts
│   │   │   └── ...
│   │   └── utils/response.ts         # 统一响应格式
│   ├── scripts/                      # 数据初始化脚本
│   │   ├── seed-pathology-data.ts    # 基础数据
│   │   ├── seed-test-transactions.ts # 业务数据
│   │   └── seed-acceptance-data.ts
│   └── tests/                        # 测试
│       ├── auto-api-test.ts          # 161用例自动化测试
│       └── auto-api-test-report-2026-05-11.json
├── V1.1设计稿/v1.1/                 # 设计文档
│   ├── PRD-v1.1.md
│   ├── API-DESIGN-v1.1.md
│   ├── DATABASE-DESIGN-v1.1.md
│   ├── TECH-SPEC-v1.1.md
│   └── pages/                        # HTML原型
└── 自动化API测试报告-2026-05-11.md
```



*文档版本: v1.0*  
*生成工具: COREONE Automated Test Suite*  
*最后更新: 2026-05-12*
