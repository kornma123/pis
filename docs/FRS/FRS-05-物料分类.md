# FRS-05 物料分类

> **文档编号**: FRS-05  
> **版本**: v1.1.0  
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)  

---

## 1. 功能概述

三级分类树管理，支持分类编码自动生成、树形结构展示、分类下物料数量统计。分类是物料管理的基础数据，决定物料编码前缀。

| 项目 | 说明 |
|------|------|
| **功能定位** | 物料主数据分类体系，三级树形结构 |
| **可访问角色** | 全部角色可读；创建/编辑/删除仅 `admin` |
| **RBAC 控制** | 读：`requireRole('admin','warehouse_manager','technician','pathologist','procurement')`；写：`requireRole('admin')` |
| **数据规模** | 初始化 26 个分类（4 个一级、8 个二级、14 个三级） |

---

## 2. 分类体系结构

### 2.1 层级定义

| 层级 | 编码范围 | 编码规则 | 示例 |
|------|---------|---------|------|
| 一级（level=1） | 100, 200, 300... | MAX+100，步长 100 | `100`=试剂类, `200`=耗材类 |
| 二级（level=2） | 101-199, 201-299... | 同 parent 下 MAX+1 | `101`=HE染色, `102`=免疫组化 |
| 三级（level=3） | 10101-19999... | 同 parent 下 MAX+1 | `10101`=苏木素, `10102`=伊红 |

### 2.2 初始化分类示例

```
试剂类(100)
├── HE染色(101)
│   ├── 苏木素(10101)
│   ├── 伊红(10102)
│   └── 分化液(10103)
├── 免疫组化(102)
│   ├── 一抗(10201)
│   ├── 二抗(10202)
│   └── DAB显色(10203)
├── 特殊染色(103)
└── 分子试剂(104)

耗材类(200)
├── 载玻片(201)
├── 盖玻片(202)
├── 包埋盒(203)
└── 刀片(204)

设备配件(300)
└── ...

危化品(400)
└── ...
```

---

## 3. 业务流程图

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   创建分类   │────→│  校验name/   │────→│  判断层级    │
│  (admin)    │     │  level非空   │     │  (1/2/3)    │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                    ┌───────────────────────────┼───────────────────────────┐
                    ▼                           ▼                           ▼
            ┌─────────────┐            ┌─────────────┐              ┌─────────────┐
            │   level=1   │            │   level=2   │              │   level=3   │
            │ MAX+100     │            │ 同parent    │              │ 同parent    │
            │ (100,200..) │            │ MAX+1       │              │ MAX+1       │
            └──────┬──────┘            └──────┬──────┘              └──────┬──────┘
                   │                          │                            │
                   └──────────────────────────┼────────────────────────────┘
                                              ▼
                                     ┌─────────────────┐
                                     │ code唯一性检查   │
                                     │ status=1        │
                                     └────────┬────────┘
                                              ▼
                                     ┌─────────────────┐
                                     │   返回201+分类ID  │
                                     └─────────────────┘
```

---

## 4. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | GET | `/categories/tree` | 三级分类树（完整树形） | 任意角色 Token |
| 2 | GET | `/categories` | 分类列表（分页+搜索） | 任意角色 Token |
| 3 | POST | `/categories` | 创建分类 | admin Token |
| 4 | PUT | `/categories/:id` | 编辑分类 | admin Token |
| 5 | DELETE | `/categories/:id` | 删除分类 | admin Token |

---

## 5. 接口详情

### 5.1 GET /categories/tree — 分类树

#### 5.1.1 请求参数

无请求参数。

#### 5.1.2 业务流程规则

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 查询所有分类 | `SELECT * FROM categories WHERE is_deleted = 0 ORDER BY code` |
| 2 | 构建树形结构 | 递归按 `parent_id` 组织层级 |
| 3 | 计算物料数量 | 每个节点 `count = SELECT COUNT(*) FROM materials WHERE category_id = ?` |
| 4 | 标记叶子节点 | `isLeaf = children.length === 0` |

#### 5.1.3 响应结构

```json
[
  {
    "id": "uuid-100",
    "code": "100",
    "name": "试剂类",
    "level": 1,
    "children": [
      {
        "id": "uuid-101",
        "code": "101",
        "name": "HE染色",
        "level": 2,
        "children": [
          {
            "id": "uuid-10101",
            "code": "10101",
            "name": "苏木素",
            "level": 3,
            "isLeaf": true,
            "count": 5
          }
        ]
      }
    ]
  }
]
```

#### 5.1.4 响应字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `code` | string | 分类编码（纯数字） |
| `name` | string | 分类名称 |
| `level` | integer | 层级（1/2/3） |
| `children` | array | 子分类数组（叶子节点为空数组或省略） |
| `isLeaf` | boolean | 是否为叶子节点（无子分类） |
| `count` | integer | 该分类下直接关联的物料数量 |

#### 5.1.5 隐含规则显式化

| 规则 | 说明 |
|------|------|
| `count` 统计范围 | 仅统计直接关联的物料（`category_id` 精确匹配），不统计子分类下的物料 |
| `isLeaf` 动态计算 | 由后端根据是否有子节点动态计算，非数据库存储字段 |
| 排序规则 | 按 `code` 升序排列，确保树形展示顺序一致 |
| 完整树返回 | 返回所有层级分类，不裁剪 |

---

### 5.2 GET /categories — 分类列表

#### 5.2.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `page` | ❌ | integer | 1 | 页码 |
| `pageSize` | ❌ | integer | 20 | 每页条数 |
| `keyword` | ❌ | string | - | 搜索 name 或 code |

#### 5.2.2 响应字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `code` | string | 分类编码 |
| `name` | string | 分类名称 |
| `level` | integer | 层级 |
| `parentId` | string | 父分类 ID（一级为 null） |
| `sortOrder` | integer | 排序号 |
| `status` | enum | "active"/"inactive" |
| `createdAt` | datetime | 创建时间 |

---

### 5.3 POST /categories — 创建分类

#### 5.3.1 请求参数

| 字段 | 必填 | 类型 | 长度限制 | 格式 | 默认值 | 校验规则 | 错误提示 |
|------|------|------|---------|------|--------|---------|---------|
| `name` | ✅ | string | 1-100 | 非空字符串 | - | 非空 | "Name and level required" |
| `level` | ✅ | integer | - | 1/2/3 | - | 必须为 1、2 或 3 | "Name and level required" |
| `parentId` | ❌ | string | - | UUID | null | 指向存在的父分类 | - |
| `sortOrder` | ❌ | integer | - | ≥0 | 0 | - | - |

#### 5.3.2 业务流程规则

| 步骤 | 操作 | 失败处理 |
|------|------|---------|
| 1 | 校验 `name` 和 `level` 非空 | 400 "Name and level required" |
| 2 | 根据层级生成 `code` | - |
| 3 | 检查 `code` 唯一性 | 409 "Code already exists" |
| 4 | `status` = 1 | - |
| 5 | INSERT 并返回新分类 ID | 201 |

#### 5.3.3 编码生成规则详解

| 层级 | 生成公式 | 示例 |
|------|---------|------|
| 一级（level=1） | `MAX(CAST(code AS INTEGER)) + 100` | 当前最大 400 → 新编码 500 |
| 二级（level=2） | `MAX(CAST(code AS INTEGER)) + 1 WHERE parent_id = ?` | 同 parent 最大 102 → 新编码 103 |
| 三级（level=3） | `MAX(CAST(code AS INTEGER)) + 1 WHERE parent_id = ?` | 同 parent 最大 10203 → 新编码 10204 |

```javascript
// 一级分类编码生成伪代码
const maxCode = db.prepare("SELECT MAX(CAST(code AS INTEGER)) as max FROM categories WHERE level = 1").get();
const newCode = (maxCode.max || 0) + 100;  // 100, 200, 300...

// 二级/三级编码生成伪代码
const maxCode = db.prepare("SELECT MAX(CAST(code AS INTEGER)) as max FROM categories WHERE parent_id = ?").get(parentId);
const newCode = (maxCode.max || parentCode * 100) + 1;  // 101, 102, 10101...
```

#### 5.3.4 隐含规则显式化

| 规则 | 说明 |
|------|------|
| `parentId` 校验 | 创建二/三级分类时，系统未校验 `parentId` 是否存在（靠前端保证） |
| 编码纯数字 | code 为纯数字字符串，不含字母或符号 |
| 一级编码以 00 结尾 | 100, 200, 300... 便于识别层级 |
| 编码范围 | 一级 100-900；二级在父级+1 到父级+99；三级在父级+1 |
| code 唯一性范围 | 全表唯一，不区分层级 |

---

### 5.4 PUT /categories/:id — 编辑分类

#### 5.4.1 请求参数

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `name` | ❌ | string | 分类名称 |
| `sortOrder` | ❌ | integer | 排序号 |
| `status` | ❌ | enum | "active"/"inactive" |

#### 5.4.2 业务流程规则

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 查询分类是否存在 | 404 若不存在 |
| 2 | 仅更新传入字段 | PATCH 语义 |
| 3 | `updated_at` 自动刷新 | - |
| 4 | 返回 200 + `{id}` | - |

#### 5.4.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 编码不可修改 | 接口不支持修改 `code` 和 `level`，分类一旦创建不可调整层级 |
| 父节点不可修改 | 不支持修改 `parentId`，分类一旦挂载不可调整父分类 |
| 名称可修改 | 仅 `name`、`sortOrder`、`status` 可修改 |

---

### 5.5 DELETE /categories/:id — 删除分类

#### 5.5.1 业务流程规则

| 步骤 | 操作 | 失败处理 |
|------|------|---------|
| 1 | 查询分类是否存在 | 404 若不存在 |
| 2 | 检查是否有子分类 | `SELECT COUNT(*) FROM categories WHERE parent_id = ? AND is_deleted = 0` > 0 → 409 "Has children" |
| 3 | 检查是否有关联物料 | `SELECT COUNT(*) FROM materials WHERE category_id = ? AND is_deleted = 0` > 0 → 409 "Has materials" |
| 4 | UPDATE `is_deleted = 1` | 逻辑删除 |
| 5 | 返回 200 | - |

#### 5.5.2 删除前置校验矩阵

| 条件 | 校验结果 | 错误提示 |
|------|---------|---------|
| 有子分类 | ❌ 不可删除 | "Has children" |
| 有关联物料 | ❌ 不可删除 | "Has materials" |
| 无子分类且无物料 | ✅ 可删除 | - |

#### 5.5.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 强制级联检查 | 必须同时满足"无子分类"和"无关联物料"两个条件才可删除 |
| 逻辑删除 | 删除后分类数据保留，仅标记 `is_deleted = 1` |
| 子分类保护 | 一级分类下有二级分类时不可删除，即使二级分类下无物料 |

---

## 6. 数据模型

### 6.1 实体定义

```
┌─────────────────────────────────────────────────────────────┐
│                     categories                              │
├─────────────────────────────────────────────────────────────┤
│ id           TEXT PRIMARY KEY  (UUIDv4)                     │
│ code         TEXT NOT NULL UNIQUE                           │
│ name         TEXT NOT NULL                                  │
│ level        INTEGER NOT NULL  (1/2/3)                      │
│ parent_id    TEXT  (父分类ID，一级为null)                      │
│ sort_order   INTEGER DEFAULT 0                              │
│ status       INTEGER DEFAULT 1                              │
│ is_deleted   INTEGER DEFAULT 0                              │
│ created_at   DATETIME DEFAULT CURRENT_TIMESTAMP             │
│ updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP             │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 与物料管理关联

```
┌─────────────┐         ┌─────────────┐
│ categories  │◄────────│  materials  │
├─────────────┤   1:N   ├─────────────┤
│ id (PK)     │         │ category_id │
│ code        │         │ ...         │
│ level       │         └─────────────┘
│ parent_id   │
└─────────────┘
```

- `materials.category_id` → `categories.id` 为弱引用
- 删除分类前必须确保无关联物料

---

## 7. 交互细节

### 7.1 前端页面元素

| 元素 | 类型 | 说明 |
|------|------|------|
| 分类树组件 | Tree | 三级树形展示，可展开/折叠 |
| 物料数量标签 | Badge | 每个分类节点右侧显示 count |
| 新建分类按钮 | Button | admin 可见，支持选择父分类 |
| 编辑按钮 | Button | 行内/节点编辑 |
| 删除按钮 | Button | 叶子节点且 count=0 时可删除 |

### 7.2 表单校验规则

| 字段 | 前端校验 | 后端校验 |
|------|---------|---------|
| `name` | 非空，1-100 字符 | 非空 |
| `level` | 下拉选择 1/2/3 | 必须为 1/2/3 |
| `parentId` | level>1 时必填 | 无校验 |
| `code` | 只读（自动生成） | 自动生成 |

### 7.3 异常处理矩阵

| 异常场景 | HTTP 状态 | 错误码 | 前端处理 |
|---------|----------|--------|---------|
| name/level 为空 | 400 | `INVALID_PARAMETER` | 表单校验 |
| code 冲突 | 409 | `RESOURCE_CONFLICT` | Toast |
| 有子分类不可删 | 409 | `BUSINESS_RULE` | Dialog 提示 |
| 有关联物料不可删 | 409 | `BUSINESS_RULE` | Dialog 提示 |
| 分类不存在 | 404 | `NOT_FOUND` | Toast |

---

## 8. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| 获取分类树 | 200，完整三级树形，含 count 和 isLeaf |
| 搜索分类 | 200，返回匹配 name/code 的分类 |
| 创建一级分类 | 201，code 为 MAX+100（如 500） |
| 创建二级分类 | 201，code 为同 parent 下 MAX+1 |
| 创建三级分类 | 201，code 为同 parent 下 MAX+1 |
| 删除有子分类 | 409 "Has children" |
| 删除有关联物料 | 409 "Has materials" |
| 删除叶子空分类 | 200，逻辑删除 |
| 编辑分类名称 | 200，名称更新 |
| 非 admin 创建分类 | 403 Forbidden |

---

*文档版本: v1.1.0*  
*最后更新: 2026-05-12*
