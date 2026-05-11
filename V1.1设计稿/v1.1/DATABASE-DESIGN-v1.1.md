# COREONE 实验室耗材管理系统 数据库设计文档

**版本**: v1.1  
**创建日期**: 2026-04-23  
**作者**: 技术团队  
**数据库**: MySQL 8.0  
**字符集**: utf8mb4  
**关联文档**: TECH-SPEC-v1.1.md, API-DESIGN-v1.1.md

---

## 1. 数据库设计概述

### 1.1 设计原则

1. **第三范式 (3NF)**: 消除数据冗余，确保数据一致性
2. **适当反规范化**: 在报表等读多写少场景，适当冗余以提高查询效率
3. **软删除**: 所有表使用`is_deleted`字段实现软删除，保留审计轨迹
4. **审计字段**: 所有表包含`created_at`, `updated_at`, `created_by`, `updated_by`
5. **外键约束**: 核心业务表使用外键保证引用完整性

### 1.2 实体关系图 (ER Diagram)

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    物料分类体系                                           │
│  ┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐        │
│  │ material_cats    │         │ material_cats    │         │ material_cats    │        │
│  │ (一级分类)        │◀───────▶│ (二级分类)        │◀───────▶│ (三级分类)        │        │
│  │ id, name         │   1:N   │ id, parent_id    │   1:N   │ id, parent_id    │        │
│  └──────────────────┘         └──────────────────┘         └────────┬─────────┘        │
│                                                                     │                   │
│                                                                     │ 1:N               │
│                                                                     ▼                   │
│                                                            ┌──────────────────┐         │
│                                                            │ materials        │         │
│                                                            │ (物料主数据)      │         │
│                                                            └────────┬─────────┘         │
│                                                                     │                   │
└─────────────────────────────────────────────────────────────────────┼───────────────────┘
                                                                      │
                              ┌───────────────────────────────────────┼───────────────────┐
                              │                                       │                   │
                              ▼                                       ▼                   ▼
                     ┌──────────────────┐                  ┌──────────────────┐   ┌──────────────────┐
                     │ inventory        │                  │ batchs           │   │ suppliers        │
                     │ (库存汇总)        │                  │ (批次管理)        │   │ (供应商)          │
                     │ material_id (FK) │                  │ material_id (FK) │   └──────────────────┘
                     │ stock            │                  │ quantity         │
                     └──────────────────┘                  │ expiry_date      │
                                                           └──────────────────┘
                                                                      │
                              ┌───────────────────────────────────────┴───────────────────┐
                              │                                                           │
                              ▼                                                           ▼
                     ┌──────────────────┐                  ┌──────────────────┐   ┌──────────────────┐
                     │ inbound_records  │                  │ outbound_records │   │ scrap_records    │
                     │ (入库记录)        │                  │ (出库记录)        │   │ (报废记录)        │
                     │ batch_id (FK)    │                  │ project_id (FK)  │   │ reason           │
                     └──────────────────┘                  └────────┬─────────┘   └──────────────────┘
                                                                    │
                                                                    │ N:1
                                                                    ▼
                                                           ┌──────────────────┐
                                                           │ projects         │
                                                           │ (检测项目)        │
                                                           │ bom_id (FK)      │
                                                           └────────┬─────────┘
                                                                    │
                                                                    │ 1:N
                                                                    ▼
                                                           ┌──────────────────┐
                                                           │ boms             │
                                                           │ (BOM清单)         │
                                                           └────────┬─────────┘
                                                                    │
                                                                    │ 1:N
                                                                    ▼
                                                           ┌──────────────────┐
                                                           │ bom_items        │
                                                           │ (BOM物料明细)     │
                                                           └──────────────────┘
```

---

## 2. 数据表设计

### 2.1 物料分类表 (material_categories)

三级分类体系，支持树形结构

```sql
CREATE TABLE `material_categories` (
  `id` VARCHAR(32) NOT NULL COMMENT '分类ID',
  `code` VARCHAR(64) NOT NULL COMMENT '分类编码',
  `name` VARCHAR(100) NOT NULL COMMENT '分类名称',
  `parent_id` VARCHAR(32) DEFAULT NULL COMMENT '父分类ID',
  `level` TINYINT NOT NULL COMMENT '层级(1:一级,2:二级,3:三级)',
  `sort_order` INT DEFAULT 0 COMMENT '排序',
  `status` TINYINT NOT NULL DEFAULT 1 COMMENT '状态(1:启用,0:禁用)',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `created_by` VARCHAR(64) DEFAULT NULL COMMENT '创建人',
  `updated_by` VARCHAR(64) DEFAULT NULL COMMENT '更新人',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '是否删除(0:否,1:是)',
  
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_cat_code` (`code`),
  KEY `idx_parent_id` (`parent_id`),
  KEY `idx_level_status` (`level`, `status`),
  
  CONSTRAINT `fk_cat_parent` FOREIGN KEY (`parent_id`) 
    REFERENCES `material_categories` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='物料分类表';
```

### 2.2 物料主数据表 (materials)

```sql
CREATE TABLE `materials` (
  `id` VARCHAR(32) NOT NULL COMMENT '物料ID',
  `code` VARCHAR(64) NOT NULL COMMENT '物料编码',
  `name` VARCHAR(200) NOT NULL COMMENT '物料名称',
  `spec` VARCHAR(200) DEFAULT NULL COMMENT '规格型号',
  `unit` VARCHAR(20) NOT NULL COMMENT '计量单位',
  `category_id` VARCHAR(32) NOT NULL COMMENT '所属分类ID',
  `supplier_id` VARCHAR(32) DEFAULT NULL COMMENT '默认供应商ID',
  `price` DECIMAL(18, 4) DEFAULT 0.0000 COMMENT '参考单价',
  `min_stock` INT DEFAULT 0 COMMENT '安全库存',
  `max_stock` INT DEFAULT 999999 COMMENT '最大库存',
  `safety_stock` INT DEFAULT 0 COMMENT '安全库存线',
  `location_id` VARCHAR(32) DEFAULT NULL COMMENT '默认库位',
  `status` TINYINT NOT NULL DEFAULT 1 COMMENT '状态(1:启用,0:禁用)',
  `remark` VARCHAR(500) DEFAULT NULL COMMENT '备注',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` VARCHAR(64) DEFAULT NULL,
  `updated_by` VARCHAR(64) DEFAULT NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_mat_code` (`code`),
  KEY `idx_category_id` (`category_id`),
  KEY `idx_supplier_id` (`supplier_id`),
  KEY `idx_status` (`status`),
  KEY `idx_name` (`name`),
  
  CONSTRAINT `fk_mat_category` FOREIGN KEY (`category_id`) 
    REFERENCES `material_categories` (`id`),
  CONSTRAINT `fk_mat_supplier` FOREIGN KEY (`supplier_id`) 
    REFERENCES `suppliers` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='物料主数据表';
```

### 2.3 供应商表 (suppliers)

```sql
CREATE TABLE `suppliers` (
  `id` VARCHAR(32) NOT NULL COMMENT '供应商ID',
  `code` VARCHAR(64) NOT NULL COMMENT '供应商编码',
  `name` VARCHAR(200) NOT NULL COMMENT '供应商名称',
  `contact` VARCHAR(100) DEFAULT NULL COMMENT '联系人',
  `phone` VARCHAR(20) DEFAULT NULL COMMENT '联系电话',
  `email` VARCHAR(100) DEFAULT NULL COMMENT '邮箱',
  `address` VARCHAR(500) DEFAULT NULL COMMENT '地址',
  `tax_no` VARCHAR(50) DEFAULT NULL COMMENT '税号',
  `bank_name` VARCHAR(200) DEFAULT NULL COMMENT '开户行',
  `bank_account` VARCHAR(50) DEFAULT NULL COMMENT '银行账号',
  `status` TINYINT NOT NULL DEFAULT 1 COMMENT '状态(1:启用,0:禁用)',
  `cooperation_count` INT DEFAULT 0 COMMENT '合作次数',
  `total_amount` DECIMAL(18, 4) DEFAULT 0.0000 COMMENT '累计采购金额',
  `rating` TINYINT DEFAULT 5 COMMENT '评级(1-5星)',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` VARCHAR(64) DEFAULT NULL,
  `updated_by` VARCHAR(64) DEFAULT NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sup_code` (`code`),
  KEY `idx_name` (`name`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='供应商表';
```

### 2.4 库位表 (locations)

```sql
CREATE TABLE `locations` (
  `id` VARCHAR(32) NOT NULL COMMENT '库位ID',
  `code` VARCHAR(64) NOT NULL COMMENT '库位编码',
  `name` VARCHAR(100) NOT NULL COMMENT '库位名称',
  `zone` VARCHAR(50) NOT NULL COMMENT '区域',
  `shelf` VARCHAR(50) DEFAULT NULL COMMENT '货架/层',
  `position` VARCHAR(50) DEFAULT NULL COMMENT '具体位置',
  `capacity` INT DEFAULT 999999 COMMENT '容量',
  `used` INT DEFAULT 0 COMMENT '已用容量',
  `status` TINYINT NOT NULL DEFAULT 1 COMMENT '状态(1:启用,0:禁用)',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` VARCHAR(64) DEFAULT NULL,
  `updated_by` VARCHAR(64) DEFAULT NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_loc_code` (`code`),
  KEY `idx_zone` (`zone`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='库位表';
```

### 2.5 库存汇总表 (inventory)

实时库存汇总，由入库/出库/盘点等操作更新

```sql
CREATE TABLE `inventory` (
  `id` VARCHAR(32) NOT NULL COMMENT '库存ID',
  `material_id` VARCHAR(32) NOT NULL COMMENT '物料ID',
  `stock` DECIMAL(18, 4) NOT NULL DEFAULT 0.0000 COMMENT '当前库存',
  `locked_stock` DECIMAL(18, 4) NOT NULL DEFAULT 0.0000 COMMENT '锁定库存',
  `available_stock` DECIMAL(18, 4) GENERATED ALWAYS AS ((`stock` - `locked_stock`)) STORED COMMENT '可用库存',
  `location_id` VARCHAR(32) DEFAULT NULL COMMENT '存放库位',
  `last_inbound_id` VARCHAR(32) DEFAULT NULL COMMENT '最后入库单ID',
  `last_inbound_date` DATE DEFAULT NULL COMMENT '最后入库日期',
  `last_outbound_id` VARCHAR(32) DEFAULT NULL COMMENT '最后出库单ID',
  `last_outbound_date` DATE DEFAULT NULL COMMENT '最后出库日期',
  `update_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_inv_material` (`material_id`),
  KEY `idx_location_id` (`location_id`),
  KEY `idx_stock` (`stock`),
  
  CONSTRAINT `fk_inv_material` FOREIGN KEY (`material_id`) 
    REFERENCES `materials` (`id`),
  CONSTRAINT `fk_inv_location` FOREIGN KEY (`location_id`) 
    REFERENCES `locations` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='库存汇总表';
```

### 2.6 批次表 (batches)

管理物料批次和有效期

```sql
CREATE TABLE `batches` (
  `id` VARCHAR(32) NOT NULL COMMENT '批次ID',
  `material_id` VARCHAR(32) NOT NULL COMMENT '物料ID',
  `batch_no` VARCHAR(100) NOT NULL COMMENT '批次号',
  `quantity` DECIMAL(18, 4) NOT NULL DEFAULT 0.0000 COMMENT '入库数量',
  `remaining` DECIMAL(18, 4) NOT NULL DEFAULT 0.0000 COMMENT '剩余数量',
  `production_date` DATE DEFAULT NULL COMMENT '生产日期',
  `expiry_date` DATE NOT NULL COMMENT '有效期至',
  `inbound_id` VARCHAR(32) NOT NULL COMMENT '入库单ID',
  `inbound_price` DECIMAL(18, 4) DEFAULT 0.0000 COMMENT '入库单价',
  `supplier_id` VARCHAR(32) DEFAULT NULL COMMENT '供应商ID',
  `status` TINYINT NOT NULL DEFAULT 1 COMMENT '状态(1:正常,0:用完,2:过期)',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_batch_material_no` (`material_id`, `batch_no`),
  KEY `idx_material_id` (`material_id`),
  KEY `idx_expiry_date` (`expiry_date`),
  KEY `idx_status` (`status`),
  
  CONSTRAINT `fk_batch_material` FOREIGN KEY (`material_id`) 
    REFERENCES `materials` (`id`),
  CONSTRAINT `fk_batch_supplier` FOREIGN KEY (`supplier_id`) 
    REFERENCES `suppliers` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='物料批次表';
```

### 2.7 入库记录表 (inbound_records)

```sql
CREATE TABLE `inbound_records` (
  `id` VARCHAR(32) NOT NULL COMMENT '入库ID',
  `inbound_no` VARCHAR(64) NOT NULL COMMENT '入库单号',
  `type` VARCHAR(20) NOT NULL COMMENT '入库类型(direct:直接入库,purchase:采购入库,return:退货入库)',
  `material_id` VARCHAR(32) NOT NULL COMMENT '物料ID',
  `batch_id` VARCHAR(32) DEFAULT NULL COMMENT '批次ID',
  `batch_no` VARCHAR(100) DEFAULT NULL COMMENT '批次号',
  `quantity` DECIMAL(18, 4) NOT NULL COMMENT '入库数量',
  `unit` VARCHAR(20) NOT NULL COMMENT '单位',
  `price` DECIMAL(18, 4) DEFAULT 0.0000 COMMENT '单价',
  `amount` DECIMAL(18, 4) GENERATED ALWAYS AS ((`quantity` * `price`)) STORED COMMENT '金额',
  `supplier_id` VARCHAR(32) DEFAULT NULL COMMENT '供应商ID',
  `location_id` VARCHAR(32) NOT NULL COMMENT '入库库位',
  `production_date` DATE DEFAULT NULL COMMENT '生产日期',
  `expiry_date` DATE DEFAULT NULL COMMENT '有效期至',
  `operator` VARCHAR(64) NOT NULL COMMENT '经办人',
  `status` VARCHAR(20) NOT NULL DEFAULT 'completed' COMMENT '状态(completed:完成,cancelled:取消)',
  `remark` VARCHAR(500) DEFAULT NULL COMMENT '备注',
  `cancel_reason` VARCHAR(500) DEFAULT NULL COMMENT '取消原因',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` VARCHAR(64) DEFAULT NULL,
  `updated_by` VARCHAR(64) DEFAULT NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_inbound_no` (`inbound_no`),
  KEY `idx_material_id` (`material_id`),
  KEY `idx_supplier_id` (`supplier_id`),
  KEY `idx_created_at` (`created_at`),
  KEY `idx_status` (`status`),
  
  CONSTRAINT `fk_inbound_material` FOREIGN KEY (`material_id`) 
    REFERENCES `materials` (`id`),
  CONSTRAINT `fk_inbound_supplier` FOREIGN KEY (`supplier_id`) 
    REFERENCES `suppliers` (`id`),
  CONSTRAINT `fk_inbound_location` FOREIGN KEY (`location_id`) 
    REFERENCES `locations` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='入库记录表';
```

### 2.8 出库记录表 (outbound_records)

```sql
CREATE TABLE `outbound_records` (
  `id` VARCHAR(32) NOT NULL COMMENT '出库ID',
  `outbound_no` VARCHAR(64) NOT NULL COMMENT '出库单号',
  `type` VARCHAR(20) NOT NULL COMMENT '出库类型(project:项目领用,transfer:调拨,scrap:报废)',
  `project_id` VARCHAR(32) DEFAULT NULL COMMENT '关联项目ID',
  `total_cost` DECIMAL(18, 4) NOT NULL DEFAULT 0.0000 COMMENT '总成本',
  `operator` VARCHAR(64) NOT NULL COMMENT '经办人',
  `approver` VARCHAR(64) DEFAULT NULL COMMENT '审批人',
  `approved_at` DATETIME DEFAULT NULL COMMENT '审批时间',
  `status` VARCHAR(20) NOT NULL DEFAULT 'completed' COMMENT '状态',
  `remark` VARCHAR(500) DEFAULT NULL COMMENT '备注',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` VARCHAR(64) DEFAULT NULL,
  `updated_by` VARCHAR(64) DEFAULT NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_outbound_no` (`outbound_no`),
  KEY `idx_project_id` (`project_id`),
  KEY `idx_created_at` (`created_at`),
  KEY `idx_status` (`status`),
  
  CONSTRAINT `fk_outbound_project` FOREIGN KEY (`project_id`) 
    REFERENCES `projects` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='出库记录表';
```

### 2.9 出库明细表 (outbound_items)

```sql
CREATE TABLE `outbound_items` (
  `id` VARCHAR(32) NOT NULL COMMENT '明细ID',
  `outbound_id` VARCHAR(32) NOT NULL COMMENT '出库单ID',
  `material_id` VARCHAR(32) NOT NULL COMMENT '物料ID',
  `batch_id` VARCHAR(32) DEFAULT NULL COMMENT '批次ID',
  `batch_no` VARCHAR(100) DEFAULT NULL COMMENT '批次号',
  `quantity` DECIMAL(18, 4) NOT NULL COMMENT '出库数量',
  `unit` VARCHAR(20) NOT NULL COMMENT '单位',
  `unit_cost` DECIMAL(18, 4) NOT NULL COMMENT '单位成本',
  `total_cost` DECIMAL(18, 4) GENERATED ALWAYS AS ((`quantity` * `unit_cost`)) STORED COMMENT '总成本',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  PRIMARY KEY (`id`),
  KEY `idx_outbound_id` (`outbound_id`),
  KEY `idx_material_id` (`material_id`),
  
  CONSTRAINT `fk_item_outbound` FOREIGN KEY (`outbound_id`) 
    REFERENCES `outbound_records` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_item_material` FOREIGN KEY (`material_id`) 
    REFERENCES `materials` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='出库明细表';
```

### 2.10 检测项目表 (projects)

```sql
CREATE TABLE `projects` (
  `id` VARCHAR(32) NOT NULL COMMENT '项目ID',
  `code` VARCHAR(64) NOT NULL COMMENT '项目编码',
  `name` VARCHAR(200) NOT NULL COMMENT '项目名称',
  `type` VARCHAR(50) NOT NULL COMMENT '项目类型(he:HE制片,ihc:免疫组化,mp:分子病理等)',
  `cycle` VARCHAR(50) DEFAULT NULL COMMENT '检测周期',
  `bom_id` VARCHAR(32) DEFAULT NULL COMMENT '默认BOM ID',
  `supportable_samples` INT DEFAULT NULL COMMENT '理论支持样本数',
  `manager` VARCHAR(100) DEFAULT NULL COMMENT '项目负责人',
  `description` VARCHAR(1000) DEFAULT NULL COMMENT '项目描述',
  `status` TINYINT NOT NULL DEFAULT 1 COMMENT '状态(1:启用,0:禁用)',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` VARCHAR(64) DEFAULT NULL,
  `updated_by` VARCHAR(64) DEFAULT NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_prj_code` (`code`),
  KEY `idx_type` (`type`),
  KEY `idx_status` (`status`),
  KEY `idx_bom_id` (`bom_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='检测项目表';
```

### 2.11 BOM表 (boms)

```sql
CREATE TABLE `boms` (
  `id` VARCHAR(32) NOT NULL COMMENT 'BOM ID',
  `code` VARCHAR(64) NOT NULL COMMENT 'BOM编码',
  `name` VARCHAR(200) NOT NULL COMMENT 'BOM名称',
  `version` VARCHAR(20) NOT NULL DEFAULT 'v1.0' COMMENT '版本号',
  `type` VARCHAR(50) NOT NULL COMMENT 'BOM类型',
  `service_id` VARCHAR(32) DEFAULT NULL COMMENT '关联项目ID',
  `description` VARCHAR(500) DEFAULT NULL COMMENT '描述',
  `supportable_samples` INT DEFAULT NULL COMMENT '理论支持样本数',
  `unit_cost` DECIMAL(18, 4) DEFAULT 0.0000 COMMENT '单样本成本',
  `status` TINYINT NOT NULL DEFAULT 1 COMMENT '状态(1:启用,0:禁用)',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` VARCHAR(64) DEFAULT NULL,
  `updated_by` VARCHAR(64) DEFAULT NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_bom_code_ver` (`code`, `version`),
  KEY `idx_service_id` (`service_id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='BOM表';
```

### 2.12 BOM物料明细表 (bom_items)

```sql
CREATE TABLE `bom_items` (
  `id` VARCHAR(32) NOT NULL COMMENT '明细ID',
  `bom_id` VARCHAR(32) NOT NULL COMMENT 'BOM ID',
  `material_id` VARCHAR(32) NOT NULL COMMENT '物料ID',
  `usage_per_sample` DECIMAL(18, 4) NOT NULL COMMENT '单样本用量',
  `unit` VARCHAR(20) NOT NULL COMMENT '用量单位',
  `is_alternative` TINYINT NOT NULL DEFAULT 0 COMMENT '是否替代物料(0:否,1:是)',
  `main_item_id` VARCHAR(32) DEFAULT NULL COMMENT '主物料ID(替代物料时填写)',
  `sort_order` INT DEFAULT 0 COMMENT '排序',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_bom_material` (`bom_id`, `material_id`),
  KEY `idx_bom_id` (`bom_id`),
  KEY `idx_material_id` (`material_id`),
  
  CONSTRAINT `fk_item_bom` FOREIGN KEY (`bom_id`) 
    REFERENCES `boms` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_bom_item_material` FOREIGN KEY (`material_id`) 
    REFERENCES `materials` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='BOM物料明细表';
```

### 2.13 库存流水表 (stock_logs)

记录所有库存变动历史

```sql
CREATE TABLE `stock_logs` (
  `id` VARCHAR(32) NOT NULL COMMENT '流水ID',
  `type` VARCHAR(20) NOT NULL COMMENT '变动类型(inbound:入库,outbound:出库,scrap:报废,adjust:调整)',
  `material_id` VARCHAR(32) NOT NULL COMMENT '物料ID',
  `quantity` DECIMAL(18, 4) NOT NULL COMMENT '变动数量(正数增加,负数减少)',
  `before_stock` DECIMAL(18, 4) NOT NULL COMMENT '变动前库存',
  `after_stock` DECIMAL(18, 4) NOT NULL COMMENT '变动后库存',
  `related_id` VARCHAR(32) DEFAULT NULL COMMENT '关联单据ID',
  `related_type` VARCHAR(50) DEFAULT NULL COMMENT '关联单据类型',
  `operator` VARCHAR(64) NOT NULL COMMENT '操作人',
  `remark` VARCHAR(500) DEFAULT NULL COMMENT '备注',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  PRIMARY KEY (`id`),
  KEY `idx_material_id` (`material_id`),
  KEY `idx_type` (`type`),
  KEY `idx_created_at` (`created_at`),
  KEY `idx_related` (`related_type`, `related_id`),
  
  CONSTRAINT `fk_log_material` FOREIGN KEY (`material_id`) 
    REFERENCES `materials` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='库存流水表';
```

---

## 3. 索引设计汇总

| 表名 | 索引名 | 类型 | 字段 | 说明 |
|------|--------|------|------|------|
| material_categories | uk_cat_code | UNIQUE | code | 分类编码唯一 |
| material_categories | idx_parent_id | INDEX | parent_id | 父分类查询 |
| materials | uk_mat_code | UNIQUE | code | 物料编码唯一 |
| materials | idx_category_id | INDEX | category_id | 分类查询 |
| materials | idx_supplier_id | INDEX | supplier_id | 供应商查询 |
| suppliers | uk_sup_code | UNIQUE | code | 供应商编码唯一 |
| inventory | uk_inv_material | UNIQUE | material_id | 物料库存唯一 |
| inventory | idx_location_id | INDEX | location_id | 库位查询 |
| batches | uk_batch_material_no | UNIQUE | material_id, batch_no | 物料批次唯一 |
| batches | idx_expiry_date | INDEX | expiry_date | 有效期预警 |
| inbound_records | uk_inbound_no | UNIQUE | inbound_no | 入库单号唯一 |
| inbound_records | idx_material_id | INDEX | material_id | 物料入库查询 |
| inbound_records | idx_created_at | INDEX | created_at | 时间范围查询 |
| outbound_records | uk_outbound_no | UNIQUE | outbound_no | 出库单号唯一 |
| outbound_records | idx_project_id | INDEX | project_id | 项目成本归集 |
| outbound_records | idx_created_at | INDEX | created_at | 时间范围查询 |
| outbound_items | idx_outbound_id | INDEX | outbound_id | 出库单明细查询 |
| outbound_items | idx_material_id | INDEX | material_id | 物料出库统计 |
| stock_logs | idx_material_id | INDEX | material_id | 物料流水查询 |
| stock_logs | idx_created_at | INDEX | created_at | 时间范围查询 |

---

## 4. 数据字典

### 4.1 枚举值定义

**物料状态 (materials.status)**:
- `1`: 启用
- `0`: 禁用

**入库类型 (inbound_records.type)**:
- `direct`: 直接入库
- `purchase`: 采购入库
- `return`: 退货入库

**出库类型 (outbound_records.type)**:
- `project`: 项目领用
- `transfer`: 调拨
- `scrap`: 报废出库

**项目类型 (projects.type)**:
- `he`: HE制片
- `ihc`: 免疫组化
- `ss`: 特殊染色
- `mp`: 分子病理
- `cyto`: 细胞学检查

**批次状态 (batches.status)**:
- `1`: 正常
- `0`: 已用完
- `2`: 已过期

### 4.2 计量单位

**库存单位**:
- 瓶、盒、包、支、套、把、个、片、卷
- kg、L、ml

**使用单位**:
- μl、ml、个、片、张、支、滴、mg、g

---

## 5. 数据归档策略

| 数据表 | 归档策略 | 保留期限 |
|--------|----------|----------|
| inbound_records | 按年归档 | 5年 |
| outbound_records | 按年归档 | 5年 |
| stock_logs | 按季度归档 | 3年 |
| operation_logs | 按季度归档 | 2年 |

---

## 6. 附录

### 6.1 变更记录

| 版本 | 日期 | 变更内容 | 变更人 |
|------|------|----------|--------|
| v1.0 | 2026-04-20 | 初始数据库设计 | Tech Lead |
| v1.1 | 2026-04-23 | 基于原型验证补充批次管理、库存流水表，统一版本号 | Tech Lead |

### 6.2 参考文档

- [TECH-SPEC-v1.1.md](./TECH-SPEC-v1.1.md) - 技术规范文档
- [API-DESIGN-v1.1.md](./API-DESIGN-v1.1.md) - API设计文档
