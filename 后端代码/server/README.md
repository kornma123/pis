# COREONE 后端 API 服务

## 技术栈

- **框架**: Express.js + TypeScript
- **数据库**: SQLite3
- **ORM**: 原生 SQL (使用 `sqlite` 包提供 Promise API)

## 目录结构

```
server/
├── src/
│   ├── database/          # 数据库管理
│   │   └── DatabaseManager.ts
│   ├── middleware/        # 中间件
│   │   └── errorHandler.ts
│   ├── routes/            # API 路由
│   │   ├── inventory.ts   # 库存管理
│   │   ├── procurement.ts # 采购管理
│   │   ├── receiving.ts   # 到货管理
│   │   ├── release.ts     # 放行管理
│   │   ├── usage.ts       # 使用/消耗管理
│   │   └── master-data.ts # 主数据管理
│   └── index.ts           # 服务入口
├── data/                  # 数据库文件目录
├── package.json
└── tsconfig.json
```

## 安装依赖

```bash
cd server
npm install
```

## 开发模式

```bash
npm run dev
```

服务将在 http://localhost:3001 启动

## 生产构建

```bash
npm run build
npm start
```

## API 接口

### 库存管理

- `GET /api/inventory` - 获取所有库存
- `GET /api/inventory/:sku/:batch` - 获取单个库存项
- `POST /api/inventory` - 创建库存项
- `PUT /api/inventory/:id` - 更新库存项
- `DELETE /api/inventory/:id` - 删除库存项
- `GET /api/inventory/available/batches` - 获取可用批次
- `GET /api/inventory/ledger/list` - 获取台账记录
- `POST /api/inventory/ledger` - 创建台账记录

### 采购管理

- `GET /api/procurement` - 获取所有采购订单
- `POST /api/procurement` - 创建采购订单

### 到货管理

- `GET /api/receiving` - 获取所有到货记录
- `POST /api/receiving` - 创建到货记录

### 放行管理

- `GET /api/release` - 获取所有放行记录
- `POST /api/release` - 创建放行记录

### 使用/消耗管理

- `POST /api/usage/consume` - 记录使用/消耗

### 主数据管理

- `GET /api/master-data/materials` - 获取所有物料
- `POST /api/master-data/materials` - 创建物料
- `GET /api/master-data/locations` - 获取所有库位
- `POST /api/master-data/locations` - 创建库位

## 环境变量

复制 `.env.example` 为 `.env` 并配置：

```env
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
DATABASE_PATH=./data/coreone.db
```

## 数据库

SQLite 数据库文件位于 `data/coreone.db`

启动时会自动创建表结构。
