import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { getDatabase, initializeDatabase } from '../src/database/DatabaseManager.js';

describe('Inbound API', () => {
  let testSupplierId: string;

  beforeAll(async () => {
    // 初始化测试数据库
    initializeDatabase();

    // 创建测试供应商
    const response = await request(app)
      .post('/api/v1/suppliers')
      .send({
        code: 'TEST-SUP-001',
        name: '测试供应商',
        contact: '张三',
        phone: '13800138000',
      });
    
    testSupplierId = response.body.data?.id || 'test-supplier-id';
  });

  afterAll(async () => {
    // 清理测试数据
    const db = getDatabase();
    db.exec("DELETE FROM inbound_records WHERE supplier_name = '测试供应商'");
    db.exec("DELETE FROM suppliers WHERE name = '测试供应商'");
  });

  describe('POST /api/v1/inbound', () => {
    it('should create inbound record successfully', async () => {
      const response = await request(app)
        .post('/api/v1/inbound')
        .send({
          categoryId: 'test-category',
          materialId: 'test-material',
          quantity: 10,
          unitPrice: 580,
          supplierId: testSupplierId,
          supplierName: '测试供应商',
          batchNo: '20260507-001',
          expiryDate: '2026-12-31',
          storageLocation: 'A区-1号柜-3层',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
    });

    it('should fail with missing required fields', async () => {
      const response = await request(app)
        .post('/api/v1/inbound')
        .send({
          categoryId: 'test-category',
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should fail with invalid quantity', async () => {
      const response = await request(app)
        .post('/api/v1/inbound')
        .send({
          categoryId: 'test-category',
          materialId: 'test-material',
          quantity: -10,
          unitPrice: 580,
          supplierName: '测试供应商',
          batchNo: '20260507-002',
          expiryDate: '2026-12-31',
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should fail with past expiry date', async () => {
      const response = await request(app)
        .post('/api/v1/inbound')
        .send({
          categoryId: 'test-category',
          materialId: 'test-material',
          quantity: 10,
          unitPrice: 580,
          supplierName: '测试供应商',
          batchNo: '20260507-003',
          expiryDate: '2020-01-01',
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /api/v1/inbound', () => {
    it('should return paginated list', async () => {
      const response = await request(app)
        .get('/api/v1/inbound?page=1&perPage=10');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should filter by category', async () => {
      const response = await request(app)
        .get('/api/v1/inbound?categoryId=test-category');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should search by keyword', async () => {
      const response = await request(app)
        .get('/api/v1/inbound?search=测试');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /api/v1/inbound/:id', () => {
    it('should return 404 for non-existent record', async () => {
      const response = await request(app)
        .get('/api/v1/inbound/non-existent-id');

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });
  });
});
