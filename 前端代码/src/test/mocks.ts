import type {
  InboundRecord,
  Material,
  Supplier,
  Location,
  InventoryItem,
  OutboundRecord,
  SupplierReturnRecord,
  PurchaseOrder,
  ApiResponse,
  PaginationData,
} from '@/types'

export function createMockInboundRecord(overrides?: Partial<InboundRecord>): InboundRecord {
  return {
    id: 'inb-001',
    inboundNo: 'IN-20240526-001',
    type: 'purchase',
    materialId: 'mat-001',
    materialName: '测试耗材A',
    batchNo: 'B20240526',
    quantity: 100,
    unit: '盒',
    price: 50,
    amount: 5000,
    supplierId: 'sup-001',
    supplierName: '测试供应商',
    locationId: 'loc-001',
    locationName: 'A1-01',
    operator: 'admin',
    status: 'completed',
    remark: '',
    createdAt: '2024-05-26T08:00:00Z',
    ...overrides,
  }
}

export function createMockMaterial(overrides?: Partial<Material>): Material {
  return {
    id: 'mat-001',
    code: 'M001',
    name: '测试耗材A',
    spec: '10ml/支',
    unit: '盒',
    price: 50,
    stock: 200,
    minStock: 20,
    maxStock: 500,
    safetyStock: 50,
    categoryId: 'cat-001',
    status: 'active',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-05-26T00:00:00Z',
    ...overrides,
  }
}

export function createMockSupplier(overrides?: Partial<Supplier>): Supplier {
  return {
    id: 'sup-001',
    code: 'S001',
    name: '测试供应商',
    status: 'active',
    cooperationCount: 10,
    totalAmount: 50000,
    rating: 5,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-05-26T00:00:00Z',
    ...overrides,
  }
}

export function createMockLocation(overrides?: Partial<Location>): Location {
  return {
    id: 'loc-001',
    code: 'L001',
    name: 'A1-01',
    type: 'shelf',
    zone: 'A区',
    capacity: 1000,
    used: 500,
    status: 'active',
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

export function createMockInventoryItem(overrides?: Partial<InventoryItem>): InventoryItem {
  return {
    id: 'inv-001',
    materialId: 'mat-001',
    code: 'M001',
    name: '测试耗材A',
    spec: '10ml/支',
    unit: '盒',
    stock: 200,
    minStock: 20,
    maxStock: 500,
    availableStock: 180,
    locationId: 'loc-001',
    locationName: 'A1-01',
    status: 'normal',
    ...overrides,
  }
}

export function createMockOutboundRecord(overrides?: Partial<OutboundRecord>): OutboundRecord {
  return {
    id: 'out-001',
    outboundNo: 'OUT-20240526-001',
    type: 'project',
    projectId: 'proj-001',
    projectName: '测试项目',
    items: [
      {
        id: 'outi-001',
        outboundId: 'out-001',
        materialId: 'mat-001',
        materialName: '测试耗材A',
        quantity: 10,
        unit: '盒',
        unitCost: 50,
        totalCost: 500,
      },
    ],
    totalCost: 500,
    operator: 'admin',
    status: 'completed',
    createdAt: '2024-05-26T08:00:00Z',
    ...overrides,
  }
}

export function createMockSupplierReturnRecord(
  overrides?: Partial<SupplierReturnRecord>
): SupplierReturnRecord {
  return {
    id: 'sr-001',
    returnNo: 'SR-20240526-000001-001',
    materialId: 'mat-001',
    materialName: '测试耗材A',
    quantity: 10,
    supplierId: 'sup-001',
    supplierName: '测试供应商',
    reason: '质量问题',
    status: 'pending',
    operator: 'admin',
    createdAt: '2024-05-26T08:00:00Z',
    updatedAt: '2024-05-26T08:00:00Z',
    ...overrides,
  }
}

export function createMockPurchaseOrder(overrides?: Partial<PurchaseOrder>): PurchaseOrder {
  return {
    id: 'po-001',
    orderNo: 'PO-20240526-001',
    materialId: 'mat-001',
    materialName: '测试耗材A',
    supplierId: 'sup-001',
    supplierName: '测试供应商',
    orderedQty: 100,
    receivedQty: 0,
    remainingQty: 100,
    unit: '盒',
    unitPrice: 50,
    totalAmount: 5000,
    status: 'pending',
    createdAt: '2024-05-26T08:00:00Z',
    updatedAt: '2024-05-26T08:00:00Z',
    ...overrides,
  }
}

export function createMockApiResponse<T>(data: T, success = true): ApiResponse<T> {
  return {
    success,
    data,
    message: success ? 'ok' : 'error',
  }
}

export function createMockPaginationResponse<T>(
  list: T[] = [],
  total = 0,
  page = 1,
  pageSize = 20
): PaginationData<T> {
  return {
    list,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}
