// mock-config.js
// COREONE v1.1 Mock 数据配置文件
// 生成日期: 2026-04-23
// 增强版本: 支持跨页面状态同步

export const mockData = {
    // ==================== 物料分类页面 ====================
    
    categories: [
        {
            id: 1,
            name: '试剂类',
            code: 'CAT-REAGENT',
            level: 1,
            count: 68,
            expanded: true,
            createdAt: '2024-01-15 09:30:00',
            updatedAt: '2024-03-20 14:22:00',
            children: [
                {
                    id: 11,
                    name: 'HE染色试剂',
                    code: 'CAT-REAGENT-HE',
                    level: 2,
                    parentId: 1,
                    count: 12,
                    expanded: true,
                    children: [
                        { id: 111, name: '苏木素染液', code: 'CAT-REAGENT-HE-001', level: 3, parentId: 11, count: 5 },
                        { id: 112, name: '伊红染液', code: 'CAT-REAGENT-HE-002', level: 3, parentId: 11, count: 4 },
                        { id: 113, name: '分化液/返蓝液', code: 'CAT-REAGENT-HE-003', level: 3, parentId: 11, count: 3 }
                    ]
                },
                {
                    id: 12,
                    name: '免疫组化试剂',
                    code: 'CAT-REAGENT-IHC',
                    level: 2,
                    parentId: 1,
                    count: 32,
                    expanded: false,
                    children: [
                        { id: 121, name: '一抗', code: 'CAT-REAGENT-IHC-001', level: 3, parentId: 12, count: 18 },
                        { id: 122, name: '二抗试剂盒', code: 'CAT-REAGENT-IHC-002', level: 3, parentId: 12, count: 8 },
                        { id: 123, name: 'DAB显色液', code: 'CAT-REAGENT-IHC-003', level: 3, parentId: 12, count: 6 }
                    ]
                },
                {
                    id: 13,
                    name: '特殊染色试剂',
                    code: 'CAT-REAGENT-SS',
                    level: 2,
                    parentId: 1,
                    count: 12,
                    expanded: false,
                    children: [
                        { id: 131, name: 'PAS染色试剂', code: 'CAT-REAGENT-SS-001', level: 3, parentId: 13, count: 4 },
                        { id: 132, name: '抗酸染色试剂', code: 'CAT-REAGENT-SS-002', level: 3, parentId: 13, count: 5 }
                    ]
                },
                {
                    id: 14,
                    name: '分子检测试剂',
                    code: 'CAT-REAGENT-MP',
                    level: 2,
                    parentId: 1,
                    count: 12,
                    expanded: false,
                    children: [
                        { id: 141, name: 'DNA提取试剂', code: 'CAT-REAGENT-MP-001', level: 3, parentId: 14, count: 4 },
                        { id: 142, name: 'PCR试剂', code: 'CAT-REAGENT-MP-002', level: 3, parentId: 14, count: 5 }
                    ]
                }
            ]
        },
        {
            id: 2,
            name: '耗材类',
            code: 'CAT-CONSUMABLE',
            level: 1,
            count: 62,
            expanded: false,
            createdAt: '2024-01-15 09:35:00',
            updatedAt: '2024-02-28 11:15:00',
            children: [
                { id: 21, name: '制片耗材', code: 'CAT-CONSUMABLE-SLIDE', level: 2, parentId: 2, count: 28 },
                { id: 22, name: '染色耗材', code: 'CAT-CONSUMABLE-STAIN', level: 2, parentId: 2, count: 18 },
                { id: 23, name: '包装耗材', code: 'CAT-CONSUMABLE-PACK', level: 2, parentId: 2, count: 16 }
            ]
        },
        {
            id: 3,
            name: '设备配件类',
            code: 'CAT-EQUIPMENT',
            level: 1,
            count: 26,
            expanded: false,
            createdAt: '2024-01-20 10:00:00',
            updatedAt: '2024-03-15 16:45:00',
            children: [
                { id: 31, name: '切片机配件', code: 'CAT-EQUIPMENT-MICROTOME', level: 2, parentId: 3, count: 12 },
                { id: 32, name: '染色机配件', code: 'CAT-EQUIPMENT-STAINER', level: 2, parentId: 3, count: 8 },
                { id: 33, name: '其他设备配件', code: 'CAT-EQUIPMENT-OTHER', level: 2, parentId: 3, count: 6 }
            ]
        }
    ],

    materials: {
        111: [
            { id: 'MAT-001', code: 'MAT-001', name: 'Harris苏木素染液', spec: '500ml/瓶', unit: '瓶', price: 168.00, priceDisplay: '¥168.00', stock: 24, location: 'A区-3-101', supplier: '北京病理科技', status: 'active' },
            { id: 'MAT-002', code: 'MAT-002', name: 'Gill苏木素染液', spec: '500ml/瓶', unit: '瓶', price: 185.00, priceDisplay: '¥185.00', stock: 12, location: 'A区-3-102', supplier: '上海生化试剂', status: 'active' },
            { id: 'MAT-003', code: 'MAT-003', name: 'Mayer苏木素染液', spec: '500ml/瓶', unit: '瓶', price: 145.00, priceDisplay: '¥145.00', stock: 18, location: 'A区-3-103', supplier: '广州医学材料', status: 'active' },
            { id: 'MAT-004', code: 'MAT-004', name: '改良苏木素染液', spec: '250ml/瓶', unit: '瓶', price: 98.00, priceDisplay: '¥98.00', stock: 30, location: 'A区-3-104', supplier: '北京病理科技', status: 'active' },
            { id: 'MAT-005', code: 'MAT-005', name: '铁苏木素染液', spec: '100ml/瓶', unit: '瓶', price: 128.00, priceDisplay: '¥128.00', stock: 8, location: 'A区-3-105', supplier: '上海生化试剂', status: 'active' }
        ],
        112: [
            { id: 'MAT-011', code: 'MAT-011', name: '伊红Y染液', spec: '500ml/瓶', unit: '瓶', price: 85.00, priceDisplay: '¥85.00', stock: 36, location: 'A区-3-201', supplier: '北京病理科技', status: 'active' },
            { id: 'MAT-012', code: 'MAT-012', name: '醇溶性伊红', spec: '500ml/瓶', unit: '瓶', price: 92.00, priceDisplay: '¥92.00', stock: 24, location: 'A区-3-202', supplier: '上海生化试剂', status: 'active' },
            { id: 'MAT-013', code: 'MAT-013', name: '水溶性伊红', spec: '500ml/瓶', unit: '瓶', price: 78.00, priceDisplay: '¥78.00', stock: 20, location: 'A区-3-203', supplier: '广州医学材料', status: 'active' },
            { id: 'MAT-014', code: 'MAT-014', name: '伊红醇溶液', spec: '250ml/瓶', unit: '瓶', price: 58.00, priceDisplay: '¥58.00', stock: 28, location: 'A区-3-204', supplier: '北京病理科技', status: 'active' }
        ],
        113: [
            { id: 'MAT-021', code: 'MAT-021', name: '盐酸酒精分化液', spec: '500ml/瓶', unit: '瓶', price: 45.00, priceDisplay: '¥45.00', stock: 42, location: 'A区-3-301', supplier: '北京病理科技', status: 'active' },
            { id: 'MAT-022', code: 'MAT-022', name: '氨水返蓝液', spec: '500ml/瓶', unit: '瓶', price: 38.00, priceDisplay: '¥38.00', stock: 35, location: 'A区-3-302', supplier: '上海生化试剂', status: 'active' },
            { id: 'MAT-023', code: 'MAT-023', name: 'Scott返蓝液', spec: '500ml/瓶', unit: '瓶', price: 52.00, priceDisplay: '¥52.00', stock: 18, location: 'A区-3-303', supplier: '广州医学材料', status: 'active' }
        ],
        121: [
            { id: 'MAT-101', code: 'MAT-101', name: 'Ki-67抗体', spec: '1ml/支', unit: '支', price: 680.00, priceDisplay: '¥680.00', stock: 15, location: 'B区-1-101', supplier: 'DAKO', status: 'active' },
            { id: 'MAT-102', code: 'MAT-102', name: 'P53抗体', spec: '1ml/支', unit: '支', price: 520.00, priceDisplay: '¥520.00', stock: 12, location: 'B区-1-102', supplier: 'DAKO', status: 'active' },
            { id: 'MAT-103', code: 'MAT-103', name: 'ER抗体', spec: '1ml/支', unit: '支', price: 450.00, priceDisplay: '¥450.00', stock: 18, location: 'B区-1-103', supplier: '罗氏诊断', status: 'active' },
            { id: 'MAT-104', code: 'MAT-104', name: 'PR抗体', spec: '1ml/支', unit: '支', price: 450.00, priceDisplay: '¥450.00', stock: 16, location: 'B区-1-104', supplier: '罗氏诊断', status: 'active' }
        ],
        // ==================== 验收测试专用物料分类 ====================
        143: [
            { id: 'MAT-TEST-001', code: 'MAT-TEST-001', name: '验收测试试剂盒', spec: '10次/盒', unit: '盒', price: 506.67, priceDisplay: '¥506.67', stock: 15, location: 'D区-1-001', supplier: '云深生物', status: 'active' }
        ]
    },

    categoryStats: {
        level1Count: 3,
        level2Count: 10,
        level3Count: 15,
        totalMaterials: 156,
        activeCategories: 28
    },

    consumables: [
        {
            id: 'CON-2024-001',
            code: 'CON-2024-001',
            name: 'PCR试剂盒',
            categoryId: '121',
            categoryPath: '试剂类 > 免疫组化试剂 > 一抗',
            spec: '96孔/盒',
            unit: '盒',
            supplier: '赛默飞世尔',
            supplierId: 'SUP-001',
            price: 1280.00,
            priceDisplay: '¥1,280.00',
            usage: 10,
            usageUnit: 'μl',
            status: 'active',
            statusDisplay: '已启用',
            minStock: 5,
            maxStock: 50,
            safetyStock: 10,
            createdAt: '2024-01-10 09:00:00',
            updatedAt: '2024-03-15 14:30:00',
            remark: '用于PCR扩增实验'
        },
        {
            id: 'CON-2024-002',
            code: 'CON-2024-002',
            name: '离心管',
            categoryId: '21',
            categoryPath: '耗材类 > 制片耗材',
            spec: '1.5ml',
            unit: '包',
            supplier: '艾本德',
            supplierId: 'SUP-002',
            price: 45.00,
            priceDisplay: '¥45.00',
            usage: 10,
            usageUnit: '支',
            status: 'active',
            statusDisplay: '已启用',
            minStock: 20,
            maxStock: 200,
            safetyStock: 50,
            createdAt: '2024-01-12 10:30:00',
            updatedAt: '2024-02-28 11:20:00',
            remark: '常用实验耗材'
        },
        {
            id: 'CON-2024-003',
            code: 'CON-2024-003',
            name: '移液器吸头',
            categoryId: '22',
            categoryPath: '耗材类 > 染色耗材',
            spec: '200μl',
            unit: '盒',
            supplier: '赛多利斯',
            supplierId: 'SUP-003',
            price: 68.00,
            priceDisplay: '¥68.00',
            usage: 20,
            usageUnit: '个',
            status: 'active',
            statusDisplay: '已启用',
            minStock: 10,
            maxStock: 100,
            safetyStock: 30,
            createdAt: '2024-01-15 14:00:00',
            updatedAt: '2024-03-10 09:45:00',
            remark: '配合移液器使用'
        }
    ],

    consumableCategories: [
        { value: 'reagent', label: '试剂', color: 'primary' },
        { value: 'consumable', label: '耗材', color: 'secondary' },
        { value: 'equipment', label: '设备配件', color: 'info' }
    ],

    categoryTree: {
        '1': {
            id: '1',
            name: '试剂类',
            children: {
                '11': { id: '11', name: 'HE染色试剂', children: {
                    '111': { id: '111', name: '苏木素染液', isLeaf: true },
                    '112': { id: '112', name: '伊红染液', isLeaf: true },
                    '113': { id: '113', name: '分化液/返蓝液', isLeaf: true }
                }},
                '12': { id: '12', name: '免疫组化试剂', children: {
                    '121': { id: '121', name: '一抗', isLeaf: true },
                    '122': { id: '122', name: '二抗试剂盒', isLeaf: true },
                    '123': { id: '123', name: 'DAB显色液', isLeaf: true }
                }},
                '13': { id: '13', name: '特殊染色试剂', children: {
                    '131': { id: '131', name: 'PAS染色试剂', isLeaf: true },
                    '132': { id: '132', name: '抗酸染色试剂', isLeaf: true }
                }},
                '14': { id: '14', name: '分子检测试剂', children: {
                    '141': { id: '141', name: 'DNA提取试剂', isLeaf: true },
                    '142': { id: '142', name: 'PCR试剂', isLeaf: true }
                }}
            }
        },
        '2': {
            id: '2',
            name: '耗材类',
            children: {
                '21': { id: '21', name: '制片耗材', isLeaf: true },
                '22': { id: '22', name: '染色耗材', isLeaf: true },
                '23': { id: '23', name: '包装耗材', isLeaf: true }
            }
        },
        '3': {
            id: '3',
            name: '设备配件类',
            children: {
                '31': { id: '31', name: '切片机配件', isLeaf: true },
                '32': { id: '32', name: '染色机配件', isLeaf: true },
                '33': { id: '33', name: '其他设备配件', isLeaf: true }
            }
        }
    },

    categoryMap: {
        '1': { name: '试剂类', path: '试剂类', type: 'reagent' },
        '11': { name: 'HE染色试剂', path: '试剂类 > HE染色试剂', type: 'reagent' },
        '111': { name: '苏木素染液', path: '试剂类 > HE染色试剂 > 苏木素染液', type: 'reagent' },
        '112': { name: '伊红染液', path: '试剂类 > HE染色试剂 > 伊红染液', type: 'reagent' },
        '113': { name: '分化液/返蓝液', path: '试剂类 > HE染色试剂 > 分化液/返蓝液', type: 'reagent' },
        '12': { name: '免疫组化试剂', path: '试剂类 > 免疫组化试剂', type: 'reagent' },
        '121': { name: '一抗', path: '试剂类 > 免疫组化试剂 > 一抗', type: 'reagent' },
        '2': { name: '耗材类', path: '耗材类', type: 'consumable' },
        '21': { name: '制片耗材', path: '耗材类 > 制片耗材', type: 'consumable' },
        '3': { name: '设备配件类', path: '设备配件类', type: 'equipment' }
    },

    consumableStatuses: [
        { value: 'active', label: '已启用', color: 'success' },
        { value: 'inactive', label: '已停用', color: 'warning' }
    ],

    suppliers: [
        { id: 'SUP-001', name: '赛默飞世尔', contact: '张经理', phone: '400-888-1234', address: '上海市浦东新区', status: 'active' },
        { id: 'SUP-002', name: '艾本德', contact: '李经理', phone: '400-888-2345', address: '北京市朝阳区', status: 'active' },
        { id: 'SUP-003', name: '赛多利斯', contact: '王经理', phone: '400-888-3456', address: '广州市天河区', status: 'active' },
        { id: 'SUP-004', name: '康宁', contact: '赵经理', phone: '400-888-4567', address: '上海市闵行区', status: 'active' },
        { id: 'SUP-005', name: '徕卡', contact: '刘经理', phone: '400-888-5678', address: '北京市海淀区', status: 'active' },
        { id: 'SUP-006', name: '北京病理科技', contact: '孙经理', phone: '010-12345678', address: '北京市昌平区', status: 'active' },
        { id: 'SUP-007', name: 'DAKO', contact: '陈经理', phone: '400-888-6789', address: '上海市徐汇区', status: 'active' },
        { id: 'SUP-008', name: '罗氏诊断', contact: '周经理', phone: '400-888-7890', address: '上海市静安区', status: 'active' },
        { id: 'SUP-009', name: '达安基因', contact: '吴经理', phone: '400-888-8901', address: '广州市黄埔区', status: 'active' },
        { id: 'SUP-010', name: '华大基因', contact: '郑经理', phone: '400-888-9012', address: '深圳市南山区', status: 'active' },
        // ==================== 验收测试专用供应商 ====================
        { id: 'SUP-TEST-001', name: '云深生物', contact: '赵经理', phone: '400-999-8888', address: '深圳市南山区科技园', status: 'active' }
    ],

    locations: [
        { id: 'LOC-001', name: 'A区-3-101', zone: 'A区', shelf: '3层', position: '101', status: 'active' },
        { id: 'LOC-002', name: 'A区-3-102', zone: 'A区', shelf: '3层', position: '102', status: 'active' },
        { id: 'LOC-003', name: 'A区-3-103', zone: 'A区', shelf: '3层', position: '103', status: 'active' },
        { id: 'LOC-004', name: 'B区-1-101', zone: 'B区', shelf: '1层', position: '101', status: 'active' },
        { id: 'LOC-005', name: 'B区-1-102', zone: 'B区', shelf: '1层', position: '102', status: 'active' },
        { id: 'LOC-006', name: 'C区-2-201', zone: 'C区', shelf: '2层', position: '201', status: 'active' }
    ],

    units: [
        { value: '盒', label: '盒' },
        { value: '瓶', label: '瓶' },
        { value: '包', label: '包' },
        { value: '支', label: '支' },
        { value: '套', label: '套' },
        { value: '把', label: '把' },
        { value: '个', label: '个' },
        { value: '片', label: '片' },
        { value: '卷', label: '卷' },
        { value: 'kg', label: '千克' },
        { value: 'L', label: '升' },
        { value: 'ml', label: '毫升' }
    ],

    usageUnits: [
        { value: 'μl', label: 'μl' },
        { value: 'ml', label: 'ml' },
        { value: '个', label: '个' },
        { value: '片', label: '片' },
        { value: '张', label: '张' },
        { value: '支', label: '支' },
        { value: '滴', label: '滴' },
        { value: 'mg', label: 'mg' },
        { value: 'g', label: 'g' }
    ],

    leafCategories: [
        { id: '111', name: '苏木素染液', path: '试剂类 > HE染色试剂 > 苏木素染液', type: 'reagent' },
        { id: '112', name: '伊红染液', path: '试剂类 > HE染色试剂 > 伊红染液', type: 'reagent' },
        { id: '113', name: '分化液/返蓝液', path: '试剂类 > HE染色试剂 > 分化液/返蓝液', type: 'reagent' },
        { id: '121', name: '一抗', path: '试剂类 > 免疫组化试剂 > 一抗', type: 'reagent' },
        { id: '122', name: '二抗试剂盒', path: '试剂类 > 免疫组化试剂 > 二抗试剂盒', type: 'reagent' },
        { id: '123', name: 'DAB显色液', path: '试剂类 > 免疫组化试剂 > DAB显色液', type: 'reagent' },
        { id: '131', name: 'PAS染色试剂', path: '试剂类 > 特殊染色试剂 > PAS染色试剂', type: 'reagent' },
        { id: '132', name: '抗酸染色试剂', path: '试剂类 > 特殊染色试剂 > 抗酸染色试剂', type: 'reagent' },
        { id: '141', name: 'DNA提取试剂', path: '试剂类 > 分子检测试剂 > DNA提取试剂', type: 'reagent' },
        { id: '142', name: 'PCR试剂', path: '试剂类 > 分子检测试剂 > PCR试剂', type: 'reagent' },
        { id: '21', name: '制片耗材', path: '耗材类 > 制片耗材', type: 'consumable' },
        { id: '22', name: '染色耗材', path: '耗材类 > 染色耗材', type: 'consumable' },
        { id: '23', name: '包装耗材', path: '耗材类 > 包装耗材', type: 'consumable' },
        { id: '31', name: '切片机配件', path: '设备配件类 > 切片机配件', type: 'equipment' },
        { id: '32', name: '染色机配件', path: '设备配件类 > 染色机配件', type: 'equipment' },
        { id: '33', name: '其他设备配件', path: '设备配件类 > 其他设备配件', type: 'equipment' }
    ],

    // ==================== 检测服务数据 ====================
    projects: [
        { id: 'HE-001', code: 'HE-001', name: 'HE常规制片', type: 'he', typeName: '病理技术', cycle: '1-2个工作日', bomId: 'BOM-001', bomName: 'HE制片标准套装', bomVersion: 'v2.3', supportableSamples: 150, status: 'active', manager: '张医生', description: '常规HE染色制片，包括取材、包埋、切片、染色、封片全流程。' },
        { id: 'HE-002', code: 'HE-002', name: '快速冰冻切片', type: 'he', typeName: '病理技术', cycle: '30分钟', bomId: 'BOM-002', bomName: '冰冻切片套装', bomVersion: 'v1.8', supportableSamples: 25, status: 'active', manager: '李医生', description: '术中快速冰冻切片诊断' },
        { id: 'IHC-KI67', code: 'IHC-KI67', name: 'Ki-67免疫组化染色', type: 'ihc', typeName: '病理技术', cycle: '1-2个工作日', bomId: 'BOM-003', bomName: '免疫组化标准套装', bomVersion: 'v1.5', supportableSamples: 120, status: 'active', manager: '张医生', description: 'Ki-67增殖指数检测' },
        { id: 'IHC-ER', code: 'IHC-ER', name: 'ER雌激素受体检测', type: 'ihc', typeName: '病理技术', cycle: '1-2个工作日', bomId: 'BOM-003', bomName: '免疫组化标准套装', bomVersion: 'v1.5', supportableSamples: 120, status: 'active', manager: '李医生', description: '雌激素受体免疫组化检测' },
        { id: 'IHC-PR', code: 'IHC-PR', name: 'PR孕激素受体检测', type: 'ihc', typeName: '病理技术', cycle: '1-2个工作日', bomId: 'BOM-003', bomName: '免疫组化标准套装', bomVersion: 'v1.5', supportableSamples: 120, status: 'active', manager: '张医生', description: '孕激素受体免疫组化检测' },
        { id: 'IHC-HER2', code: 'IHC-HER2', name: 'HER2/neu检测', type: 'ihc', typeName: '病理技术', cycle: '1-2个工作日', bomId: 'BOM-004', bomName: 'HER2检测套装', bomVersion: 'v2.0', supportableSamples: 85, status: 'active', manager: '王医生', description: 'HER2/neu蛋白表达检测' },
        { id: 'MP-EGFR', code: 'MP-EGFR', name: 'EGFR基因突变检测', type: 'mp', typeName: '分子诊断', cycle: '5-7个工作日', bomId: 'BOM-005', bomName: '分子检测标准套装', bomVersion: 'v3.0', supportableSamples: 5, status: 'active', manager: '王医生', description: 'EGFR基因突变检测' },
        { id: 'MP-NGS', code: 'MP-NGS', name: 'NGS高通量测序', type: 'mp', typeName: '分子诊断', cycle: '10-15个工作日', bomId: 'BOM-006', bomName: 'NGS建库试剂套装', bomVersion: 'v2.3', supportableSamples: 80, status: 'active', manager: '王医生', description: '高通量测序检测' },
        { id: 'MP-FISH', code: 'MP-FISH', name: 'FISH荧光原位杂交', type: 'mp', typeName: '分子诊断', cycle: '3-5个工作日', bomId: null, bomName: null, bomVersion: null, supportableSamples: null, status: 'inactive', manager: '王医生', description: '荧光原位杂交检测' },
        { id: 'SS-GRAM', code: 'SS-GRAM', name: '革兰氏染色', type: 'ss', typeName: '病理技术', cycle: '1个工作日', bomId: 'BOM-007', bomName: '细菌染色套装', bomVersion: 'v1.2', supportableSamples: 250, status: 'active', manager: '李医生', description: '细菌革兰氏染色' },
        { id: 'CYTO-TCT', code: 'CYTO-TCT', name: '液基薄层细胞学检查(TCT)', type: 'cyto', typeName: '病理诊断', cycle: '2-3个工作日', bomId: 'BOM-008', bomName: '液基细胞学套装', bomVersion: 'v2.0', supportableSamples: 200, status: 'active', manager: '张医生', description: '液基薄层细胞学检查' }
    ],

    projectTypes: [
        { value: 'he', label: '病理技术-HE制片', color: 'primary' },
        { value: 'ihc', label: '病理技术-免疫组化', color: 'success' },
        { value: 'ss', label: '病理技术-特殊染色', color: 'warning' },
        { value: 'mp', label: '分子诊断', color: 'purple' },
        { value: 'cyto', label: '病理诊断-细胞学检查', color: 'teal' }
    ],

    // ==================== BOM清单数据 ====================
    boms: [
        { 
            id: 'BOM-001', 
            code: 'BOM-001', 
            name: 'HE制片标准套装', 
            description: '常规HE染色制片物料',
            type: 'HE制片',
            serviceId: 'HE-001',
            serviceName: 'HE常规制片',
            version: 'v2.3',
            materialCount: 8,
            supportableSamples: 150,
            materialStatus: 'sufficient',
            unitCost: 12.50,
            status: 'active',
            createdAt: '2024-01-01 10:00',
            updatedAt: '2024-01-15 14:30',
            materials: [
                { id: 'MAT-001', name: '苏木精染液', spec: '500ml/瓶', usagePerSample: 0.5, unit: 'ml', stock: 120, stockStatus: 'sufficient' },
                { id: 'MAT-011', name: '伊红染液', spec: '500ml/瓶', usagePerSample: 0.3, unit: 'ml', stock: 85, stockStatus: 'sufficient' },
                { id: 'MAT-021', name: '分化液', spec: '500ml/瓶', usagePerSample: 0.2, unit: 'ml', stock: 30, stockStatus: 'low' },
                { id: 'MAT-022', name: '蓝化液', spec: '500ml/瓶', usagePerSample: 0.2, unit: 'ml', stock: 60, stockStatus: 'sufficient' },
                { id: 'MAT-030', name: '封片剂', spec: '100ml/瓶', usagePerSample: 0.1, unit: 'ml', stock: 45, stockStatus: 'sufficient' }
            ]
        },
        { 
            id: 'BOM-002', 
            code: 'BOM-002', 
            name: '冰冻切片套装', 
            description: '冰冻切片专用物料',
            type: 'HE制片',
            serviceId: 'HE-002',
            serviceName: '快速冰冻切片',
            version: 'v1.8',
            materialCount: 6,
            supportableSamples: 25,
            materialStatus: 'low',
            unitCost: 45.00,
            status: 'active',
            createdAt: '2024-01-05 09:00',
            updatedAt: '2024-01-12 16:30',
            materials: [
                { id: 'MAT-001', name: '苏木精染液', spec: '500ml/瓶', usagePerSample: 0.5, unit: 'ml', stock: 120, stockStatus: 'sufficient' },
                { id: 'MAT-011', name: '伊红染液', spec: '500ml/瓶', usagePerSample: 0.3, unit: 'ml', stock: 85, stockStatus: 'sufficient' }
            ]
        },
        { 
            id: 'BOM-003', 
            code: 'BOM-003', 
            name: '免疫组化标准套装', 
            description: 'IHC染色物料套装',
            type: '免疫组化',
            serviceId: 'IHC-KI67',
            serviceName: 'Ki-67免疫组化染色',
            version: 'v1.5',
            materialCount: 7,
            supportableSamples: 120,
            materialStatus: 'sufficient',
            unitCost: 35.00,
            status: 'active',
            createdAt: '2024-01-08 11:00',
            updatedAt: '2024-01-14 09:15',
            materials: [
                { id: 'MAT-101', name: 'Ki-67抗体', spec: '1ml/支', usagePerSample: 0.01, unit: 'ml', stock: 15, stockStatus: 'sufficient' },
                { id: 'MAT-102', name: 'P53抗体', spec: '1ml/支', usagePerSample: 0.01, unit: 'ml', stock: 12, stockStatus: 'sufficient' }
            ]
        },
        { 
            id: 'BOM-004', 
            code: 'BOM-004', 
            name: 'HER2检测套装', 
            description: 'HER2检测专用物料',
            type: '免疫组化',
            serviceId: 'IHC-HER2',
            serviceName: 'HER2/neu检测',
            version: 'v2.0',
            materialCount: 5,
            supportableSamples: 85,
            materialStatus: 'sufficient',
            unitCost: 68.00,
            status: 'active',
            createdAt: '2024-01-10 14:00',
            updatedAt: '2024-01-16 10:00',
            materials: []
        },
        { 
            id: 'BOM-005', 
            code: 'BOM-005', 
            name: '分子检测标准套装', 
            description: '基因检测物料套装',
            type: '分子检测',
            serviceId: 'MP-EGFR',
            serviceName: 'EGFR基因突变检测',
            version: 'v3.0',
            materialCount: 12,
            supportableSamples: 5,
            materialStatus: 'insufficient',
            unitCost: 185.00,
            status: 'active',
            createdAt: '2024-01-12 09:30',
            updatedAt: '2024-01-13 16:45',
            materials: []
        },
        { 
            id: 'BOM-006', 
            code: 'BOM-006', 
            name: 'NGS建库试剂套装', 
            description: 'NGS测序物料套装',
            type: '分子检测',
            serviceId: 'MP-NGS',
            serviceName: 'NGS高通量测序',
            version: 'v2.3',
            materialCount: 24,
            supportableSamples: 80,
            materialStatus: 'sufficient',
            unitCost: 320.00,
            status: 'active',
            createdAt: '2024-01-08 15:00',
            updatedAt: '2024-01-10 09:00',
            materials: []
        },
        { 
            id: 'BOM-007', 
            code: 'BOM-007', 
            name: '细菌染色套装', 
            description: '细菌染色物料',
            type: '特殊染色',
            serviceId: 'SS-GRAM',
            serviceName: '革兰氏染色',
            version: 'v1.2',
            materialCount: 4,
            supportableSamples: 250,
            materialStatus: 'sufficient',
            unitCost: 8.50,
            status: 'active',
            createdAt: '2024-01-15 10:00',
            updatedAt: '2024-01-18 14:00',
            materials: []
        },
        { 
            id: 'BOM-008', 
            code: 'BOM-008', 
            name: '液基细胞学套装', 
            description: '液基细胞学检查物料',
            type: '细胞学',
            serviceId: 'CYTO-TCT',
            serviceName: '液基薄层细胞学检查(TCT)',
            version: 'v2.0',
            materialCount: 6,
            supportableSamples: 200,
            materialStatus: 'sufficient',
            unitCost: 28.00,
            status: 'active',
            createdAt: '2024-01-06 11:00',
            updatedAt: '2024-01-14 15:30',
            materials: []
        }
    ],

    bomTypes: [
        { value: 'HE制片', label: 'HE制片' },
        { value: '免疫组化', label: '免疫组化' },
        { value: '特殊染色', label: '特殊染色' },
        { value: '分子检测', label: '分子检测' },
        { value: '细胞学', label: '细胞学' }
    ],

    // ==================== 成本分析数据 ====================
    costAnalysis: {
        summary: {
            totalCost: 1085000,
            projectCost: 1028000,
            publicCost: 57000,
            supplierCount: 12,
            longTermSupplierCount: 8
        },
        projectCosts: [
            { id: 'PRJ-001', name: '分子病理检测', category: 'molecular', sampleCount: 450, unitCost: 782.2, totalCost: 352000, ratio: 34.2, changeRate: 12, changeDirection: 'up' },
            { id: 'PRJ-002', name: 'HE制片', category: 'pathology-tech', sampleCount: 12450, unitCost: 22.9, totalCost: 285000, ratio: 27.7, changeRate: 3, changeDirection: 'down' },
            { id: 'PRJ-003', name: '免疫组化-IHC', category: 'pathology-tech', sampleCount: 3280, unitCost: 56.7, totalCost: 186000, ratio: 18.1, changeRate: 5, changeDirection: 'up' },
            { id: 'PRJ-004', name: '特殊染色', category: 'pathology-tech', sampleCount: 1850, unitCost: 67.6, totalCost: 125000, ratio: 12.2, changeRate: 0, changeDirection: 'neutral' },
            { id: 'PRJ-005', name: '细胞学检查', category: 'pathology-diag', sampleCount: 2100, unitCost: 38.1, totalCost: 80000, ratio: 7.8, changeRate: 2, changeDirection: 'down' }
        ],
        materialCosts: [
            { id: 'MAT-COST-001', name: 'NGS建库试剂盒', spec: '50次/盒', consumption: 45, consumptionUnit: '盒', totalCost: 144000, ratio: 13.3, changeRate: 15, changeDirection: 'up' },
            { id: 'MAT-COST-002', name: '测序芯片', spec: 'FlowCell', consumption: 12, consumptionUnit: '张', totalCost: 102000, ratio: 9.4, changeRate: 0, changeDirection: 'neutral' },
            { id: 'MAT-COST-003', name: '苏木精染液', spec: '500ml/瓶', consumption: 60, consumptionUnit: '瓶', totalCost: 2400, ratio: 0.2, changeRate: 5, changeDirection: 'down' },
            // ==================== 验收测试物料成本 ====================
            { id: 'MAT-COST-TEST-001', name: '验收测试试剂盒', spec: '10次/盒', consumption: 15, consumptionUnit: '盒', totalCost: 7600, ratio: 0.7, changeRate: 0, changeDirection: 'neutral' }
        ],
        publicCosts: [
            { id: 'PUB-001', name: '一次性手套', category: '防护用品', consumption: 1200, consumptionUnit: '盒', totalCost: 12000, ratio: 26.3 },
            { id: 'PUB-002', name: '医用口罩', category: '防护用品', consumption: 800, consumptionUnit: '盒', totalCost: 8000, ratio: 17.5 },
            { id: 'PUB-003', name: '防护服', category: '防护用品', consumption: 200, consumptionUnit: '套', totalCost: 10000, ratio: 21.9 },
            { id: 'PUB-004', name: '消毒液', category: '消毒用品', consumption: 150, consumptionUnit: '瓶', totalCost: 7500, ratio: 16.4 },
            { id: 'PUB-005', name: '酒精棉球', category: '消毒用品', consumption: 230, consumptionUnit: '瓶', totalCost: 8100, ratio: 17.8 }
        ],
        supplierCosts: [
            { id: 'SUP-COST-001', name: '罗氏诊断', amount: 452000, ratio: 35.6, orderCount: 12, status: 'long-term' },
            { id: 'SUP-COST-002', name: '赛默飞', amount: 328000, ratio: 25.8, orderCount: 8, status: 'long-term' },
            { id: 'SUP-COST-003', name: '达安基因', amount: 185000, ratio: 14.6, orderCount: 15, status: 'long-term' },
            { id: 'SUP-COST-004', name: '华大基因', amount: 120000, ratio: 9.5, orderCount: 6, status: 'long-term' }
        ]
    },

    // ==================== 库存数据（用于跨页面状态同步） ====================
    inventory: [
        { id: 'INV-001', materialId: 'MAT-001', code: 'MAT-001', name: 'Harris苏木素染液', spec: '500ml/瓶', unit: '瓶', stock: 24, minStock: 5, location: 'A区-3-101', supplier: '北京病理科技', status: 'active', lastInbound: '2024-01-15', lastOutbound: '2024-01-18' },
        { id: 'INV-002', materialId: 'MAT-002', code: 'MAT-002', name: 'Gill苏木素染液', spec: '500ml/瓶', unit: '瓶', stock: 12, minStock: 5, location: 'A区-3-102', supplier: '上海生化试剂', status: 'active', lastInbound: '2024-01-10', lastOutbound: '2024-01-16' },
        { id: 'INV-003', materialId: 'MAT-011', code: 'MAT-011', name: '伊红Y染液', spec: '500ml/瓶', unit: '瓶', stock: 36, minStock: 10, location: 'A区-3-201', supplier: '北京病理科技', status: 'active', lastInbound: '2024-01-12', lastOutbound: '2024-01-17' },
        { id: 'INV-004', materialId: 'MAT-101', code: 'MAT-101', name: 'Ki-67抗体', spec: '1ml/支', unit: '支', stock: 15, minStock: 5, location: 'B区-1-101', supplier: 'DAKO', status: 'active', lastInbound: '2024-01-08', lastOutbound: '2024-01-15' },
        // ==================== 验收测试专用库存 ====================
        { id: 'INV-TEST-001', materialId: 'MAT-TEST-001', code: 'MAT-TEST-001', name: '验收测试试剂盒', spec: '10次/盒', unit: '盒', stock: 15, minStock: 5, location: 'D区-1-001', supplier: '云深生物', status: 'active', lastInbound: '2026-04-22', lastOutbound: '2026-04-23' }
    ],

    // ==================== 入库记录数据 ====================
    inboundRecords: [
        { id: 'IB-2024-001', code: 'IB-2024-001', materialId: 'MAT-001', materialName: 'Harris苏木素染液', quantity: 10, unit: '瓶', supplier: '北京病理科技', operator: '张三', status: 'completed', createdAt: '2024-01-15 10:30' },
        { id: 'IB-2024-002', code: 'IB-2024-002', materialId: 'MAT-011', materialName: '伊红Y染液', quantity: 20, unit: '瓶', supplier: '北京病理科技', operator: '李四', status: 'completed', createdAt: '2024-01-14 14:20' },
        { id: 'IB-2024-003', code: 'IB-2024-003', materialId: 'MAT-101', materialName: 'Ki-67抗体', quantity: 5, unit: '支', supplier: 'DAKO', operator: '王五', status: 'pending', createdAt: '2024-01-16 09:00' },
        // ==================== 验收测试入库记录 ====================
        { id: 'IB-TEST-2026-001', code: 'IB-TEST-2026-001', materialId: 'MAT-TEST-001', materialName: '验收测试试剂盒', batchNo: 'VAL-20260422', quantity: 10, unit: '盒', supplier: '云深生物', operator: '验收员A', status: 'completed', createdAt: '2026-04-22 09:00' },
        { id: 'IB-TEST-2026-002', code: 'IB-TEST-2026-002', materialId: 'MAT-TEST-001', materialName: '验收测试试剂盒', batchNo: 'VAL-20260423', quantity: 20, unit: '盒', supplier: '云深生物', operator: '验收员A', status: 'completed', createdAt: '2026-04-23 10:00' }
    ],

    // ==================== 出库记录数据 ====================
    outboundRecords: [
        { id: 'OB-2024-001', code: 'OB-2024-001', materialId: 'MAT-001', materialName: 'Harris苏木素染液', quantity: 5, unit: '瓶', projectId: 'HE-001', projectName: 'HE常规制片', operator: '张三', status: 'completed', createdAt: '2024-01-18 11:00' },
        { id: 'OB-2024-002', code: 'OB-2024-002', materialId: 'MAT-101', materialName: 'Ki-67抗体', quantity: 3, unit: '支', projectId: 'IHC-KI67', projectName: 'Ki-67免疫组化染色', operator: '李四', status: 'completed', createdAt: '2024-01-15 15:30' },
        // ==================== 验收测试出库记录 ====================
        { id: 'OB-TEST-2026-001', code: 'OB-TEST-2026-001', materialId: 'MAT-TEST-001', materialName: '验收测试试剂盒', quantity: 15, unit: '盒', projectId: 'MP-EGFR', projectName: 'EGFR基因突变检测', operator: '验收员B', status: 'completed', createdAt: '2026-04-23 14:00' }
    ],

    // ==================== 报废记录数据 ====================
    scrapRecords: [
        { id: 'SC-2024-001', code: 'SC-2024-001', materialId: 'MAT-001', materialName: 'Harris苏木素染液', quantity: 2, unit: '瓶', reason: '过期报废', operator: '张三', status: 'completed', createdAt: '2024-01-20 10:00' }
    ],

    // ==================== 盘点记录数据 ====================
    stocktakingRecords: [
        { id: 'ST-2024-001', code: 'ST-2024-001', name: '2024年1月盘点', status: 'completed', totalCount: 156, matchedCount: 150, differenceCount: 6, operator: '张三', createdAt: '2024-01-25 09:00', completedAt: '2024-01-25 17:00' }
    ]
};

// 状态管理器 - 用于跨页面状态同步
const stateManager = {
    inventory: [...mockData.inventory],
    inboundRecords: [...mockData.inboundRecords],
    outboundRecords: [...mockData.outboundRecords],
    scrapRecords: [...mockData.scrapRecords],
    stocktakingRecords: [...mockData.stocktakingRecords],
    
    listeners: [],
    
    subscribe(listener) {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    },
    
    notify(event) {
        this.listeners.forEach(listener => listener(event));
    },
    
    updateInventory(materialId, quantityChange) {
        const item = this.inventory.find(i => i.materialId === materialId);
        if (item) {
            item.stock += quantityChange;
            if (item.stock < 0) item.stock = 0;
            this.notify({ type: 'inventory_update', materialId, newStock: item.stock });
        }
    },
    
    addInboundRecord(record) {
        const newRecord = {
            id: `IB-${Date.now()}`,
            code: `IB-${new Date().getFullYear()}-${String(this.inboundRecords.length + 1).padStart(3, '0')}`,
            ...record,
            status: 'completed',
            createdAt: new Date().toLocaleString('zh-CN')
        };
        this.inboundRecords.unshift(newRecord);
        this.updateInventory(record.materialId, record.quantity);
        this.notify({ type: 'inbound_add', record: newRecord });
        return newRecord;
    },
    
    addOutboundRecord(record) {
        const newRecord = {
            id: `OB-${Date.now()}`,
            code: `OB-${new Date().getFullYear()}-${String(this.outboundRecords.length + 1).padStart(3, '0')}`,
            ...record,
            status: 'completed',
            createdAt: new Date().toLocaleString('zh-CN')
        };
        this.outboundRecords.unshift(newRecord);
        this.updateInventory(record.materialId, -record.quantity);
        this.notify({ type: 'outbound_add', record: newRecord });
        return newRecord;
    },
    
    addScrapRecord(record) {
        const newRecord = {
            id: `SC-${Date.now()}`,
            code: `SC-${new Date().getFullYear()}-${String(this.scrapRecords.length + 1).padStart(3, '0')}`,
            ...record,
            status: 'completed',
            createdAt: new Date().toLocaleString('zh-CN')
        };
        this.scrapRecords.unshift(newRecord);
        this.updateInventory(record.materialId, -record.quantity);
        this.notify({ type: 'scrap_add', record: newRecord });
        return newRecord;
    }
};

// API 模拟函数
export const mockApi = {
    // ==================== 分类相关 ====================
    getCategories: () => {
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve({ data: mockData.categories, success: true });
            }, 300);
        });
    },

    getMaterialsByCategory: (categoryId) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve({ data: mockData.materials[categoryId] || [], success: true });
            }, 200);
        });
    },

    // ==================== 耗材相关 ====================
    getConsumables: (params = {}) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                let data = [...mockData.consumables];
                
                if (params.keyword) {
                    const keyword = params.keyword.toLowerCase();
                    data = data.filter(item => 
                        item.name.toLowerCase().includes(keyword) ||
                        item.code.toLowerCase().includes(keyword) ||
                        item.supplier.toLowerCase().includes(keyword)
                    );
                }
                
                if (params.category) {
                    data = data.filter(item => item.category === params.category);
                }
                
                if (params.status) {
                    data = data.filter(item => item.status === params.status);
                }
                
                resolve({ data, total: data.length, success: true });
            }, 300);
        });
    },

    createConsumable: (data) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const newId = `CON-2024-${String(mockData.consumables.length + 1).padStart(3, '0')}`;
                const newItem = {
                    id: newId,
                    code: newId,
                    ...data,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                mockData.consumables.push(newItem);
                resolve({ data: newItem, success: true, message: '创建成功' });
            }, 500);
        });
    },

    updateConsumable: (id, data) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const index = mockData.consumables.findIndex(item => item.id === id);
                if (index !== -1) {
                    mockData.consumables[index] = {
                        ...mockData.consumables[index],
                        ...data,
                        updatedAt: new Date().toISOString()
                    };
                    resolve({ data: mockData.consumables[index], success: true, message: '更新成功' });
                } else {
                    resolve({ success: false, message: '未找到该耗材' });
                }
            }, 500);
        });
    },

    deleteConsumable: (id) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const index = mockData.consumables.findIndex(item => item.id === id);
                if (index !== -1) {
                    mockData.consumables.splice(index, 1);
                    resolve({ success: true, message: '删除成功' });
                } else {
                    resolve({ success: false, message: '未找到该耗材' });
                }
            }, 300);
        });
    },

    batchUpdateConsumables: (ids, action) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                ids.forEach(id => {
                    const index = mockData.consumables.findIndex(item => item.id === id);
                    if (index !== -1) {
                        if (action === 'enable') {
                            mockData.consumables[index].status = 'active';
                            mockData.consumables[index].statusDisplay = '已启用';
                        } else if (action === 'disable') {
                            mockData.consumables[index].status = 'inactive';
                            mockData.consumables[index].statusDisplay = '已停用';
                        }
                    }
                });
                resolve({ success: true, message: `成功${action === 'enable' ? '启用' : '停用'}${ids.length}项` });
            }, 500);
        });
    },

    // ==================== 检测服务相关 ====================
    getProjects: (params = {}) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                let data = [...mockData.projects];
                
                if (params.keyword) {
                    const keyword = params.keyword.toLowerCase();
                    data = data.filter(item => 
                        item.name.toLowerCase().includes(keyword) ||
                        item.code.toLowerCase().includes(keyword)
                    );
                }
                
                if (params.type) {
                    data = data.filter(item => item.type === params.type);
                }
                
                if (params.status) {
                    data = data.filter(item => item.status === params.status);
                }
                
                resolve({ data, total: data.length, success: true });
            }, 300);
        });
    },

    getProjectById: (id) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const project = mockData.projects.find(item => item.id === id);
                if (project) {
                    resolve({ data: project, success: true });
                } else {
                    resolve({ success: false, message: '未找到该检测服务' });
                }
            }, 200);
        });
    },

    createProject: (data) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const newId = `${data.type.toUpperCase()}-${String(mockData.projects.length + 1).padStart(3, '0')}`;
                const newItem = {
                    id: newId,
                    code: newId,
                    ...data,
                    status: 'active',
                    createdAt: new Date().toISOString()
                };
                mockData.projects.push(newItem);
                resolve({ data: newItem, success: true, message: '创建成功' });
            }, 500);
        });
    },

    updateProject: (id, data) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const index = mockData.projects.findIndex(item => item.id === id);
                if (index !== -1) {
                    mockData.projects[index] = {
                        ...mockData.projects[index],
                        ...data
                    };
                    resolve({ data: mockData.projects[index], success: true, message: '更新成功' });
                } else {
                    resolve({ success: false, message: '未找到该检测服务' });
                }
            }, 500);
        });
    },

    deleteProject: (id) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const index = mockData.projects.findIndex(item => item.id === id);
                if (index !== -1) {
                    mockData.projects.splice(index, 1);
                    resolve({ success: true, message: '删除成功' });
                } else {
                    resolve({ success: false, message: '未找到该检测服务' });
                }
            }, 300);
        });
    },

    // ==================== BOM相关 ====================
    getBoms: (params = {}) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                let data = [...mockData.boms];
                
                if (params.keyword) {
                    const keyword = params.keyword.toLowerCase();
                    data = data.filter(item => 
                        item.name.toLowerCase().includes(keyword) ||
                        item.code.toLowerCase().includes(keyword)
                    );
                }
                
                if (params.type) {
                    data = data.filter(item => item.type === params.type);
                }
                
                if (params.status) {
                    data = data.filter(item => item.status === params.status);
                }
                
                resolve({ data, total: data.length, success: true });
            }, 300);
        });
    },

    getBomById: (id) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const bom = mockData.boms.find(item => item.id === id);
                if (bom) {
                    resolve({ data: bom, success: true });
                } else {
                    resolve({ success: false, message: '未找到该BOM' });
                }
            }, 200);
        });
    },

    createBom: (data) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const newId = `BOM-${String(mockData.boms.length + 1).padStart(3, '0')}`;
                const newItem = {
                    id: newId,
                    code: newId,
                    version: 'v1.0',
                    ...data,
                    status: 'active',
                    createdAt: new Date().toLocaleString('zh-CN'),
                    updatedAt: new Date().toLocaleString('zh-CN')
                };
                mockData.boms.push(newItem);
                resolve({ data: newItem, success: true, message: '创建成功' });
            }, 500);
        });
    },

    updateBom: (id, data) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const index = mockData.boms.findIndex(item => item.id === id);
                if (index !== -1) {
                    const currentVersion = mockData.boms[index].version;
                    const versionNum = parseFloat(currentVersion.replace('v', ''));
                    mockData.boms[index] = {
                        ...mockData.boms[index],
                        ...data,
                        version: `v${(versionNum + 0.1).toFixed(1)}`,
                        updatedAt: new Date().toLocaleString('zh-CN')
                    };
                    resolve({ data: mockData.boms[index], success: true, message: '更新成功' });
                } else {
                    resolve({ success: false, message: '未找到该BOM' });
                }
            }, 500);
        });
    },

    deleteBom: (id) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const index = mockData.boms.findIndex(item => item.id === id);
                if (index !== -1) {
                    mockData.boms.splice(index, 1);
                    resolve({ success: true, message: '删除成功' });
                } else {
                    resolve({ success: false, message: '未找到该BOM' });
                }
            }, 300);
        });
    },

    // ==================== 库存相关（支持跨页面状态同步） ====================
    getInventory: (params = {}) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                let data = [...stateManager.inventory];
                
                if (params.keyword) {
                    const keyword = params.keyword.toLowerCase();
                    data = data.filter(item => 
                        item.name.toLowerCase().includes(keyword) ||
                        item.code.toLowerCase().includes(keyword)
                    );
                }
                
                if (params.status) {
                    data = data.filter(item => item.status === params.status);
                }
                
                resolve({ data, total: data.length, success: true });
            }, 300);
        });
    },

    getInventoryById: (id) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const item = stateManager.inventory.find(i => i.id === id);
                if (item) {
                    resolve({ data: item, success: true });
                } else {
                    resolve({ success: false, message: '未找到该库存记录' });
                }
            }, 200);
        });
    },

    // ==================== 入库相关 ====================
    getInboundRecords: (params = {}) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                let data = [...stateManager.inboundRecords];
                
                if (params.keyword) {
                    const keyword = params.keyword.toLowerCase();
                    data = data.filter(item => 
                        item.materialName.toLowerCase().includes(keyword) ||
                        item.code.toLowerCase().includes(keyword)
                    );
                }
                
                if (params.status) {
                    data = data.filter(item => item.status === params.status);
                }
                
                resolve({ data, total: data.length, success: true });
            }, 300);
        });
    },

    createInboundRecord: (record) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const newRecord = stateManager.addInboundRecord(record);
                resolve({ data: newRecord, success: true, message: '入库成功，库存已更新' });
            }, 500);
        });
    },

    // ==================== 出库相关 ====================
    getOutboundRecords: (params = {}) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                let data = [...stateManager.outboundRecords];
                
                if (params.keyword) {
                    const keyword = params.keyword.toLowerCase();
                    data = data.filter(item => 
                        item.materialName.toLowerCase().includes(keyword) ||
                        item.code.toLowerCase().includes(keyword)
                    );
                }
                
                if (params.status) {
                    data = data.filter(item => item.status === params.status);
                }
                
                resolve({ data, total: data.length, success: true });
            }, 300);
        });
    },

    createOutboundRecord: (record) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const inventoryItem = stateManager.inventory.find(i => i.materialId === record.materialId);
                if (inventoryItem && inventoryItem.stock >= record.quantity) {
                    const newRecord = stateManager.addOutboundRecord(record);
                    resolve({ data: newRecord, success: true, message: '出库成功，库存已更新' });
                } else {
                    resolve({ success: false, message: '库存不足，无法出库' });
                }
            }, 500);
        });
    },

    // ==================== 报废相关 ====================
    getScrapRecords: (params = {}) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                let data = [...stateManager.scrapRecords];
                
                if (params.keyword) {
                    const keyword = params.keyword.toLowerCase();
                    data = data.filter(item => 
                        item.materialName.toLowerCase().includes(keyword) ||
                        item.code.toLowerCase().includes(keyword)
                    );
                }
                
                if (params.status) {
                    data = data.filter(item => item.status === params.status);
                }
                
                resolve({ data, total: data.length, success: true });
            }, 300);
        });
    },

    createScrapRecord: (record) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const inventoryItem = stateManager.inventory.find(i => i.materialId === record.materialId);
                if (inventoryItem && inventoryItem.stock >= record.quantity) {
                    const newRecord = stateManager.addScrapRecord(record);
                    resolve({ data: newRecord, success: true, message: '报废成功，库存已更新' });
                } else {
                    resolve({ success: false, message: '库存不足，无法报废' });
                }
            }, 500);
        });
    },

    // ==================== 盘点相关 ====================
    getStocktakingRecords: (params = {}) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                let data = [...stateManager.stocktakingRecords];
                resolve({ data, total: data.length, success: true });
            }, 300);
        });
    },

    // ==================== 成本分析相关 ====================
    getCostAnalysis: () => {
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve({ data: mockData.costAnalysis, success: true });
            }, 300);
        });
    },

    // ==================== 供应商相关 ====================
    getSuppliers: (params = {}) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                let data = [...mockData.suppliers];
                
                if (params.keyword) {
                    const keyword = params.keyword.toLowerCase();
                    data = data.filter(item => 
                        item.name.toLowerCase().includes(keyword) ||
                        item.contact.toLowerCase().includes(keyword)
                    );
                }
                
                if (params.status) {
                    data = data.filter(item => item.status === params.status);
                }
                
                resolve({ data, total: data.length, success: true });
            }, 300);
        });
    },

    // ==================== 库位相关 ====================
    getLocations: (params = {}) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                let data = [...mockData.locations];
                
                if (params.keyword) {
                    const keyword = params.keyword.toLowerCase();
                    data = data.filter(item => 
                        item.name.toLowerCase().includes(keyword) ||
                        item.zone.toLowerCase().includes(keyword)
                    );
                }
                
                if (params.status) {
                    data = data.filter(item => item.status === params.status);
                }
                
                resolve({ data, total: data.length, success: true });
            }, 300);
        });
    },

    // ==================== 状态订阅 ====================
    subscribeToStateChanges: (listener) => {
        return stateManager.subscribe(listener);
    }
};

export default mockData;
