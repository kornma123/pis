# COREONE 数据驱动多角色 RBAC 改造 — 实施计划（2026-06-26）

> 基于 master-line（`coreone-bom-versioning` = master + 对账核准链 PR#4）。锁定决策见 RBAC 文档 §8（多角色一步到位 / 成本可见性可配置默认 / 数据驱动矩阵 / 新增 lab_director）+ §8.2 确认矩阵。
> 配套：[RBAC 矩阵](COREONE-RBAC角色权限矩阵-调研驱动设计-2026-06-26.md)（§8 为确认种子值）。
> **边界**：本计划只规划，落地前用户确认范围 + 开放决策 D1–D6。

---

## 一、现状测绘 ——「四套口径打架」

| # | 来源 | 现状 | 问题 |
|---|------|------|------|
| 1 | `app.ts` mount `requireRole(...)` | 27 路由硬编码角色集 | 硬编码、与矩阵脱节 |
| 2 | `middleware/auth.ts` `ROLE_PERMISSIONS`+`pathToPermission`+`requireRole`+`requireCostWorkbenchAccess` | 硬编码 `Record<role,string[]>`，admin=`['*']` | **与 DB `roles.permissions` 完全脱钩**；JWT 单值 role |
| 3 | 前端 `lib/permissions.ts` `ROLE_MENU_MAP` | 硬编码 `role→路径[]` | 第三套口径；sidebar/layout 守卫消费 |
| 4 | 仪表盘 `useDashboardPage.ts` | 无差别 `Promise.all([getStats,inbound,outbound])` | **403 toast 根因**（财务弹 3 个）|
| 5 | DB `roles.permissions` | 种子全 `'[]'`，**无人读它鉴权** | 形同虚设 |

`users.role` 单列、JWT 单 role、`authenticateToken` 每请求回查 users（P0-03，含 `role!==decoded.role→ROLE_CHANGED 401`）。

**核心病灶**：鉴权事实源散在硬编码三处，DB 矩阵无人读。**本改造把唯一事实源迁到 DB `roles.permissions`（对象形态），四处全部改读它。**

---

## 二、目标架构

- **权限模型** = 27 模块 × {R/W}（W 蕴含 R）；权限码=模块名。
- **存储**：复用 `roles.permissions`，从扁平数组扩展为对象 `{"inventory":"R","bom":"W",...}`；写**双形态读取 helper**（兼容旧数组）。
- **能力解析** `getEffectivePermissions(userId)`：该用户全部角色（`user_roles` ∪ `users.role` 兜底）各自 `roles.permissions` 的**并集**（W 优先）；admin→全 W。
- **JWT vs per-request（D1，建议 per-request）**：roles 不进 JWT，每请求在 authenticateToken 一并解析挂 `req.user.roles`。理由：① 数据驱动矩阵要求"改格子即时生效不发版"，进 JWT 则旧 token 用旧权限；② 复用 P0-03 已有 per-request 回查；③ 根除 ROLE_CHANGED 与多角色冲突。
- **authenticateToken 改造**：保留 status/is_deleted→401；**删除 `role!==decoded.role→ROLE_CHANGED`**，改挂 `req.user.roles`（即时生效自然实现）。

---

## 三、分阶段（TDD，每阶段保持既有测试绿）

| Phase | 名称 | 触碰 | 风险 | 先写测试 |
|---|------|------|------|---------|
| **P0** | 矩阵冻结 + helper（无行为变更）| 新 `middleware/permissions.ts`（`SEED_MATRIX`/`parsePermissions`/解析骨架）| 低 | `rbac-matrix-seed`：27×7 完整、admin 全 W、病理成本空 |
| **P1** | Schema/Seed（仅 ADD 幂等）| `DatabaseManager.ts`：`user_roles` 表 + `users.primary_role` + lab_director 种子 + roles 种子写矩阵 + `app_settings`(cost_visibility_roles) + 回填单角色用户 | 中 | `rbac-p1-schema`：表存在、回填、矩阵种子、默认开关 |
| **P2** | 能力解析接线（后端核心）| `permissions.ts` 实现并集；`auth.ts` 改 authenticateToken（去 ROLE_CHANGED）+ requireRole 兼容 shim + requireCostWorkbenchAccess 读 DB | **高** | `rbac-p2-effective-perms`：单/多角色并集、R/W 边界 |
| **P3** | app.ts + 路由内守卫迁移（行为切换）| `app.ts` 27 行 + ~11 路由内 `requireRole('admin')`→`requirePermission(module,'W')` | **最高**（全站访问层）| `rbac-p3-route-matrix`：各角色逐模块 200/403 |
| **P4** | 能力 API + 前端接线 | 新 `GET /auth/me/capabilities`；前端 `permissions.ts`/AppSidebar/AppLayout/useDashboardPage（**403 修复**：按能力条件拉取）| 中 | `rbac-p4-capabilities-api` + 前端 dashboard/permissions 扩展 |
| **P5** | 角色权限 UI（编辑矩阵→DB）| `roles-v1.1.ts` PUT 对象 permissions；`Roles.tsx` 网格编辑 | 中 | `rbac-p5-matrix-edit`：改格子→该用户即时 403（证明不发版生效）|
| **P6** | 用户多角色 + SoD 告警 | `users-v1.1.ts`（roles[]+primary+SoD warn）；`Users.tsx` 多选；收尾 reconciliation/cost 页 getUserRole→capability | 中 | `rbac-p6-multirole-sod`：并集、SoD warning、primary 落库 |
| **P7** | 成本可见性开关 + 全量回归 + 文档 | `permissions.ts` `canSeeCost` 读 app_settings；成本路由叠加；重写 E2E 矩阵文档 | 中 | `rbac-p7-cost-visibility`：默认仅财务/主任、admin 加人即时可见 |

---

## 四、守卫测试（必须绿 / 需改写）

**保持绿**：`auth.test.ts`、`p0-03`(用例1/2/4 停用/删除/admin)、`bv-p6`(对账 SoD)、`roles/users/materials` CRUD、**`abc-golden-accuracy`(access 层不应触碰)**、前端 `permissions.test.ts`(保留 decodeBase64Url/getUserRole)。
**需改写**：p0-03 用例3(ROLE_CHANGED)→"改角色权限即时生效"；`E2E-Role-Permission-Matrix.md`(164 场景按新矩阵重生成)。

---

## 五、MVP vs Follow-up

- **MVP = Phase 0→4**：单一 DB 事实源 + 后端矩阵 enforcement + 前端能力驱动 nav/守卫 + **403 消除** + lab_director 生效 + 多角色 effective 解析就绪（即使 UI 暂只单角色，数据层已就绪可手工验证）。
- **Follow-up = Phase 5（矩阵编辑 UI）+ 6（多角色分配 UI + SoD）+ 7（成本开关 UI + 文档）**。

---

## 六、风险登记册

| ID | 风险 | 级 | 缓解 |
|---|------|---|------|
| R1 | P0-03 `ROLE_CHANGED` 与多角色冲突（**第一技术 gate**）| 高 | P2 去单 role 比对→per-request；改写用例3 |
| R2 | authenticateToken 全站入口改错 | 高 | requireRole 先等价 shim 再切；逐阶段全量 |
| R3 | 27+11 守卫 module 名拼错→整路由 403 | 高 | P3 表格逐条 diff + 每角色每模块断言 |
| R4 | permissions 数组↔对象双形态 | 中 | parsePermissions 双形态 helper |
| R5 | 存量单角色用户迁移 | 中 | P1 INSERT OR IGNORE 回填幂等 |
| R6 | "即时生效"被缓存破坏 | 中 | per-request 解析，禁缓存；P5 端到端验证 |
| R7 | categories 当前无 mount 守卫 | 中 | P3 补 requirePermission |
| R8–R10 | 仪表盘多拉/文档过期/golden 经成本守卫 | 低 | P4 条件拉取 / P7 重写 / 确认 admin token |

---

## 七、开放决策（待用户拍板；括号为建议）

- **D1**（per-request）：JWT 携带 roles[] vs 每请求 DB 解析。→ per-request（否则改矩阵不即时生效）。
- **D2**（JSON 对象）：扩展 `roles.permissions` 对象 vs 新建 `role_permissions` 表。→ JSON 对象（摩擦最小，27×7 规模小）。
- **D3**：存量单角色用户迁移 → 自动回填 user_roles=单 role、primary=role（幂等）；敏感组合是否人工复核？
- **D4**（复用 /roles）：矩阵编辑 UI 落点 → 复用 `Roles.tsx` 加网格。
- **D5**：SoD 不相容组合 = 硬阻断 vs 告警+豁免确认。→ 告警+记录豁免（小实验室现状，§8.1.1 倾向）。
- **D6**（角色集合）：成本可见性开关粒度 → 按角色集合 `cost_visibility_roles`（与矩阵正交）。

---

## 八、规模摘要

- **8 阶段**；MVP=0–4。最高风险 **Phase 3**（全站访问层迁移）+ Phase 2（authenticateToken）。
- **约 30 文件**：后端 ~14（auth.ts、新 permissions.ts、app.ts、DatabaseManager.ts、auth/roles/users route + ~7 路由内守卫）+ 前端 ~6（permissions.ts、AppSidebar、AppLayout、useDashboardPage、Roles.tsx、Users.tsx）+ ~8 后端测试 + 2 前端扩展 + 1 文档重写。
- **第一技术 gate**：P0-03 `ROLE_CHANGED` 单角色比对必须 Phase 2 改写。

---

*落地前须用户确认 MVP 范围 + 分支策略 + D1–D6。*
