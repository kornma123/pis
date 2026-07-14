# COREONE 实验室耗材管理系统 API设计文档

**版本**: v1.1  
**创建日期**: 2026-04-23  
**作者**: 技术团队  
**协议**: RESTful API + JSON  
**基础路径**: `/api/v1`  
**关联文档**: TECH-SPEC-v1.1.md, DATABASE-DESIGN-v1.1.md

---

## 1. API设计原则

### 1.1 RESTful设计规范

| HTTP方法 | 语义 | 使用场景 |
|----------|------|----------|
| GET | 读取 | 查询资源、获取列表、获取详情 |
| POST | 创建 | 创建资源、提交表单、执行业务操作 |
| PUT | 更新 | 全量更新资源 |
| PATCH | 部分更新 | 部分字段更新 |
| DELETE | 删除 | 删除资源 |

### 1.2 URL设计规范

```
# 资源层级
/api/v1/materials                    # 物料列表
/api/v1/materials/{id}               # 单个物料
/api/v1/materials/{id}/batches       # 物料的批次
/api/v1/materials/{id}/stock-logs    # 物料的库存流水

# 业务操作
/api/v1/inbound                      # 入库登记（POST）
/api/v1/outbound                     # 出库登记（POST）
/api/v1/stocktaking                  # 盘点（POST）

# 报表统计
/api/v1/reports/cost-by-project      # 项目成本报表
/api/v1/reports/cost-by-material     # 物料成本报表
```

### 1.3 通用请求参数

**分页参数**:
```
GET /api/v1/materials?page=1&pageSize=20
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| page | integer | 1 | 页码，从1开始 |
| pageSize | integer | 20 | 每页数量，最大100 |

**排序参数**:
```
GET /api/v1/materials?sortField=createdAt&sortOrder=desc
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| sortField | string | createdAt | 排序字段 |
| sortOrder | string | desc | 排序方向：asc/desc |

**搜索参数**:
```
GET /api/v1/materials?keyword=苏木素&categoryId=111
```

---

## 2. 认证相关 API

### 2.1 用户登录

```http
POST /api/v1/auth/login
```

**请求体**:
```json
{
  "username": "admin",
  "password": "password123"
}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 28800,
    "user": {
      "id": "USER-001",
      "username": "admin",
      "realName": "管理员",
      "role": "admin",
      "permissions": ["inventory:view", "inventory:edit", "report:view"]
    }
  }
}
```

### 2.2 刷新Token

```http
POST /api/v1/auth/refresh
```

**请求体**:
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### 2.3 退出登录

```http
POST /api/v1/auth/logout
```

---

## 3. 基础数据 API

### 3.1 物料分类

#### 获取分类树

```http
GET /api/v1/categories/tree
```

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "id": "1",
      "name": "试剂类",
      "code": "CAT-REAGENT",
      "level": 1,
      "count": 68,
      "children": [
        {
          "id": "11",
          "name": "HE染色试剂",
          "code": "CAT-REAGENT-HE",
          "level": 2,
          "count": 12,
          "children": [
            {
              "id": "111",
              "name": "苏木素染液",
              "code": "CAT-REAGENT-HE-001",
              "level": 3,
              "count": 5,
              "isLeaf": true
            }
          ]
        }
      ]
    }
  ]
}
```

#### 创建分类

```http
POST /api/v1/categories
```

**请求体**:
```json
{
  "name": "苏木素染液",
  "code": "CAT-REAGENT-HE-001",
  "parentId": "11",
  "level": 3
}
```

#### 更新分类

```http
PUT /api/v1/categories/{id}
```

#### 删除分类

```http
DELETE /api/v1/categories/{id}
```

**注意**: 分类下存在物料时不可删除

---

### 3.2 物料管理

#### 获取物料列表

```http
GET /api/v1/materials?page=1&pageSize=20&categoryId=111&keyword=苏木素
```

**响应**:
```json
{
  "success": true,
  "data": {
    "list": [
      {
        "id": "MAT-001",
        "code": "MAT-001",
        "name": "Harris苏木素染液",
        "spec": "500ml/瓶",
        "unit": "瓶",
        "price": 168.00,
        "stock": 24,
        "minStock": 5,
        "locationId": "LOC-001",
        "locationName": "A区-3-101",
        "categoryId": "111",
        "categoryPath": "试剂类 > HE染色试剂 > 苏木素染液",
        "supplierId": "SUP-001",
        "supplierName": "北京病理科技",
        "status": "active",
        "createdAt": "2024-01-15T09:30:00Z",
        "updatedAt": "2024-03-20T14:22:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 156,
      "totalPages": 8
    }
  }
}
```

#### 获取物料详情

```http
GET /api/v1/materials/{id}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "id": "MAT-001",
    "code": "MAT-001",
    "name": "Harris苏木素染液",
    "spec": "500ml/瓶",
    "unit": "瓶",
    "price": 168.00,
    "stock": 24,
    "minStock": 5,
    "maxStock": 100,
    "safetyStock": 10,
    "locationId": "LOC-001",
    "locationName": "A区-3-101",
    "categoryId": "111",
    "categoryPath": "试剂类 > HE染色试剂 > 苏木素染液",
    "supplierId": "SUP-001",
    "supplierName": "北京病理科技",
    "status": "active",
    "remark": "常温保存，避光",
    "batches": [
      {
        "id": "BAT-001",
        "batchNo": "20240115001",
        "quantity": 10,
        "productionDate": "2024-01-15",
        "expiryDate": "2026-01-14",
        "inboundId": "IB-2024-001"
      }
    ],
    "stockLogs": [
      {
        "id": "LOG-001",
        "type": "inbound",
        "quantity": 10,
        "beforeStock": 14,
        "afterStock": 24,
        "relatedId": "IB-2024-001",
        "operator": "张三",
        "createdAt": "2024-01-15T10:30:00Z"
      }
    ]
  }
}
```

#### 创建物料

```http
POST /api/v1/materials
```

**请求体**:
```json
{
  "code": "MAT-NEW-001",
  "name": "测试物料",
  "spec": "100ml/瓶",
  "unit": "瓶",
  "price": 100.00,
  "minStock": 5,
  "maxStock": 50,
  "categoryId": "111",
  "supplierId": "SUP-001",
  "locationId": "LOC-001",
  "remark": "测试用物料"
}
```

#### 更新物料

```http
PUT /api/v1/materials/{id}
```

#### 删除物料

```http
DELETE /api/v1/materials/{id}
```

#### 批量启用/停用

```http
PATCH /api/v1/materials/batch-status
```

**请求体**:
```json
{
  "ids": ["MAT-001", "MAT-002"],
  "status": "inactive"
}
```

---

### 3.3 供应商管理

#### 获取供应商列表

```http
GET /api/v1/suppliers?page=1&pageSize=20&status=active
```

**响应**:
```json
{
  "success": true,
  "data": {
    "list": [
      {
        "id": "SUP-001",
        "name": "赛默飞世尔",
        "contact": "张经理",
        "phone": "400-888-1234",
        "email": "zhang@thermofisher.com",
        "address": "上海市浦东新区",
        "status": "active",
        "cooperationCount": 25,
        "totalAmount": 328000,
        "createdAt": "2024-01-15T09:30:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 10
    }
  }
}
```

#### 创建供应商

```http
POST /api/v1/suppliers
```

**请求体**:
```json
{
  "name": "新供应商",
  "contact": "王经理",
  "phone": "400-123-4567",
  "email": "wang@example.com",
  "address": "北京市朝阳区"
}
```

#### 更新供应商

```http
PUT /api/v1/suppliers/{id}
```

#### 删除供应商

```http
DELETE /api/v1/suppliers/{id}
```

---

### 3.4 库位管理

#### 获取库位列表

```http
GET /api/v1/locations?zone=A区
```

**响应**:
```json
{
  "success": true,
  "data": {
    "list": [
      {
        "id": "LOC-001",
        "code": "A-3-101",
        "name": "A区-3-101",
        "zone": "A区",
        "shelf": "3层",
        "position": "101",
        "capacity": 100,
        "used": 45,
        "status": "active"
      }
    ]
  }
}
```

---

## 4. 库存管理 API

### 4.1 库存查询

#### 获取库存列表

```http
GET /api/v1/inventory?page=1&pageSize=20&status=low-stock
```

**查询参数**:

| 参数 | 类型 | 说明 |
|------|------|------|
| status | string | 筛选状态：all/normal/low-stock/warning/expired |
| categoryId | string | 按分类筛选 |
| locationId | string | 按库位筛选 |

**响应**:
```json
{
  "success": true,
  "data": {
    "list": [
      {
        "id": "INV-001",
        "materialId": "MAT-001",
        "code": "MAT-001",
        "name": "Harris苏木素染液",
        "spec": "500ml/瓶",
        "unit": "瓶",
        "stock": 24,
        "minStock": 5,
        "maxStock": 100,
        "locationId": "LOC-001",
        "locationName": "A区-3-101",
        "supplierId": "SUP-001",
        "supplierName": "北京病理科技",
        "status": "normal",
        "lastInbound": "2024-01-15",
        "lastOutbound": "2024-01-18"
      }
    ],
    "summary": {
      "total": 156,
      "normal": 120,
      "lowStock": 15,
      "warning": 12,
      "expired": 9
    }
  }
}
```

#### 获取库存统计

```http
GET /api/v1/inventory/stats
```

**响应**:
```json
{
  "success": true,
  "data": {
    "totalMaterials": 156,
    "totalStockValue": 285000.00,
    "lowStockCount": 15,
    "expiringCount": 12,
    "expiredCount": 3,
    "categoryDistribution": [
      { "categoryId": "1", "categoryName": "试剂类", "count": 68 },
      { "categoryId": "2", "categoryName": "耗材类", "count": 62 },
      { "categoryId": "3", "categoryName": "设备配件类", "count": 26 }
    ]
  }
}
```

---

## 5. 入库管理 API

### 5.1 入库记录查询

#### 获取入库列表

```http
GET /api/v1/inbound?page=1&pageSize=20&status=completed&startDate=2024-01-01&endDate=2024-01-31
```

**响应**:
```json
{
  "success": true,
  "data": {
    "list": [
      {
        "id": "IB-2024-001",
        "inboundNo": "IB-2024-001",
        "type": "purchase",
        "materialId": "MAT-001",
        "materialName": "Harris苏木素染液",
        "batchNo": "20240115001",
        "quantity": 10,
        "unit": "瓶",
        "price": 168.00,
        "amount": 1680.00,
        "supplierId": "SUP-001",
        "supplierName": "北京病理科技",
        "locationId": "LOC-001",
        "locationName": "A区-3-101",
        "productionDate": "2024-01-15",
        "expiryDate": "2026-01-14",
        "operator": "张三",
        "status": "completed",
        "createdAt": "2024-01-15T10:30:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 150
    }
  }
}
```

#### 获取入库详情

```http
GET /api/v1/inbound/{id}
```

### 5.2 入库登记

```http
POST /api/v1/inbound
```

**请求体**:
```json
{
  "type": "purchase",
  "materialId": "MAT-001",
  "batchNo": "20240115001",
  "quantity": 10,
  "price": 168.00,
  "supplierId": "SUP-001",
  "locationId": "LOC-001",
  "productionDate": "2024-01-15",
  "expiryDate": "2026-01-14",
  "remark": "常规采购入库"
}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "id": "IB-2024-001",
    "inboundNo": "IB-2024-001",
    "type": "purchase",
    "materialId": "MAT-001",
    "batchNo": "20240115001",
    "quantity": 10,
    "status": "completed",
    "createdAt": "2024-01-15T10:30:00Z"
  },
  "message": "入库成功，库存已更新"
}
```

### 5.3 批量入库

```http
POST /api/v1/inbound/batch
```

**请求体**:
```json
{
  "items": [
    {
      "materialId": "MAT-001",
      "batchNo": "20240115001",
      "quantity": 10,
      "supplierId": "SUP-001",
      "locationId": "LOC-001"
    },
    {
      "materialId": "MAT-002",
      "batchNo": "20240115002",
      "quantity": 5,
      "supplierId": "SUP-001",
      "locationId": "LOC-002"
    }
  ],
  "remark": "批量入库"
}
```

### 5.4 取消入库

```http
POST /api/v1/inbound/{id}/cancel
```

**请求体**:
```json
{
  "reason": "录入错误，取消入库"
}
```

---

## 6. 出库管理 API

### 6.1 出库记录查询

#### 获取出库列表

```http
GET /api/v1/outbound?page=1&pageSize=20&projectId=HE-001&status=completed
```

**响应**:
```json
{
  "success": true,
  "data": {
    "list": [
      {
        "id": "OB-2024-001",
        "outboundNo": "OB-2024-001",
        "type": "project",
        "projectId": "HE-001",
        "projectName": "HE常规制片",
        "items": [
          {
            "id": "ITEM-001",
            "materialId": "MAT-001",
            "materialName": "Harris苏木素染液",
            "batchNo": "20240115001",
            "quantity": 2,
            "unit": "瓶",
            "unitCost": 168.00,
            "totalCost": 336.00
          }
        ],
        "totalCost": 336.00,
        "operator": "张三",
        "status": "completed",
        "createdAt": "2024-01-18T11:00:00Z"
      }
    ]
  }
}
```

### 6.2 出库登记

```http
POST /api/v1/outbound
```

**请求体**:
```json
{
  "type": "project",
  "projectId": "HE-001",
  "items": [
    {
      "materialId": "MAT-001",
      "quantity": 2
    },
    {
      "materialId": "MAT-011",
      "quantity": 1
    }
  ],
  "remark": "HE制片领用"
}
```

**业务规则**:
- 系统按FIFO原则自动分配批次
- 库存不足时返回错误，提示具体物料缺口

**响应**:
```json
{
  "success": true,
  "data": {
    "id": "OB-2024-001",
    "outboundNo": "OB-2024-001",
    "type": "project",
    "projectId": "HE-001",
    "items": [
      {
        "materialId": "MAT-001",
        "batchNo": "20240115001",
        "quantity": 2,
        "unitCost": 168.00,
        "totalCost": 336.00
      }
    ],
    "totalCost": 336.00,
    "status": "completed"
  }
}
```

### 6.3 BOM一键出库（已下线）

`POST /api/v1/outbound/bom` 已于 2026-07-14 下线：项目尚未上线且没有前端或外部消费者，继续保留会形成无人验证的库存写入口。

当前唯一受支持的出库创建合同是 6.2 的 `POST /api/v1/outbound`，`type` 仅接受 `direct`、`project`、`transfer`、`scrap`；不得用普通合同传入 `type = 'bom'` 绕过下线。历史 `type = 'bom'` 出库数据只读，并保留查询、成本回溯和重算兼容；本次下线不删除历史数据，也不改变既有成本口径。

库存页的“按检测项目添加”仍保留：它只负责把 BOM 物料批量加入普通出库明细，最终逐项调用 `POST /api/v1/outbound` 且使用 `type = 'direct'`；它不是已下线的按样本数自动扣库端点。

---

## 7. 检测项目 API

### 7.1 项目管理

#### 获取项目列表

```http
GET /api/v1/projects?page=1&pageSize=20&type=he&status=active
```

**响应**:
```json
{
  "success": true,
  "data": {
    "list": [
      {
        "id": "HE-001",
        "code": "HE-001",
        "name": "HE常规制片",
        "type": "he",
        "typeName": "病理技术",
        "cycle": "1-2个工作日",
        "bomId": "BOM-001",
        "bomName": "HE制片标准套装",
        "supportableSamples": 150,
        "status": "active",
        "manager": "张医生",
        "description": "常规HE染色制片",
        "createdAt": "2024-01-10T09:00:00Z"
      }
    ]
  }
}
```

#### 获取项目详情

```http
GET /api/v1/projects/{id}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "id": "HE-001",
    "code": "HE-001",
    "name": "HE常规制片",
    "type": "he",
    "cycle": "1-2个工作日",
    "bomId": "BOM-001",
    "supportableSamples": 150,
    "status": "active",
    "manager": "张医生",
    "description": "常规HE染色制片",
    "costStats": {
      "totalCost": 285000.00,
      "sampleCount": 12450,
      "unitCost": 22.90
    },
    "bom": {
      "id": "BOM-001",
      "name": "HE制片标准套装",
      "version": "v2.3",
      "materials": [...]
    }
  }
}
```

#### 创建项目

```http
POST /api/v1/projects
```

**请求体**:
```json
{
  "code": "HE-003",
  "name": "HE快速制片",
  "type": "he",
  "cycle": "30分钟",
  "manager": "李医生",
  "description": "快速HE染色制片"
}
```

#### 更新项目

```http
PUT /api/v1/projects/{id}
```

#### 删除项目

```http
DELETE /api/v1/projects/{id}
```

---

## 8. BOM管理 API

### 8.1 BOM查询

#### 获取BOM列表

```http
GET /api/v1/boms?page=1&pageSize=20&type=HE制片
```

**响应**:
```json
{
  "success": true,
  "data": {
    "list": [
      {
        "id": "BOM-001",
        "code": "BOM-001",
        "name": "HE制片标准套装",
        "type": "HE制片",
        "serviceId": "HE-001",
        "serviceName": "HE常规制片",
        "version": "v2.3",
        "materialCount": 8,
        "supportableSamples": 150,
        "unitCost": 12.50,
        "status": "active",
        "createdAt": "2024-01-01T10:00:00Z",
        "updatedAt": "2024-01-15T14:30:00Z"
      }
    ]
  }
}
```

#### 获取BOM详情

```http
GET /api/v1/boms/{id}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "id": "BOM-001",
    "code": "BOM-001",
    "name": "HE制片标准套装",
    "version": "v2.3",
    "type": "HE制片",
    "serviceId": "HE-001",
    "materialCount": 8,
    "supportableSamples": 150,
    "unitCost": 12.50,
    "status": "active",
    "materials": [
      {
        "id": "MAT-001",
        "name": "苏木精染液",
        "spec": "500ml/瓶",
        "usagePerSample": 0.5,
        "unit": "ml",
        "price": 168.00,
        "stock": 120,
        "costRatio": 0.35
      },
      {
        "id": "MAT-011",
        "name": "伊红染液",
        "spec": "500ml/瓶",
        "usagePerSample": 0.3,
        "unit": "ml",
        "price": 85.00,
        "stock": 85,
        "costRatio": 0.20
      }
    ],
    "versionHistory": [
      {
        "version": "v2.2",
        "updatedAt": "2024-01-01T10:00:00Z",
        "changeLog": "初始版本"
      },
      {
        "version": "v2.3",
        "updatedAt": "2024-01-15T14:30:00Z",
        "changeLog": "调整苏木精用量"
      }
    ]
  }
}
```

### 8.2 创建BOM

```http
POST /api/v1/boms
```

**请求体**:
```json
{
  "name": "HE制片标准套装",
  "type": "HE制片",
  "serviceId": "HE-001",
  "description": "常规HE染色制片物料",
  "materials": [
    {
      "materialId": "MAT-001",
      "usagePerSample": 0.5,
      "unit": "ml"
    },
    {
      "materialId": "MAT-011",
      "usagePerSample": 0.3,
      "unit": "ml"
    }
  ]
}
```

### 8.3 更新BOM

```http
PUT /api/v1/boms/{id}
```

**注意**: 更新BOM会自动生成新版本

### 8.4 删除BOM

```http
DELETE /api/v1/boms/{id}
```

---

## 9. 报表统计 API

### 9.1 项目成本报表

```http
GET /api/v1/reports/cost-by-project?startDate=2024-01-01&endDate=2024-01-31
```

**响应**:
```json
{
  "success": true,
  "data": {
    "summary": {
      "totalCost": 1085000.00,
      "projectCost": 1028000.00,
      "publicCost": 57000.00,
      "totalSamples": 18630
    },
    "projects": [
      {
        "id": "PRJ-001",
        "name": "分子病理检测",
        "category": "molecular",
        "sampleCount": 450,
        "unitCost": 782.20,
        "totalCost": 352000.00,
        "ratio": 34.2,
        "changeRate": 12,
        "changeDirection": "up"
      },
      {
        "id": "PRJ-002",
        "name": "HE制片",
        "category": "pathology-tech",
        "sampleCount": 12450,
        "unitCost": 22.90,
        "totalCost": 285000.00,
        "ratio": 27.7,
        "changeRate": 3,
        "changeDirection": "down"
      }
    ]
  }
}
```

### 9.2 物料成本报表

```http
GET /api/v1/reports/cost-by-material?startDate=2024-01-01&endDate=2024-01-31&categoryId=1
```

**响应**:
```json
{
  "success": true,
  "data": {
    "materials": [
      {
        "id": "MAT-COST-001",
        "name": "NGS建库试剂盒",
        "spec": "50次/盒",
        "consumption": 45,
        "consumptionUnit": "盒",
        "totalCost": 144000.00,
        "ratio": 13.3,
        "changeRate": 15,
        "changeDirection": "up"
      }
    ],
    "trend": [
      { "date": "2024-01-01", "cost": 12000 },
      { "date": "2024-01-15", "cost": 15000 },
      { "date": "2024-01-31", "cost": 13000 }
    ]
  }
}
```

### 9.3 供应商成本报表

```http
GET /api/v1/reports/cost-by-supplier?startDate=2024-01-01&endDate=2024-01-31
```

**响应**:
```json
{
  "success": true,
  "data": {
    "suppliers": [
      {
        "id": "SUP-COST-001",
        "name": "罗氏诊断",
        "amount": 452000.00,
        "ratio": 35.6,
        "orderCount": 12,
        "status": "long-term"
      },
      {
        "id": "SUP-COST-002",
        "name": "赛默飞",
        "amount": 328000.00,
        "ratio": 25.8,
        "orderCount": 8,
        "status": "long-term"
      }
    ]
  }
}
```

### 9.4 库存周转报表

```http
GET /api/v1/reports/inventory-turnover?period=monthly&startDate=2024-01-01&endDate=2024-03-31
```

---

## 10. 预警管理 API

### 10.1 预警规则配置

#### 获取预警规则

```http
GET /api/v1/alert-rules
```

**响应**:
```json
{
  "success": true,
  "data": {
    "rules": [
      {
        "id": "RULE-001",
        "type": "low-stock",
        "name": "低库存预警",
        "threshold": 5,
        "enabled": true
      },
      {
        "id": "RULE-002",
        "type": "expiry",
        "name": "有效期预警",
        "thresholdDays": 30,
        "enabled": true
      }
    ]
  }
}
```

#### 更新预警规则

```http
PUT /api/v1/alert-rules/{id}
```

### 10.2 预警查询与处理

#### 获取预警列表

```http
GET /api/v1/alerts?status=pending&type=low-stock
```

**响应**:
```json
{
  "success": true,
  "data": {
    "list": [
      {
        "id": "ALT-001",
        "type": "low-stock",
        "level": "warning",
        "materialId": "MAT-001",
        "materialName": "Harris苏木素染液",
        "currentStock": 3,
        "threshold": 5,
        "message": "库存低于安全库存，当前库存3，安全库存5",
        "status": "pending",
        "createdAt": "2024-01-20T10:00:00Z"
      }
    ]
  }
}
```

#### 处理预警

```http
POST /api/v1/alerts/{id}/handle
```

**请求体**:
```json
{
  "action": "processed",
  "remark": "已安排采购"
}
```

---

## 11. 系统管理 API

### 11.1 用户管理

#### 获取用户列表

```http
GET /api/v1/users?page=1&pageSize=20
```

#### 创建用户

```http
POST /api/v1/users
```

**请求体**:
```json
{
  "username": "newuser",
  "password": "password123",
  "realName": "新用户",
  "role": "operator",
  "department": "病理科",
  "phone": "13800138000"
}
```

### 11.2 角色权限

#### 获取角色列表

```http
GET /api/v1/roles
```

#### 获取角色权限

```http
GET /api/v1/roles/{id}/permissions
```

### 11.3 操作日志

```http
GET /api/v1/logs/operation?page=1&pageSize=20&startDate=2024-01-01&userId=USER-001
```

**响应**:
```json
{
  "success": true,
  "data": {
    "list": [
      {
        "id": "LOG-001",
        "userId": "USER-001",
        "username": "admin",
        "operation": "inbound.create",
        "description": "创建入库记录",
        "requestData": {...},
        "responseData": {...},
        "ip": "192.168.1.100",
        "userAgent": "Mozilla/5.0...",
        "createdAt": "2024-01-15T10:30:00Z"
      }
    ]
  }
}
```

---

## 12. 错误码定义

| 错误码 | HTTP状态码 | 说明 |
|--------|-----------|------|
| SUCCESS | 200 | 操作成功 |
| INVALID_PARAMETER | 400 | 请求参数错误 |
| UNAUTHORIZED | 401 | 未授权，需要登录 |
| FORBIDDEN | 403 | 无权限执行该操作 |
| NOT_FOUND | 404 | 资源不存在 |
| RESOURCE_CONFLICT | 409 | 资源冲突（如重复） |
| STOCK_INSUFFICIENT | 422 | 库存不足 |
| VALIDATION_ERROR | 422 | 业务验证失败 |
| INTERNAL_ERROR | 500 | 服务器内部错误 |
| SERVICE_UNAVAILABLE | 503 | 服务暂时不可用 |

---

## 13. 附录

### 13.1 变更记录

| 版本 | 日期 | 变更内容 | 变更人 |
|------|------|----------|--------|
| v1.0 | 2026-04-20 | 初始API设计 | Tech Lead |
| v1.1 | 2026-04-23 | 基于原型验证补充完整API定义，统一版本号 | Tech Lead |

### 13.2 参考文档

- [TECH-SPEC-v1.1.md](./TECH-SPEC-v1.1.md) - 技术规范文档
- [DATABASE-DESIGN-v1.1.md](./DATABASE-DESIGN-v1.1.md) - 数据库设计文档
