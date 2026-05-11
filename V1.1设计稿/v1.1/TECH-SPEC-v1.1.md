# COREONE 实验室耗材管理系统 技术规范文档

**版本**: v1.1  
**创建日期**: 2026-04-23  
**作者**: 技术团队  
**状态**: 已批准  
**关联文档**: PRD-v1.1.md, PROJECT-PLAN-v1.1.md, API-DESIGN-v1.1.md

---

## 1. 技术架构概述

### 1.1 架构选型

COREONE v1.1 采用前后端分离架构，以支持未来可能的移动端扩展和第三方系统集成。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              客户端层                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                        │
│  │  Web前端     │  │  移动端(Web) │  │  扫码设备    │                        │
│  │  React+TS    │  │  Responsive  │  │  USB/蓝牙    │                        │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                        │
└─────────┼─────────────────┼─────────────────┼───────────────────────────────┘
          │                 │                 │
          └─────────────────┼─────────────────┘
                            │ HTTPS/JSON
┌───────────────────────────┼─────────────────────────────────────────────────┐
│                           ▼                                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                        网关层 (Nginx)                                 │   │
│  │  - 负载均衡  - SSL终止  - 静态资源缓存  - 反向代理                      │   │
│  └────────────────────────────────┬─────────────────────────────────────┘   │
│                                    │                                         │
│  ┌─────────────────────────────────▼─────────────────────────────────────┐  │
│  │                      应用服务层 (Node.js/Express)                      │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │  │
│  │  │  库存服务    │ │  项目服务    │ │  报表服务    │ │  系统服务    │ │  │
│  │  │  Inventory   │ │  Project     │ │  Report      │ │  System      │ │  │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘ │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                  │  │
│  │  │  入库服务    │ │  出库服务    │ │  预警服务    │                  │  │
│  │  │  Inbound     │ │  Outbound    │ │  Alert       │                  │  │
│  │  └──────────────┘ └──────────────┘ └──────────────┘                  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│  ┌─────────────────────────────────▼─────────────────────────────────────┐  │
│  │                      数据访问层                                        │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                   │  │
│  │  │  ORM/Prisma  │ │  Redis       │ │  连接池      │                   │  │
│  │  │  Database    │ │  Cache       │ │  Manager     │                   │  │
│  │  └──────────────┘ └──────────────┘ └──────────────┘                   │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼───────────────────────────────────────┐
│                           数据存储层                                       │
│  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐  │
│  │  MySQL 8.0         │  │  Redis 7.0         │  │  文件存储           │  │
│  │  - 业务数据         │  │  - 会话缓存         │  │  - 导入/导出文件    │  │
│  │  - 事务处理         │  │  - 热点数据         │  │  - 日志文件         │  │
│  └────────────────────┘  └────────────────────┘  └────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
```

### 1.2 技术栈选型

| 层级 | 技术选型 | 版本 | 选型理由 |
|------|---------|------|----------|
| **前端框架** | React | 18.x | 生态成熟，组件化开发，TypeScript支持好 |
| **前端状态** | Zustand | 4.x | 轻量级，简单易用，适合中小型应用 |
| **UI组件库** | Ant Design | 5.x | 企业级组件丰富，主题定制能力强 |
| **前端构建** | Vite | 5.x | 启动快，热更新快，配置简单 |
| **后端框架** | Express + TypeScript | 4.x | 轻量灵活，TypeScript类型安全 |
| **ORM工具** | Prisma | 5.x | 类型安全，迁移方便，开发体验好 |
| **数据库** | MySQL | 8.0 | 稳定可靠，事务支持好，团队熟悉 |
| **缓存** | Redis | 7.0 | 高性能，支持多种数据结构 |
| **消息队列** | Bull (Redis) | 4.x | 基于Redis，轻量级，适合定时任务 |
| **API文档** | Swagger/OpenAPI | 3.0 | 自动生成，便于前后端协作 |
| **日志** | Winston | 3.x | 功能完善，支持多种传输方式 |
| **监控** | Prometheus + Grafana | - | 开源成熟，可视化能力强 |

---

## 2. 前端技术规范

### 2.1 项目结构

```
frontend/
├── public/                      # 静态资源
│   └── assets/
├── src/
│   ├── api/                     # API接口层
│   │   ├── inventory.ts         # 库存相关API
│   │   ├── inbound.ts           # 入库相关API
│   │   ├── outbound.ts          # 出库相关API
│   │   ├── project.ts           # 项目相关API
│   │   ├── bom.ts               # BOM相关API
│   │   ├── report.ts            # 报表相关API
│   │   └── system.ts            # 系统相关API
│   │
│   ├── components/              # 公共组件
│   │   ├── common/              # 通用组件
│   │   │   ├── DataTable/       # 数据表格
│   │   │   ├── SearchForm/      # 搜索表单
│   │   │   ├── ModalForm/       # 弹窗表单
│   │   │   └── StatCard/        # 统计卡片
│   │   ├── business/            # 业务组件
│   │   │   ├── InventoryCard/   # 库存卡片
│   │   │   ├── InboundForm/     # 入库表单
│   │   │   ├── OutboundForm/    # 出库表单
│   │   │   └── CostChart/       # 成本图表
│   │   └── layout/              # 布局组件
│   │       ├── Sidebar/         # 侧边栏
│   │       ├── Header/          # 顶部导航
│   │       └── PageContainer/   # 页面容器
│   │
│   ├── hooks/                   # 自定义Hooks
│   │   ├── useInventory.ts      # 库存数据管理
│   │   ├── useTable.ts          # 表格通用逻辑
│   │   ├── useModal.ts          # 弹窗通用逻辑
│   │   └── usePermission.ts     # 权限控制
│   │
│   ├── pages/                   # 页面组件
│   │   ├── inventory/           # 库存管理
│   │   ├── inbound/             # 入库管理
│   │   ├── outbound/            # 出库管理
│   │   ├── project/             # 检测项目
│   │   ├── bom/                 # BOM管理
│   │   ├── report/              # 报表统计
│   │   └── system/              # 系统管理
│   │
│   ├── stores/                  # 状态管理
│   │   ├── authStore.ts         # 认证状态
│   │   ├── appStore.ts          # 应用状态
│   │   └── inventoryStore.ts    # 库存状态
│   │
│   ├── types/                   # TypeScript类型定义
│   │   ├── inventory.ts         # 库存类型
│   │   ├── material.ts          # 物料类型
│   │   └── api.ts               # API通用类型
│   │
│   ├── utils/                   # 工具函数
│   │   ├── request.ts           # HTTP请求封装
│   │   ├── format.ts            # 格式化工具
│   │   ├── validate.ts          # 表单验证
│   │   └── storage.ts           # 本地存储
│   │
│   ├── styles/                  # 样式文件
│   │   ├── global.less          # 全局样式
│   │   ├── variables.less       # 变量定义
│   │   └── design-system.less   # 设计系统
│   │
│   ├── App.tsx                  # 应用入口
│   ├── main.tsx                 # 渲染入口
│   └── router.tsx               # 路由配置
│
├── tests/                       # 测试文件
├── .eslintrc.js                 # ESLint配置
├── .prettierrc                  # Prettier配置
├── tsconfig.json                # TypeScript配置
└── vite.config.ts               # Vite配置
```

### 2.2 代码规范

#### 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| 组件名 | PascalCase | `InventoryList`, `InboundModal` |
| 文件名 | PascalCase (组件), camelCase (其他) | `InventoryCard.tsx`, `useInventory.ts` |
| 变量/函数 | camelCase | `getInventoryList`, `currentStock` |
| 常量 | UPPER_SNAKE_CASE | `MAX_STOCK_LIMIT`, `DEFAULT_PAGE_SIZE` |
| 类型/接口 | PascalCase | `InventoryItem`, `InboundRecord` |
| 枚举 | PascalCase | `StockStatus`, `InboundType` |
| CSS类名 | kebab-case | `inventory-list`, `stock-warning` |

#### 组件规范

```typescript
// ✅ 正确示例
import React, { useState, useCallback } from 'react';
import { Card, Table } from 'antd';
import type { InventoryItem } from '@/types/inventory';

interface InventoryListProps {
  categoryId?: string;
  onSelect?: (item: InventoryItem) => void;
}

export const InventoryList: React.FC<InventoryListProps> = ({
  categoryId,
  onSelect,
}) => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<InventoryItem[]>([]);

  const handleSelect = useCallback((item: InventoryItem) => {
    onSelect?.(item);
  }, [onSelect]);

  return (
    <Card className="inventory-list">
      <Table
        dataSource={data}
        loading={loading}
        onRow={(record) => ({
          onClick: () => handleSelect(record),
        })}
      />
    </Card>
  );
};

// ❌ 错误示例
function inventorylist(props) {  // 命名不规范
  var data = []  // 使用var，无类型
  return <div>{data}</div>
}
```

### 2.3 API请求规范

```typescript
// src/utils/request.ts
import axios from 'axios';

const request = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// 请求拦截器
request.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// 响应拦截器
request.interceptors.response.use(
  (response) => {
    const { data } = response;
    if (!data.success) {
      message.error(data.message || '操作失败');
      return Promise.reject(data);
    }
    return data.data;
  },
  (error) => {
    if (error.response?.status === 401) {
      // 未授权，跳转登录
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default request;
```

### 2.4 状态管理规范

```typescript
// src/stores/inventoryStore.ts
import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { InventoryItem } from '@/types/inventory';

interface InventoryState {
  // 状态
  inventoryList: InventoryItem[];
  currentItem: InventoryItem | null;
  loading: boolean;
  
  // 操作
  setInventoryList: (list: InventoryItem[]) => void;
  setCurrentItem: (item: InventoryItem | null) => void;
  updateStock: (id: string, quantity: number) => void;
}

export const useInventoryStore = create<InventoryState>()(
  devtools(
    persist(
      (set, get) => ({
        inventoryList: [],
        currentItem: null,
        loading: false,
        
        setInventoryList: (list) => set({ inventoryList: list }),
        
        setCurrentItem: (item) => set({ currentItem: item }),
        
        updateStock: (id, quantity) => {
          const { inventoryList } = get();
          const newList = inventoryList.map((item) =>
            item.id === id
              ? { ...item, stock: item.stock + quantity }
              : item
          );
          set({ inventoryList: newList });
        },
      }),
      {
        name: 'inventory-storage',
        partialize: (state) => ({ inventoryList: state.inventoryList }),
      }
    ),
    { name: 'InventoryStore' }
  )
);
```

---

## 3. 后端技术规范

### 3.1 项目结构

```
backend/
├── src/
│   ├── config/                  # 配置文件
│   │   ├── database.ts          # 数据库配置
│   │   ├── redis.ts             # Redis配置
│   │   └── app.ts               # 应用配置
│   │
│   ├── controllers/             # 控制器层
│   │   ├── inventory.controller.ts
│   │   ├── inbound.controller.ts
│   │   ├── outbound.controller.ts
│   │   ├── project.controller.ts
│   │   ├── bom.controller.ts
│   │   ├── report.controller.ts
│   │   └── system.controller.ts
│   │
│   ├── services/                # 服务层（业务逻辑）
│   │   ├── inventory.service.ts
│   │   ├── inbound.service.ts
│   │   ├── outbound.service.ts
│   │   ├── stock.service.ts     # 库存变动核心服务
│   │   ├── cost.service.ts      # 成本计算服务
│   │   └── report.service.ts
│   │
│   ├── repositories/            # 数据访问层
│   │   ├── inventory.repo.ts
│   │   ├── inbound.repo.ts
│   │   └── outbound.repo.ts
│   │
│   ├── models/                  # 数据模型 (Prisma)
│   │   └── schema.prisma
│   │
│   ├── middleware/              # 中间件
│   │   ├── auth.middleware.ts   # 认证
│   │   ├── error.middleware.ts  # 错误处理
│   │   ├── log.middleware.ts    # 日志
│   │   └── validate.middleware.ts
│   │
│   ├── routes/                  # 路由定义
│   │   ├── index.ts
│   │   ├── inventory.routes.ts
│   │   ├── inbound.routes.ts
│   │   └── ...
│   │
│   ├── utils/                   # 工具函数
│   │   ├── logger.ts            # 日志工具
│   │   ├── response.ts          # 响应封装
│   │   ├── crypto.ts            # 加密工具
│   │   └── date.ts              # 日期处理
│   │
│   ├── types/                   # 类型定义
│   │   ├── express.d.ts
│   │   └── common.ts
│   │
│   ├── jobs/                    # 定时任务
│   │   ├── alert.job.ts         # 预警检查
│   │   └── backup.job.ts        # 数据备份
│   │
│   └── app.ts                   # 应用入口
│
├── prisma/
│   ├── schema.prisma            # Prisma模型定义
│   └── migrations/              # 数据库迁移
│
├── tests/                       # 测试文件
├── logs/                        # 日志文件
├── .env                         # 环境变量
├── .env.example
├── tsconfig.json
└── package.json
```

### 3.2 API设计规范

#### URL设计

```
GET    /api/v1/inventory          # 列表查询
GET    /api/v1/inventory/:id      # 详情查询
POST   /api/v1/inventory          # 创建
PUT    /api/v1/inventory/:id      # 更新
DELETE /api/v1/inventory/:id      # 删除

POST   /api/v1/inbound            # 入库登记
POST   /api/v1/outbound           # 出库登记
POST   /api/v1/stocktaking        # 盘点

GET    /api/v1/reports/cost       # 成本报表
GET    /api/v1/reports/inventory  # 库存报表
```

#### 响应格式

```typescript
// 成功响应
{
  "success": true,
  "data": { ... },
  "message": "操作成功"
}

// 列表响应
{
  "success": true,
  "data": {
    "list": [ ... ],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 100,
      "totalPages": 5
    }
  }
}

// 错误响应
{
  "success": false,
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "参数错误",
    "details": [
      { "field": "quantity", "message": "数量必须大于0" }
    ]
  }
}
```

#### 错误码定义

| 错误码 | HTTP状态码 | 说明 |
|--------|-----------|------|
| SUCCESS | 200 | 成功 |
| INVALID_PARAMETER | 400 | 参数错误 |
| UNAUTHORIZED | 401 | 未认证 |
| FORBIDDEN | 403 | 无权限 |
| NOT_FOUND | 404 | 资源不存在 |
| CONFLICT | 409 | 资源冲突（如重复） |
| INTERNAL_ERROR | 500 | 服务器内部错误 |
| SERVICE_UNAVAILABLE | 503 | 服务暂时不可用 |

### 3.3 业务逻辑规范

#### 库存变动统一入口

```typescript
// src/services/stock.service.ts
export class StockService {
  /**
   * 库存变动统一处理
   * @param type 变动类型
   * @param materialId 物料ID
   * @param quantity 变动数量（正数增加，负数减少）
   * @param relatedId 关联单据ID
   */
  async updateStock(
    type: 'inbound' | 'outbound' | 'scrap' | 'adjust',
    materialId: string,
    quantity: number,
    relatedId: string,
    operator: string
  ): Promise<void> {
    // 1. 开启事务
    await prisma.$transaction(async (tx) => {
      // 2. 查询当前库存
      const inventory = await tx.inventory.findUnique({
        where: { materialId },
      });

      if (!inventory) {
        throw new Error('库存记录不存在');
      }

      // 3. 检查库存充足性（出库时）
      if (quantity < 0 && inventory.stock + quantity < 0) {
        throw new Error('库存不足');
      }

      // 4. 更新库存
      await tx.inventory.update({
        where: { materialId },
        data: { 
          stock: { increment: quantity },
          lastUpdate: new Date(),
        },
      });

      // 5. 记录库存流水
      await tx.stockLog.create({
        data: {
          type,
          materialId,
          quantity,
          beforeStock: inventory.stock,
          afterStock: inventory.stock + quantity,
          relatedId,
          operator,
          createdAt: new Date(),
        },
      });
    });
  }
}
```

#### 成本计算服务

```typescript
// src/services/cost.service.ts
export class CostService {
  /**
   * 计算项目成本
   */
  async calculateProjectCost(
    projectId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<ProjectCost> {
    const where: Prisma.OutboundWhereInput = {
      projectId,
      status: 'completed',
    };

    if (startDate && endDate) {
      where.createdAt = {
        gte: startDate,
        lte: endDate,
      };
    }

    // 汇总该项目的所有出库记录成本
    const outbounds = await prisma.outbound.findMany({
      where,
      include: {
        items: true,
      },
    });

    const totalCost = outbounds.reduce((sum, outbound) => {
      return sum + outbound.items.reduce((itemSum, item) => {
        return itemSum + item.totalCost;
      }, 0);
    }, 0);

    const sampleCount = await this.getSampleCount(projectId, startDate, endDate);

    return {
      projectId,
      totalCost,
      sampleCount,
      unitCost: sampleCount > 0 ? totalCost / sampleCount : 0,
      detail: outbounds,
    };
  }
}
```

### 3.4 数据库事务规范

```typescript
// ✅ 正确使用事务
async createInbound(data: CreateInboundDto): Promise<Inbound> {
  return await prisma.$transaction(async (tx) => {
    // 1. 创建入库记录
    const inbound = await tx.inbound.create({
      data: { ...data, status: 'completed' },
    });

    // 2. 更新库存
    await tx.inventory.update({
      where: { materialId: data.materialId },
      data: { stock: { increment: data.quantity } },
    });

    // 3. 记录批次
    await tx.batch.create({
      data: {
        materialId: data.materialId,
        batchNo: data.batchNo,
        quantity: data.quantity,
        expiryDate: data.expiryDate,
        inboundId: inbound.id,
      },
    });

    return inbound;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
}
```

---

## 4. 数据库规范

### 4.1 命名规范

| 对象 | 规范 | 示例 |
|------|------|------|
| 表名 | snake_case，复数 | `inbound_records`, `material_categories` |
| 字段名 | snake_case | `material_id`, `created_at` |
| 索引名 | idx_表名_字段名 | `idx_inbound_material_id` |
| 外键名 | fk_表名_引用表 | `fk_inbound_material` |
| 存储过程 | sp_功能描述 | `sp_calculate_monthly_cost` |

### 4.2 字段设计规范

```sql
-- 必须字段（每个表都应包含）
`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
`created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
`updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
`created_by` VARCHAR(64) COMMENT '创建人',
`updated_by` VARCHAR(64) COMMENT '更新人',
`is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '是否删除(0:否,1:是)',

-- 业务字段示例
`material_id` VARCHAR(32) NOT NULL COMMENT '物料ID',
`quantity` DECIMAL(18, 4) NOT NULL COMMENT '数量',
`status` TINYINT NOT NULL DEFAULT 1 COMMENT '状态(1:启用,0:禁用)',
`remark` VARCHAR(500) COMMENT '备注',
```

### 4.3 索引设计原则

1. **主键索引**: 所有表必须有主键，使用`BIGINT UNSIGNED AUTO_INCREMENT`
2. **外键索引**: 外键字段必须建索引
3. **查询索引**: WHERE条件中的高频字段建索引
4. **联合索引**: 遵循最左前缀原则，将区分度高的字段放前面
5. **避免过度索引**: 单表索引不超过5个

```sql
-- ✅ 正确的索引设计
CREATE TABLE `inbound_records` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `inbound_no` VARCHAR(32) NOT NULL COMMENT '入库单号',
  `material_id` VARCHAR(32) NOT NULL COMMENT '物料ID',
  `batch_no` VARCHAR(64) COMMENT '批次号',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- ... 其他字段
  
  -- 索引
  UNIQUE KEY `uk_inbound_no` (`inbound_no`),
  KEY `idx_material_id` (`material_id`),
  KEY `idx_created_at` (`created_at`),
  KEY `idx_material_batch` (`material_id`, `batch_no`),
  
  -- 外键
  CONSTRAINT `fk_inbound_material` 
    FOREIGN KEY (`material_id`) REFERENCES `materials` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='入库记录表';
```

---

## 5. 安全规范

### 5.1 认证与授权

```typescript
// JWT认证中间件
export const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: '缺少认证令牌' }
    });
  }

  const token = authHeader.substring(7);
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: '无效的认证令牌' }
    });
  }
};

// 权限检查装饰器
export const requirePermission = (permission: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const userPermissions = req.user?.permissions || [];
    
    if (!userPermissions.includes(permission)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: '无权访问该资源' }
      });
    }
    
    next();
  };
};
```

### 5.2 数据安全

1. **敏感数据加密**: 密码使用bcrypt加密，其他敏感字段使用AES加密
2. **SQL注入防护**: 使用ORM参数化查询，禁止字符串拼接SQL
3. **XSS防护**: 前端使用React自动转义，后端对用户输入进行过滤
4. **CSRF防护**: 使用JWT令牌，不依赖Cookie认证

```typescript
// 密码加密
import bcrypt from 'bcrypt';

const SALT_ROUNDS = 12;

export const hashPassword = async (password: string): Promise<string> => {
  return await bcrypt.hash(password, SALT_ROUNDS);
};

export const verifyPassword = async (
  password: string,
  hash: string
): Promise<boolean> => {
  return await bcrypt.compare(password, hash);
};
```

### 5.3 日志审计

```typescript
// 操作日志中间件
export const auditLogMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const startTime = Date.now();
  
  // 记录请求
  logger.info({
    type: 'request',
    method: req.method,
    url: req.originalUrl,
    userId: req.user?.id,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  // 响应后记录
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info({
      type: 'response',
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      duration,
      userId: req.user?.id,
    });
  });

  next();
};
```

---

## 6. 部署规范

### 6.1 环境定义

| 环境 | 用途 | 配置 |
|------|------|------|
| Local | 本地开发 | 单机，开发数据库 |
| Dev | 开发测试 | Docker Compose，共享开发库 |
| Test | 集成测试 | 独立服务器，生产镜像 |
| Staging | 预发布 | 生产环境镜像，准生产数据 |
| Prod | 生产环境 | 高可用集群，主从数据库 |

### 6.2 Docker配置

```dockerfile
# Dockerfile (Backend)
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/app.js"]
```

```yaml
# docker-compose.yml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=${REDIS_URL}
    depends_on:
      - mysql
      - redis
    restart: always

  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: coreone
    volumes:
      - mysql_data:/var/lib/mysql
    restart: always

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    restart: always

volumes:
  mysql_data:
  redis_data:
```

---

## 7. 附录

### 7.1 技术债务追踪

| ID | 描述 | 影响 | 计划解决时间 |
|----|------|------|-------------|
| TD-001 | 库存查询未做缓存 | 性能 | v1.2 |
| TD-002 | 报表生成同步处理 | 性能 | v1.2 |
| TD-003 | 缺少分布式事务 | 可靠性 | v2.0 |

### 7.2 变更记录

| 版本 | 日期 | 变更内容 | 变更人 |
|------|------|----------|--------|
| v1.0 | 2026-04-20 | 初始技术规范 | Tech Lead |
| v1.1 | 2026-04-23 | 基于原型验证调整架构设计，统一版本号 | Tech Lead |
