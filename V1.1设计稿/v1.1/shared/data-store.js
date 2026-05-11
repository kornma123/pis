// COREONE Shared Data Store
// 用于跨页面状态同步的共享数据存储
// 使用 localStorage 实现持久化

class CoreDataStore {
    constructor() {
        this.STORAGE_KEY = 'coreone_data';
    }
    
    getDefaultData() {
        return {
            inventory: [
                { id: 'INV-001', materialId: 'MAT-001', code: 'MAT-001', name: 'Harris苏木素染液', spec: '500ml/瓶', unit: '瓶', batch: 'LOT-2024-001', stock: 24, minStock: 5, location: 'A区-试剂冷藏', supplier: '北京病理科技', expiry: '2025-06-15', status: 'normal' },
                { id: 'INV-002', materialId: 'MAT-002', code: 'MAT-002', name: 'Gill苏木素染液', spec: '500ml/瓶', unit: '瓶', batch: 'LOT-2024-002', stock: 8, minStock: 10, location: 'A区-试剂冷藏', supplier: '上海生化试剂', expiry: '2024-12-20', status: 'low-stock' },
                { id: 'INV-003', materialId: 'MAT-011', code: 'MAT-011', name: '伊红Y染液', spec: '500ml/瓶', unit: '瓶', batch: 'LOT-2024-011', stock: 36, minStock: 10, location: 'A区-试剂冷藏', supplier: '北京病理科技', expiry: '2024-04-10', status: 'warning' },
                { id: 'INV-004', materialId: 'MAT-101', code: 'MAT-101', name: 'Ki-67抗体', spec: '1ml/支', unit: '支', batch: 'LOT-2023-0892', stock: 2, minStock: 5, location: 'B区-常温耗材', supplier: 'DAKO', expiry: '2024-04-01', status: 'expired' },
                { id: 'INV-005', materialId: 'MAT-201', code: 'MAT-201', name: '包埋盒', spec: '标准型', unit: '个', batch: 'LOT-2024-201', stock: 500, minStock: 100, location: 'C区-设备配件', supplier: '徕卡', expiry: '2026-12-31', status: 'normal' },
                { id: 'INV-006', materialId: 'MAT-202', code: 'MAT-202', name: '载玻片', spec: '25x75mm', unit: '盒', batch: 'LOT-2024-202', stock: 0, minStock: 20, location: 'C区-设备配件', supplier: '康宁', expiry: '2025-08-15', status: 'out-of-stock' }
            ],
            materials: [
                { id: 'MAT-001', code: 'MAT-001', name: 'Harris苏木素染液', spec: '500ml/瓶', unit: '瓶', stock: 24, projects: ['HE常规制片', '特殊染色'] },
                { id: 'MAT-002', code: 'MAT-002', name: 'Gill苏木素染液', spec: '500ml/瓶', unit: '瓶', stock: 8, projects: ['HE常规制片'] },
                { id: 'MAT-011', code: 'MAT-011', name: '伊红Y染液', spec: '500ml/瓶', unit: '瓶', stock: 36, projects: ['HE常规制片'] },
                { id: 'MAT-101', code: 'MAT-101', name: 'Ki-67抗体', spec: '1ml/支', unit: '支', stock: 2, projects: ['免疫组化'] },
                { id: 'MAT-201', code: 'MAT-201', name: '包埋盒', spec: '标准型', unit: '个', stock: 500, projects: [] },
                { id: 'MAT-202', code: 'MAT-202', name: '载玻片', spec: '25x75mm', unit: '盒', stock: 0, projects: [] }
            ],
            projects: [
                { id: '1', name: '新生儿遗传代谢病筛查' },
                { id: '2', name: '产前筛查' },
                { id: '3', name: 'HE常规制片' },
                { id: '4', name: '免疫组化' },
                { id: '5', name: '特殊染色' }
            ],
            inboundRecords: [
                { id: 'IB-2024-001', code: 'IN20241210-001', materialId: 'MAT-001', materialName: 'Harris苏木素染液', quantity: 10, unit: '瓶', supplier: '北京病理科技', operator: '张三', status: 'completed', createdAt: '2024-12-10 10:30' }
            ],
            outboundRecords: [
                { id: 'OB-2024-001', code: 'OUT-2024-0156', materialId: 'MAT-001', materialName: 'Harris苏木素染液', quantity: 5, unit: '瓶', projectId: 'HE-001', projectName: 'HE常规制片', operator: '张三', status: 'completed', createdAt: '2024-01-15 10:30' }
            ],
            scrapRecords: [
                { id: 'SC-2024-001', code: 'SCR-2024-0015', materialId: 'MAT-001', materialName: 'Harris苏木素染液', quantity: 2, unit: '瓶', reason: '过期报废', operator: '张三', status: 'completed', createdAt: '2024-01-20 10:00' }
            ]
        };
    }
    
    getData() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (stored) {
                return JSON.parse(stored);
            }
        } catch (e) {
            console.warn('Failed to load data from localStorage:', e);
        }
        return this.getDefaultData();
    }
    
    saveData(data) {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            console.warn('Failed to save data to localStorage:', e);
        }
    }
    
    resetData() {
        this.saveData(this.getDefaultData());
    }
    
    getInventory() {
        return this.getData().inventory || [];
    }
    
    getInventoryWithDetails() {
        return this.getData().inventory || [];
    }
    
    getAllMaterials() {
        return this.getData().materials || [];
    }
    
    getProjects() {
        return this.getData().projects || [];
    }
    
    updateInventoryStock(materialId, quantityChange) {
        const data = this.getData();
        const item = data.inventory.find(i => i.materialId === materialId);
        if (item) {
            item.stock += quantityChange;
            if (item.stock < 0) item.stock = 0;
            this.saveData(data);
            return true;
        }
        return false;
    }
    
    addInboundRecord(record) {
        const data = this.getData();
        const newRecord = {
            id: 'IB-' + Date.now(),
            code: 'IN' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '-' + String(data.inboundRecords.length + 1).padStart(3, '0'),
            ...record,
            status: 'completed',
            createdAt: new Date().toLocaleString('zh-CN')
        };
        data.inboundRecords.unshift(newRecord);
        this.updateInventoryStock(record.materialId, record.quantity);
        this.saveData(data);
        return newRecord;
    }
    
    createOutboundRecord(record) {
        return this.addOutboundRecord(record);
    }
    
    addOutboundRecord(record) {
        const data = this.getData();
        const newRecord = {
            id: 'OB-' + Date.now(),
            code: 'OUT-' + new Date().getFullYear() + '-' + String(data.outboundRecords.length + 1).padStart(4, '0'),
            ...record,
            status: 'completed',
            createdAt: new Date().toLocaleString('zh-CN')
        };
        data.outboundRecords.unshift(newRecord);
        this.updateInventoryStock(record.materialId, -record.quantity);
        this.saveData(data);
        return newRecord;
    }
    
    addScrapRecord(record) {
        const data = this.getData();
        const newRecord = {
            id: 'SC-' + Date.now(),
            code: 'SCR-' + new Date().getFullYear() + '-' + String(data.scrapRecords.length + 1).padStart(4, '0'),
            ...record,
            status: 'completed',
            createdAt: new Date().toLocaleString('zh-CN')
        };
        data.scrapRecords.unshift(newRecord);
        this.updateInventoryStock(record.materialId, -record.quantity);
        this.saveData(data);
        return newRecord;
    }
    
    getInboundRecords() {
        return this.getData().inboundRecords || [];
    }
    
    getOutboundRecords() {
        return this.getData().outboundRecords || [];
    }
    
    getScrapRecords() {
        return this.getData().scrapRecords || [];
    }
}

window.CoreDataStore = CoreDataStore;
