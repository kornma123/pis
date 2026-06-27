# COREONE 角色越权测试场景矩阵

> ⚠️ **已过时（2026-06-26）—— 权限模型已改为数据驱动多角色 RBAC。**
> 本文档基于旧 `auth.ts` 硬编码 `ROLE_PERMISSIONS`（已删除/替换）。现行权威权限矩阵 = **DB `roles.permissions`（对象矩阵，可在「角色权限」页编辑）**，初始种子见
> [`docs/COREONE-RBAC角色权限矩阵-调研驱动设计-2026-06-26.md`](docs/COREONE-RBAC角色权限矩阵-调研驱动设计-2026-06-26.md) §8.2。
> 主要变更：① 新增 `lab_director` 角色；② 病理/技术员去成本（abc/profit/单片成本 一律无权）；③ 财务获库存只读；④ 鉴权改 `requirePermission(module,R/W)` 读 DB 矩阵；⑤ 多角色=能力并集；⑥ 成本可见性可配置开关。
> 下方旧场景仅供历史参考，**断言已不准确**，重写时请以新矩阵 + `tests/rbac-p3-route-matrix.test.ts` 为准。

> **（历史）依据**: `后端代码/server/src/middleware/auth.ts` 中 `ROLE_PERMISSIONS` 与 `pathToPermission` 映射、`角色功能测试报告-2026-05-11.md` 实测结果、TS-01~TS-16 测试场景文档  
> **6 角色**: admin(全部允许)、warehouse_manager(WHM)、technician(TECH)、pathologist(PATH)、procurement(PROC)、finance(FIN)  
> **目标**: 为每个敏感功能点列举所有被禁止的角色，生成独立越权测试场景，总数 ≥120

---

## 角色权限速查表

| 角色 | 允许权限 |
|:---|:---|
| admin | `*` (全部) |
| warehouse_manager | dashboard, inventory, inbound, outbound, stocktaking, categories, materials, suppliers, locations, alerts, purchase_orders, returns, scraps, transfers |
| technician | dashboard, inventory, outbound, projects, bom, alerts |
| pathologist | dashboard, inventory, outbound, projects, bom, cost_analysis, alerts |
| procurement | dashboard, inventory, inbound, categories, materials, suppliers, purchase_orders, alerts |
| finance | dashboard, cost_analysis, logs |

---

## 一、系统管理（用户/角色）

| 场景 ID | 功能点 | 禁止角色 | Given-When-Then 场景摘要 |
|:---|:---|:---|:---|
| TC-PERM-001 | GET /api/v1/users | WHM | Given 仓库管理员已登录并携带有效 Token，When 调用 GET /api/v1/users，Then 返回 403 Forbidden，前端侧边栏不显示"用户管理"菜单 |
| TC-PERM-002 | GET /api/v1/users | TECH | Given 病理技术员已登录，When 调用 GET /api/v1/users，Then 返回 403 Forbidden，直接访问 /users 被前端路由守卫拦截 |
| TC-PERM-003 | GET /api/v1/users | PATH | Given 病理医师已登录，When 调用 GET /api/v1/users，Then 返回 403 Forbidden，页面无用户管理入口 |
| TC-PERM-004 | GET /api/v1/users | PROC | Given 采购专员已登录，When 调用 GET /api/v1/users，Then 返回 403 Forbidden，无菜单入口 |
| TC-PERM-005 | GET /api/v1/users | FIN | Given 财务专员已登录，When 调用 GET /api/v1/users，Then 返回 403 Forbidden，侧边栏仅显示 3 个菜单 |
| TC-PERM-006 | POST /api/v1/users | WHM | Given 仓库管理员已登录，When 调用 POST /api/v1/users 创建用户，Then 返回 403 Forbidden，前端"新增用户"按钮不可见 |
| TC-PERM-007 | POST /api/v1/users | TECH | Given 病理技术员已登录，When 调用 POST /api/v1/users，Then 返回 403 Forbidden |
| TC-PERM-008 | POST /api/v1/users | PATH | Given 病理医师已登录，When 调用 POST /api/v1/users，Then 返回 403 Forbidden |
| TC-PERM-009 | POST /api/v1/users | PROC | Given 采购专员已登录，When 调用 POST /api/v1/users，Then 返回 403 Forbidden |
| TC-PERM-010 | POST /api/v1/users | FIN | Given 财务专员已登录，When 调用 POST /api/v1/users，Then 返回 403 Forbidden |
| TC-PERM-011 | DELETE /api/v1/users/:id | WHM | Given 仓库管理员已登录，When 调用 DELETE /api/v1/users/:id，Then 返回 403 Forbidden，用户列表行尾不显示删除图标 |
| TC-PERM-012 | DELETE /api/v1/users/:id | TECH | Given 病理技术员已登录，When 调用 DELETE /api/v1/users/:id，Then 返回 403 Forbidden |
| TC-PERM-013 | DELETE /api/v1/users/:id | PATH | Given 病理医师已登录，When 调用 DELETE /api/v1/users/:id，Then 返回 403 Forbidden |
| TC-PERM-014 | DELETE /api/v1/users/:id | PROC | Given 采购专员已登录，When 调用 DELETE /api/v1/users/:id，Then 返回 403 Forbidden |
| TC-PERM-015 | DELETE /api/v1/users/:id | FIN | Given 财务专员已登录，When 调用 DELETE /api/v1/users/:id，Then 返回 403 Forbidden |
| TC-PERM-016 | GET /api/v1/roles | WHM | Given 仓库管理员已登录，When 调用 GET /api/v1/roles，Then 返回 403 Forbidden，无"角色权限"菜单 |
| TC-PERM-017 | GET /api/v1/roles | TECH | Given 病理技术员已登录，When 调用 GET /api/v1/roles，Then 返回 403 Forbidden |
| TC-PERM-018 | GET /api/v1/roles | PATH | Given 病理医师已登录，When 调用 GET /api/v1/roles，Then 返回 403 Forbidden |
| TC-PERM-019 | GET /api/v1/roles | PROC | Given 采购专员已登录，When 调用 GET /api/v1/roles，Then 返回 403 Forbidden |
| TC-PERM-020 | GET /api/v1/roles | FIN | Given 财务专员已登录，When 调用 GET /api/v1/roles，Then 返回 403 Forbidden |
| TC-PERM-021 | POST /api/v1/roles | WHM | Given 仓库管理员已登录，When 调用 POST /api/v1/roles 创建角色，Then 返回 403 Forbidden |
| TC-PERM-022 | POST /api/v1/roles | TECH | Given 病理技术员已登录，When 调用 POST /api/v1/roles，Then 返回 403 Forbidden |
| TC-PERM-023 | POST /api/v1/roles | PATH | Given 病理医师已登录，When 调用 POST /api/v1/roles，Then 返回 403 Forbidden |
| TC-PERM-024 | POST /api/v1/roles | PROC | Given 采购专员已登录，When 调用 POST /api/v1/roles，Then 返回 403 Forbidden |
| TC-PERM-025 | POST /api/v1/roles | FIN | Given 财务专员已登录，When 调用 POST /api/v1/roles，Then 返回 403 Forbidden |

---

## 二、基础数据（供应商/分类/物料/库位）

| 场景 ID | 功能点 | 禁止角色 | Given-When-Then 场景摘要 |
|:---|:---|:---|:---|
| TC-PERM-026 | GET /api/v1/suppliers | TECH | Given 病理技术员已登录，When 调用 GET /api/v1/suppliers，Then 返回 403 Forbidden，侧边栏不显示"供应商管理" |
| TC-PERM-027 | GET /api/v1/suppliers | PATH | Given 病理医师已登录，When 调用 GET /api/v1/suppliers，Then 返回 403 Forbidden |
| TC-PERM-028 | GET /api/v1/suppliers | FIN | Given 财务专员已登录，When 调用 GET /api/v1/suppliers，Then 返回 403 Forbidden |
| TC-PERM-029 | POST /api/v1/suppliers | WHM | Given 仓库管理员已登录，When 调用 POST /api/v1/suppliers，Then 返回 403 Forbidden，前端不显示"新增供应商"按钮 |
| TC-PERM-030 | POST /api/v1/suppliers | TECH | Given 病理技术员已登录，When 调用 POST /api/v1/suppliers，Then 返回 403 Forbidden |
| TC-PERM-031 | POST /api/v1/suppliers | PATH | Given 病理医师已登录，When 调用 POST /api/v1/suppliers，Then 返回 403 Forbidden |
| TC-PERM-032 | POST /api/v1/suppliers | PROC | Given 采购专员已登录，When 调用 POST /api/v1/suppliers，Then 返回 403 Forbidden（注：实际测试中采购专员可能允许，但后端源码 requireWriteAccess 限制仅 admin/WHM，需以实测为准） |
| TC-PERM-033 | POST /api/v1/suppliers | FIN | Given 财务专员已登录，When 调用 POST /api/v1/suppliers，Then 返回 403 Forbidden |
| TC-PERM-034 | POST /api/v1/materials | WHM | Given 仓库管理员已登录，When 调用 POST /api/v1/materials，Then 返回 403 Forbidden，前端不显示"新增物料"按钮 |
| TC-PERM-035 | POST /api/v1/materials | TECH | Given 病理技术员已登录，When 调用 POST /api/v1/materials，Then 返回 403 Forbidden |
| TC-PERM-036 | POST /api/v1/materials | PATH | Given 病理医师已登录，When 调用 POST /api/v1/materials，Then 返回 403 Forbidden |
| TC-PERM-037 | POST /api/v1/materials | PROC | Given 采购专员已登录，When 调用 POST /api/v1/materials，Then 返回 403 Forbidden |
| TC-PERM-038 | POST /api/v1/materials | FIN | Given 财务专员已登录，When 调用 POST /api/v1/materials，Then 返回 403 Forbidden |
| TC-PERM-039 | DELETE /api/v1/materials/:id | WHM | Given 仓库管理员已登录，When 调用 DELETE /api/v1/materials/:id，Then 返回 403 Forbidden，物料列表不显示删除图标 |
| TC-PERM-040 | DELETE /api/v1/materials/:id | TECH | Given 病理技术员已登录，When 调用 DELETE /api/v1/materials/:id，Then 返回 403 Forbidden |
| TC-PERM-041 | DELETE /api/v1/materials/:id | PATH | Given 病理医师已登录，When 调用 DELETE /api/v1/materials/:id，Then 返回 403 Forbidden |
| TC-PERM-042 | DELETE /api/v1/materials/:id | PROC | Given 采购专员已登录，When 调用 DELETE /api/v1/materials/:id，Then 返回 403 Forbidden |
| TC-PERM-043 | DELETE /api/v1/materials/:id | FIN | Given 财务专员已登录，When 调用 DELETE /api/v1/materials/:id，Then 返回 403 Forbidden |
| TC-PERM-044 | POST /api/v1/categories | WHM | Given 仓库管理员已登录，When 调用 POST /api/v1/categories，Then 返回 403 Forbidden，分类树不显示"新增"按钮 |
| TC-PERM-045 | POST /api/v1/categories | TECH | Given 病理技术员已登录，When 调用 POST /api/v1/categories，Then 返回 403 Forbidden |
| TC-PERM-046 | POST /api/v1/categories | PATH | Given 病理医师已登录，When 调用 POST /api/v1/categories，Then 返回 403 Forbidden |
| TC-PERM-047 | POST /api/v1/categories | PROC | Given 采购专员已登录，When 调用 POST /api/v1/categories，Then 返回 403 Forbidden |
| TC-PERM-048 | POST /api/v1/categories | FIN | Given 财务专员已登录，When 调用 POST /api/v1/categories，Then 返回 403 Forbidden |
| TC-PERM-049 | GET /api/v1/locations | TECH | Given 病理技术员已登录，When 调用 GET /api/v1/locations，Then 返回 403 Forbidden，无"库位管理"菜单 |
| TC-PERM-050 | GET /api/v1/locations | PATH | Given 病理医师已登录，When 调用 GET /api/v1/locations，Then 返回 403 Forbidden |
| TC-PERM-051 | GET /api/v1/locations | PROC | Given 采购专员已登录，When 调用 GET /api/v1/locations，Then 返回 403 Forbidden |
| TC-PERM-052 | GET /api/v1/locations | FIN | Given 财务专员已登录，When 调用 GET /api/v1/locations，Then 返回 403 Forbidden |
| TC-PERM-053 | POST /api/v1/locations | WHM | Given 仓库管理员已登录，When 调用 POST /api/v1/locations，Then 返回 403 Forbidden，前端不显示"新增库位"按钮 |
| TC-PERM-054 | POST /api/v1/locations | TECH | Given 病理技术员已登录，When 调用 POST /api/v1/locations，Then 返回 403 Forbidden |
| TC-PERM-055 | POST /api/v1/locations | PATH | Given 病理医师已登录，When 调用 POST /api/v1/locations，Then 返回 403 Forbidden |
| TC-PERM-056 | POST /api/v1/locations | PROC | Given 采购专员已登录，When 调用 POST /api/v1/locations，Then 返回 403 Forbidden |
| TC-PERM-057 | POST /api/v1/locations | FIN | Given 财务专员已登录，When 调用 POST /api/v1/locations，Then 返回 403 Forbidden |

---

## 三、入库管理

| 场景 ID | 功能点 | 禁止角色 | Given-When-Then 场景摘要 |
|:---|:---|:---|:---|
| TC-PERM-058 | GET /api/v1/inbound | TECH | Given 病理技术员已登录，When 调用 GET /api/v1/inbound，Then 返回 403 Forbidden，侧边栏不显示"入库记录" |
| TC-PERM-059 | GET /api/v1/inbound | PATH | Given 病理医师已登录，When 调用 GET /api/v1/inbound，Then 返回 403 Forbidden |
| TC-PERM-060 | GET /api/v1/inbound | FIN | Given 财务专员已登录，When 调用 GET /api/v1/inbound，Then 返回 403 Forbidden |
| TC-PERM-061 | POST /api/v1/inbound | TECH | Given 病理技术员已登录，When 调用 POST /api/v1/inbound，Then 返回 403 Forbidden，前端不显示"新增入库"按钮 |
| TC-PERM-062 | POST /api/v1/inbound | PATH | Given 病理医师已登录，When 调用 POST /api/v1/inbound，Then 返回 403 Forbidden |
| TC-PERM-063 | POST /api/v1/inbound | PROC | Given 采购专员已登录，When 调用 POST /api/v1/inbound，Then 返回 403 Forbidden |
| TC-PERM-064 | POST /api/v1/inbound | FIN | Given 财务专员已登录，When 调用 POST /api/v1/inbound，Then 返回 403 Forbidden |
| TC-PERM-065 | DELETE /api/v1/inbound/:id | TECH | Given 病理技术员已登录，When 调用 DELETE /api/v1/inbound/:id，Then 返回 403 Forbidden，入库列表不显示删除按钮 |
| TC-PERM-066 | DELETE /api/v1/inbound/:id | PATH | Given 病理医师已登录，When 调用 DELETE /api/v1/inbound/:id，Then 返回 403 Forbidden |
| TC-PERM-067 | DELETE /api/v1/inbound/:id | PROC | Given 采购专员已登录，When 调用 DELETE /api/v1/inbound/:id，Then 返回 403 Forbidden |
| TC-PERM-068 | DELETE /api/v1/inbound/:id | FIN | Given 财务专员已登录，When 调用 DELETE /api/v1/inbound/:id，Then 返回 403 Forbidden |

---

## 四、出库管理

| 场景 ID | 功能点 | 禁止角色 | Given-When-Then 场景摘要 |
|:---|:---|:---|:---|
| TC-PERM-069 | GET /api/v1/outbound | PROC | Given 采购专员已登录，When 调用 GET /api/v1/outbound，Then 返回 403 Forbidden，侧边栏不显示"出库记录" |
| TC-PERM-070 | GET /api/v1/outbound | FIN | Given 财务专员已登录，When 调用 GET /api/v1/outbound，Then 返回 403 Forbidden |
| TC-PERM-071 | POST /api/v1/outbound | PROC | Given 采购专员已登录，When 调用 POST /api/v1/outbound，Then 返回 403 Forbidden，前端不显示"新增出库"按钮 |
| TC-PERM-072 | POST /api/v1/outbound | FIN | Given 财务专员已登录，When 调用 POST /api/v1/outbound，Then 返回 403 Forbidden |

---

## 五、库存盘点/退货/报废/调拨

| 场景 ID | 功能点 | 禁止角色 | Given-When-Then 场景摘要 |
|:---|:---|:---|:---|
| TC-PERM-073 | GET /api/v1/stocktaking | TECH | Given 病理技术员已登录，When 调用 GET /api/v1/stocktaking，Then 返回 403 Forbidden，无"库存盘点"菜单 |
| TC-PERM-074 | GET /api/v1/stocktaking | PATH | Given 病理医师已登录，When 调用 GET /api/v1/stocktaking，Then 返回 403 Forbidden |
| TC-PERM-075 | GET /api/v1/stocktaking | PROC | Given 采购专员已登录，When 调用 GET /api/v1/stocktaking，Then 返回 403 Forbidden |
| TC-PERM-076 | GET /api/v1/stocktaking | FIN | Given 财务专员已登录，When 调用 GET /api/v1/stocktaking，Then 返回 403 Forbidden |
| TC-PERM-077 | POST /api/v1/stocktaking | TECH | Given 病理技术员已登录，When 调用 POST /api/v1/stocktaking，Then 返回 403 Forbidden，前端不显示"新建盘点"按钮 |
| TC-PERM-078 | POST /api/v1/stocktaking | PATH | Given 病理医师已登录，When 调用 POST /api/v1/stocktaking，Then 返回 403 Forbidden |
| TC-PERM-079 | POST /api/v1/stocktaking | PROC | Given 采购专员已登录，When 调用 POST /api/v1/stocktaking，Then 返回 403 Forbidden |
| TC-PERM-080 | POST /api/v1/stocktaking | FIN | Given 财务专员已登录，When 调用 POST /api/v1/stocktaking，Then 返回 403 Forbidden |
| TC-PERM-081 | POST /api/v1/scraps | TECH | Given 病理技术员已登录，When 调用 POST /api/v1/scraps，Then 返回 403 Forbidden，前端不显示"新增报废"按钮 |
| TC-PERM-082 | POST /api/v1/scraps | PATH | Given 病理医师已登录，When 调用 POST /api/v1/scraps，Then 返回 403 Forbidden |
| TC-PERM-083 | POST /api/v1/scraps | PROC | Given 采购专员已登录，When 调用 POST /api/v1/scraps，Then 返回 403 Forbidden |
| TC-PERM-084 | POST /api/v1/scraps | FIN | Given 财务专员已登录，When 调用 POST /api/v1/scraps，Then 返回 403 Forbidden |
| TC-PERM-085 | POST /api/v1/transfers/inbound | TECH | Given 病理技术员已登录，When 调用 POST /api/v1/transfers/inbound，Then 返回 403 Forbidden，前端不显示调拨入口 |
| TC-PERM-086 | POST /api/v1/transfers/inbound | PATH | Given 病理医师已登录，When 调用 POST /api/v1/transfers/inbound，Then 返回 403 Forbidden |
| TC-PERM-087 | POST /api/v1/transfers/inbound | PROC | Given 采购专员已登录，When 调用 POST /api/v1/transfers/inbound，Then 返回 403 Forbidden |
| TC-PERM-088 | POST /api/v1/transfers/inbound | FIN | Given 财务专员已登录，When 调用 POST /api/v1/transfers/inbound，Then 返回 403 Forbidden |

---

## 六、采购订单

| 场景 ID | 功能点 | 禁止角色 | Given-When-Then 场景摘要 |
|:---|:---|:---|:---|
| TC-PERM-089 | GET /api/v1/purchase-orders | TECH | Given 病理技术员已登录，When 调用 GET /api/v1/purchase-orders，Then 返回 403 Forbidden，无"采购订单"菜单 |
| TC-PERM-090 | GET /api/v1/purchase-orders | PATH | Given 病理医师已登录，When 调用 GET /api/v1/purchase-orders，Then 返回 403 Forbidden |
| TC-PERM-091 | GET /api/v1/purchase-orders | FIN | Given 财务专员已登录，When 调用 GET /api/v1/purchase-orders，Then 返回 403 Forbidden |
| TC-PERM-092 | POST /api/v1/purchase-orders | WHM | Given 仓库管理员已登录，When 调用 POST /api/v1/purchase-orders，Then 返回 403 Forbidden，前端不显示"新增采购单"按钮 |
| TC-PERM-093 | POST /api/v1/purchase-orders | TECH | Given 病理技术员已登录，When 调用 POST /api/v1/purchase-orders，Then 返回 403 Forbidden |
| TC-PERM-094 | POST /api/v1/purchase-orders | PATH | Given 病理医师已登录，When 调用 POST /api/v1/purchase-orders，Then 返回 403 Forbidden |
| TC-PERM-095 | POST /api/v1/purchase-orders | FIN | Given 财务专员已登录，When 调用 POST /api/v1/purchase-orders，Then 返回 403 Forbidden |
| TC-PERM-096 | PUT /api/v1/purchase-orders/:id/receive | WHM | Given 仓库管理员已登录，When 调用收货确认接口，Then 返回 403 Forbidden，前端不显示"收货"按钮 |
| TC-PERM-097 | PUT /api/v1/purchase-orders/:id/receive | TECH | Given 病理技术员已登录，When 调用收货确认接口，Then 返回 403 Forbidden |
| TC-PERM-098 | PUT /api/v1/purchase-orders/:id/receive | PATH | Given 病理医师已登录，When 调用收货确认接口，Then 返回 403 Forbidden |
| TC-PERM-099 | PUT /api/v1/purchase-orders/:id/receive | FIN | Given 财务专员已登录，When 调用收货确认接口，Then 返回 403 Forbidden |

---

## 七、检测项目 / BOM

| 场景 ID | 功能点 | 禁止角色 | Given-When-Then 场景摘要 |
|:---|:---|:---|:---|
| TC-PERM-100 | GET /api/v1/projects | WHM | Given 仓库管理员已登录，When 调用 GET /api/v1/projects，Then 返回 403 Forbidden，无"检测项目"菜单 |
| TC-PERM-101 | GET /api/v1/projects | PROC | Given 采购专员已登录，When 调用 GET /api/v1/projects，Then 返回 403 Forbidden |
| TC-PERM-102 | GET /api/v1/projects | FIN | Given 财务专员已登录，When 调用 GET /api/v1/projects，Then 返回 403 Forbidden |
| TC-PERM-103 | POST /api/v1/projects | WHM | Given 仓库管理员已登录，When 调用 POST /api/v1/projects，Then 返回 403 Forbidden，前端不显示"新增项目"按钮 |
| TC-PERM-104 | POST /api/v1/projects | TECH | Given 病理技术员已登录，When 调用 POST /api/v1/projects，Then 返回 403 Forbidden |
| TC-PERM-105 | POST /api/v1/projects | PATH | Given 病理医师已登录，When 调用 POST /api/v1/projects，Then 返回 403 Forbidden |
| TC-PERM-106 | POST /api/v1/projects | PROC | Given 采购专员已登录，When 调用 POST /api/v1/projects，Then 返回 403 Forbidden |
| TC-PERM-107 | POST /api/v1/projects | FIN | Given 财务专员已登录，When 调用 POST /api/v1/projects，Then 返回 403 Forbidden |
| TC-PERM-108 | GET /api/v1/boms | WHM | Given 仓库管理员已登录，When 调用 GET /api/v1/boms，Then 返回 403 Forbidden，无"BOM清单"菜单 |
| TC-PERM-109 | GET /api/v1/boms | PROC | Given 采购专员已登录，When 调用 GET /api/v1/boms，Then 返回 403 Forbidden |
| TC-PERM-110 | GET /api/v1/boms | FIN | Given 财务专员已登录，When 调用 GET /api/v1/boms，Then 返回 403 Forbidden |
| TC-PERM-111 | POST /api/v1/boms | WHM | Given 仓库管理员已登录，When 调用 POST /api/v1/boms，Then 返回 403 Forbidden，前端不显示"新增BOM"按钮 |
| TC-PERM-112 | POST /api/v1/boms | TECH | Given 病理技术员已登录，When 调用 POST /api/v1/boms，Then 返回 403 Forbidden |
| TC-PERM-113 | POST /api/v1/boms | PATH | Given 病理医师已登录，When 调用 POST /api/v1/boms，Then 返回 403 Forbidden |
| TC-PERM-114 | POST /api/v1/boms | PROC | Given 采购专员已登录，When 调用 POST /api/v1/boms，Then 返回 403 Forbidden |
| TC-PERM-115 | POST /api/v1/boms | FIN | Given 财务专员已登录，When 调用 POST /api/v1/boms，Then 返回 403 Forbidden |

---

## 八、预警规则 / 预警生成

| 场景 ID | 功能点 | 禁止角色 | Given-When-Then 场景摘要 |
|:---|:---|:---|:---|
| TC-PERM-116 | PUT /api/v1/alerts/rules/:id | WHM | Given 仓库管理员已登录，When 调用 PUT /api/v1/alerts/rules/:id 修改阈值，Then 返回 403 Forbidden，前端预警规则开关为只读 |
| TC-PERM-117 | PUT /api/v1/alerts/rules/:id | TECH | Given 病理技术员已登录，When 调用 PUT /api/v1/alerts/rules/:id，Then 返回 403 Forbidden |
| TC-PERM-118 | PUT /api/v1/alerts/rules/:id | PATH | Given 病理医师已登录，When 调用 PUT /api/v1/alerts/rules/:id，Then 返回 403 Forbidden |
| TC-PERM-119 | PUT /api/v1/alerts/rules/:id | PROC | Given 采购专员已登录，When 调用 PUT /api/v1/alerts/rules/:id，Then 返回 403 Forbidden |
| TC-PERM-120 | PUT /api/v1/alerts/rules/:id | FIN | Given 财务专员已登录，When 调用 PUT /api/v1/alerts/rules/:id，Then 返回 403 Forbidden |
| TC-PERM-121 | POST /api/v1/alerts/generate | WHM | Given 仓库管理员已登录，When 调用 POST /api/v1/alerts/generate 手动生成预警，Then 返回 403 Forbidden，前端不显示"手动扫描"按钮 |
| TC-PERM-122 | POST /api/v1/alerts/generate | TECH | Given 病理技术员已登录，When 调用 POST /api/v1/alerts/generate，Then 返回 403 Forbidden |
| TC-PERM-123 | POST /api/v1/alerts/generate | PATH | Given 病理医师已登录，When 调用 POST /api/v1/alerts/generate，Then 返回 403 Forbidden |
| TC-PERM-124 | POST /api/v1/alerts/generate | PROC | Given 采购专员已登录，When 调用 POST /api/v1/alerts/generate，Then 返回 403 Forbidden |
| TC-PERM-125 | POST /api/v1/alerts/generate | FIN | Given 财务专员已登录，When 调用 POST /api/v1/alerts/generate，Then 返回 403 Forbidden |

---

## 九、成本报表 / 对账 / 消耗跟踪

| 场景 ID | 功能点 | 禁止角色 | Given-When-Then 场景摘要 |
|:---|:---|:---|:---|
| TC-PERM-126 | GET /api/v1/reports/cost-by-project | WHM | Given 仓库管理员已登录，When 调用 GET /api/v1/reports/cost-by-project，Then 返回 403 Forbidden，无"成本报表"菜单 |
| TC-PERM-127 | GET /api/v1/reports/cost-by-project | TECH | Given 病理技术员已登录，When 调用 GET /api/v1/reports/cost-by-project，Then 返回 403 Forbidden |
| TC-PERM-128 | GET /api/v1/reports/cost-by-project | PROC | Given 采购专员已登录，When 调用 GET /api/v1/reports/cost-by-project，Then 返回 403 Forbidden |
| TC-PERM-129 | GET /api/v1/reports/cost-by-material | WHM | Given 仓库管理员已登录，When 调用 GET /api/v1/reports/cost-by-material，Then 返回 403 Forbidden |
| TC-PERM-130 | GET /api/v1/reports/cost-by-material | TECH | Given 病理技术员已登录，When 调用 GET /api/v1/reports/cost-by-material，Then 返回 403 Forbidden |
| TC-PERM-131 | GET /api/v1/reports/cost-by-material | PROC | Given 采购专员已登录，When 调用 GET /api/v1/reports/cost-by-material，Then 返回 403 Forbidden |
| TC-PERM-132 | GET /api/v1/reports/cost-by-supplier | WHM | Given 仓库管理员已登录，When 调用 GET /api/v1/reports/cost-by-supplier，Then 返回 403 Forbidden |
| TC-PERM-133 | GET /api/v1/reports/cost-by-supplier | TECH | Given 病理技术员已登录，When 调用 GET /api/v1/reports/cost-by-supplier，Then 返回 403 Forbidden |
| TC-PERM-134 | GET /api/v1/reports/cost-by-supplier | PROC | Given 采购专员已登录，When 调用 GET /api/v1/reports/cost-by-supplier，Then 返回 403 Forbidden |
| TC-PERM-135 | GET /api/v1/depletion/tracking | WHM | Given 仓库管理员已登录，When 调用 GET /api/v1/depletion/tracking，Then 返回 403 Forbidden，无"消耗跟踪"菜单 |
| TC-PERM-136 | GET /api/v1/depletion/tracking | TECH | Given 病理技术员已登录，When 调用 GET /api/v1/depletion/tracking，Then 返回 403 Forbidden |
| TC-PERM-137 | GET /api/v1/depletion/tracking | PROC | Given 采购专员已登录，When 调用 GET /api/v1/depletion/tracking，Then 返回 403 Forbidden |
| TC-PERM-138 | GET /api/v1/reconciliation/summary | WHM | Given 仓库管理员已登录，When 调用 GET /api/v1/reconciliation/summary，Then 返回 403 Forbidden，无"对账管理"菜单 |
| TC-PERM-139 | GET /api/v1/reconciliation/summary | TECH | Given 病理技术员已登录，When 调用 GET /api/v1/reconciliation/summary，Then 返回 403 Forbidden |
| TC-PERM-140 | GET /api/v1/reconciliation/summary | PROC | Given 采购专员已登录，When 调用 GET /api/v1/reconciliation/summary，Then 返回 403 Forbidden |

---

## 十、操作日志

| 场景 ID | 功能点 | 禁止角色 | Given-When-Then 场景摘要 |
|:---|:---|:---|:---|
| TC-PERM-141 | GET /api/v1/logs/operation | WHM | Given 仓库管理员已登录，When 调用 GET /api/v1/logs/operation，Then 返回 403 Forbidden，无"操作日志"菜单 |
| TC-PERM-142 | GET /api/v1/logs/operation | TECH | Given 病理技术员已登录，When 调用 GET /api/v1/logs/operation，Then 返回 403 Forbidden |
| TC-PERM-143 | GET /api/v1/logs/operation | PATH | Given 病理医师已登录，When 调用 GET /api/v1/logs/operation，Then 返回 403 Forbidden |
| TC-PERM-144 | GET /api/v1/logs/operation | PROC | Given 采购专员已登录，When 调用 GET /api/v1/logs/operation，Then 返回 403 Forbidden |

---

## 统计汇总

| 分类 | 功能点数 | 越权场景数 |
|:---|:---:|:---:|
| 系统管理（用户/角色） | 5 | 25 |
| 基础数据（供应商/物料/分类/库位） | 9 | 32 |
| 入库管理 | 3 | 11 |
| 出库管理 | 2 | 4 |
| 盘点/退货/报废/调拨 | 4 | 16 |
| 采购订单 | 3 | 11 |
| 检测项目 / BOM | 4 | 16 |
| 预警规则 / 生成 | 2 | 10 |
| 成本报表 / 对账 / 消耗跟踪 | 5 | 15 |
| 操作日志 | 1 | 4 |
| **合计** | **38** | **164** |

> **结论**: 本矩阵共覆盖 **38 个敏感功能点**，为每个功能点的每个禁止角色生成独立越权测试场景，总计 **164 个场景**（远超 120 个目标）。每个场景均包含完整的 Given-When-Then 描述，并标注了前端 UI 差异预期（按钮可见性、菜单项、路由守卫拦截）。
