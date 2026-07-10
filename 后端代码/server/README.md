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
JWT_SECRET=your-jwt-secret-key-change-in-production
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

# 生产密钥必须来自部署环境/密钥管理器，不要写进仓库。
export JWT_SECRET="$(openssl rand -base64 48)"
export DATABASE_PATH=/var/lib/coreone/coreone.db

# 可选：首次建库时受控创建 admin；输入不回显也不进 shell 历史。
read -rsp "Initial admin password: " ADMIN_INITIAL_PASSWORD && echo
export ADMIN_INITIAL_PASSWORD

# npm start 会在导入应用前强制 NODE_ENV=production。
npm start
unset ADMIN_INITIAL_PASSWORD
```

`npm start` 不会信任 `.env` 中的 `NODE_ENV=development`。若遗留了开发占位
`JWT_SECRET`，生产启动会直接报错退出，不会种默认 admin。

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

- `GET/POST /api/v1/users` — 用户（admin 专属）
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

SQLite 数据库文件位于 `data/coreone.db`（可通过 `DATABASE_PATH` 环境变量修改）。

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
| JWT_SECRET | **是** | — | JWT 签名密钥 |
| JWT_EXPIRES_IN | 否 | 8h | Access Token 有效期 |
| REFRESH_TOKEN_EXPIRES_IN | 否 | 7d | Refresh Token 有效期 |
| DATABASE_PATH | 否 | ./data/coreone.db | 数据库文件路径 |
| ADMIN_INITIAL_PASSWORD | 否 | — | 仅首次生产建库受控创建 admin；需 ≥12 位且不得使用已泄露口令 |
