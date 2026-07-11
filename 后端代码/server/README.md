# COREONE 后端 API 服务

## 技术栈

- **框架**: Express.js 4.22 + TypeScript 5.9
- **数据库**: SQLite via `node:sqlite` DatabaseSync
- **认证**: JWT (jsonwebtoken) + bcryptjs
- **校验**: express-validator
- **测试**: Vitest + Supertest

## 目录结构

```
server/
├── src/
│   ├── app.ts              # Express 应用入口
│   ├── database/
│   │   └── DatabaseManager.ts   # SQLite 数据库管理 (node:sqlite)
│   ├── middleware/
│   │   ├── auth.ts         # JWT 认证 + 角色权限
│   │   └── errorHandler.ts # 全局错误处理
│   ├── routes/             # API 路由 (v1.1 为当前版本)
│   └── utils/
│       └── response.ts     # 统一响应格式
├── data/                   # SQLite 数据库文件目录
├── scripts/                # 数据初始化脚本
├── package.json
└── tsconfig.json
```

## 安装依赖

```bash
cd 后端代码/server
npm install
```

## 配置本地开发环境

```bash
cp .env.example .env
```

编辑 `.env`（只用于 `npm run dev`）：

```env
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173

# JWT 认证（本地开发占位值）
JWT_SECRET=<development-only-placeholder>
JWT_EXPIRES_IN=8h
REFRESH_TOKEN_EXPIRES_IN=7d

# 数据库路径（可选，默认 ./data/coreone.db）
DATABASE_PATH=./data/coreone.db
```

## 开发模式

```bash
npm run dev
```

服务将在 http://localhost:3001 启动，API 基础路径为 `/api/v1`。

## 生产构建

```bash
npm run build

# 生产密钥必须来自正式密钥管理器，不要在此生成、展示或写进仓库。
read -rsp "JWT secret from the approved secret manager: " JWT_SECRET && echo
export JWT_SECRET
export DATABASE_PATH=/var/lib/coreone/coreone.db

# 仅全新首装：一次性允许创建明确目标库；旧库升级绝不能设置此开关。
export COREONE_ALLOW_DATABASE_CREATE=1
# 可选：首次建库时受控创建 admin；输入不回显也不进 shell 历史。
read -rsp "Initial admin password: " ADMIN_INITIAL_PASSWORD && echo
export ADMIN_INITIAL_PASSWORD

# npm start 会在导入应用前强制 NODE_ENV=production。
npm start
# 首次启动确认成功后按 Ctrl-C 停止前台进程，再清掉两个一次性变量并重启。
unset ADMIN_INITIAL_PASSWORD COREONE_ALLOW_DATABASE_CREATE
# 显式空值/0 同时覆盖可能残留在 .env 里的同名值。
ADMIN_INITIAL_PASSWORD='' COREONE_ALLOW_DATABASE_CREATE=0 npm start
```

`npm start` 不会信任 `.env` 中的 `NODE_ENV=development`。若遗留了开发占位
`JWT_SECRET`，生产启动会直接报错退出，不会种默认 admin。生产启动只对历史默认种子创建的
`admin`、`cangguan`、`jishuyuan1`、`jishuyuan2`、`yishi1`、`yishi2`、`caigou`、`caiwu` 八账号做有界核验；其中任一
仍活跃、未删除且匹配公开旧口令时都会 fail-closed 拒绝启动。旧库缺少 `status/is_deleted` 时
按活跃处理；缺少 `username/password` 时因无法安全核验而拒绝启动。

旧生产库升级时，先用 `docker compose run --rm --no-deps` 在同一数据库 volume 上执行
`npm run reset-passwords`：一次传入 `RESET_ADMIN_PASSWORD`、`RESET_CANGGUAN_PASSWORD`、
`RESET_JISHUYUAN1_PASSWORD`、`RESET_JISHUYUAN2_PASSWORD`、`RESET_YISHI1_PASSWORD`、
`RESET_YISHI2_PASSWORD`、`RESET_CAIGOU_PASSWORD`、`RESET_CAIWU_PASSWORD`，确认原子更新 8 个账号成功后才能启动 backend。口令应逐个用
`read -rsp` 读取并通过仅含变量名的 `-e VARIABLE_NAME` 传入，不能把实际值写在命令行；完整
升级顺序和旧口令全量 `401` 验收见仓库根 `部署说明.md`。八个新口令必须彼此不同；任一账号
缺失、重复目标、复用口令或弱口令都会在提交前整体失败，不会留下半量改密或成功误报。

## API 接口

所有接口前缀为 `/api/v1`，响应格式统一：

```json
// 成功
{ "success": true, "data": {...} }

// 失败
{ "success": false, "error": { "message": "...", "code": "..." } }
```

### 认证

- `POST /api/v1/auth/login` — 登录（公开）
- `POST /api/v1/auth/register` — 注册（公开）

### 主数据

- `GET/POST /api/v1/categories` — 物料分类
- `GET/POST /api/v1/materials` — 物料
- `GET/POST /api/v1/suppliers` — 供应商
- `GET/POST /api/v1/locations` — 库位

### 库存操作

- `GET /api/v1/inventory` — 库存查询
- `POST /api/v1/inbound` — 入库
- `POST /api/v1/outbound` — 出库
- `POST /api/v1/stocktaking` — 盘点
- `POST /api/v1/transfers` — 调拨
- `POST /api/v1/returns` — 退货
- `POST /api/v1/scraps` — 报废

### 业务管理

- `GET/POST /api/v1/projects` — 项目
- `GET/POST /api/v1/boms` — BOM
- `GET/POST /api/v1/purchase-orders` — 采购订单

### 系统管理

- `GET/POST /api/v1/users` — 用户（admin 专属；POST/PUT 密码统一执行强度与 bcrypt 72 字节门禁）
- `GET/POST /api/v1/roles` — 角色（admin 专属）
- `GET /api/v1/logs` — 操作日志

### 报表与预警

- `GET /api/v1/reports` — 报表
- `GET /api/v1/alerts` — 预警
- `GET /api/v1/reconciliation` — 对账
- `GET /api/v1/depletion` — 成本分析

### 健康检查

- `GET /api/health` — 服务状态（公开）

## 权限说明

| 角色 | 权限范围 |
|------|----------|
| admin | 全部功能 |
| warehouse_manager | 库存、入库、出库、盘点、调拨、退货、报废 |
| technician / pathologist | 项目、BOM、出库 |
| procurement | 采购订单、供应商、入库 |
| finance | 报表、对账、成本分析 |

## 数据库

开发/测试默认 SQLite 位于 `data/coreone.db`。生产必须显式提供绝对 `DATABASE_PATH`：默认要求
目标文件已存在；仅全新首装可一次性设置 `COREONE_ALLOW_DATABASE_CREATE=1`，成功后必须清除并以 0 重启。

启动时自动调用 `initializeDatabase()` 创建表结构，无需手动执行 migration。

## 测试

```bash
# 单元测试
npm run test

# 使用原生 SQLite 运行测试
npm run test:node
```

## 环境变量说明

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| PORT | 否 | 3001 | 服务端口 |
| NODE_ENV | 否 | 开发配置为 development | `npm start` 强制 production；测试显式为 test |
| FRONTEND_URL | 否 | — | CORS 允许的源 |
| JWT_SECRET | **是** | — | JWT 签名密钥；≥32 字符且拒绝低熵、常见与顺序模式 |
| JWT_EXPIRES_IN | 否 | 8h | Access Token 有效期 |
| REFRESH_TOKEN_EXPIRES_IN | 否 | 7d | Refresh Token 有效期 |
| DATABASE_PATH | 生产**是** | 开发为 ./data/coreone.db | 生产必须为绝对路径，默认必须指向已存在普通文件 |
| COREONE_ALLOW_DATABASE_CREATE | 否 | 0 | 仅全新生产首装可一次性设 1；旧库升级始终为 0 |
| ADMIN_INITIAL_PASSWORD | 否 | — | 仅首次生产建库受控创建 admin；空串视为未提供，非空需满足统一账号口令策略，否则拒绝启动 |
| RESET_ADMIN_PASSWORD | 否 | — | 仅 `npm run reset-passwords` 使用；原子轮换历史 admin |
| RESET_CANGGUAN_PASSWORD | 否 | — | 仅重置脚本使用；原子轮换 cangguan |
| RESET_JISHUYUAN1_PASSWORD | 否 | — | 仅重置脚本使用；原子轮换 jishuyuan1 |
| RESET_JISHUYUAN2_PASSWORD | 否 | — | 仅重置脚本使用；原子轮换 jishuyuan2 |
| RESET_YISHI1_PASSWORD | 否 | — | 仅重置脚本使用；原子轮换 yishi1 |
| RESET_YISHI2_PASSWORD | 否 | — | 仅重置脚本使用；原子轮换 yishi2 |
| RESET_CAIGOU_PASSWORD | 否 | — | 仅重置脚本使用；原子轮换 caigou |
| RESET_CAIWU_PASSWORD | 否 | — | 仅重置脚本使用；原子轮换 caiwu |
