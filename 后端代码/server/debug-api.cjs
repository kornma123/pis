const http = require('http');

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: 3001, path: '/api/v1' + path,
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const login = await post('/auth/login', { username: 'admin', password: 'admin123' });
  const token = JSON.parse(login.body).data.token;
  console.log('Login:', login.status);
  
  // Test 1: without batchNo (should skip batches insert)
  const t1 = await post('/inbound', {
    type: 'direct', materialId: 'MAT-HE-001', locationId: 'LOC-A01',
    quantity: 10, remark: 'E2E no batch'
  }, { Authorization: 'Bearer ' + token });
  console.log('Test1 no batchNo:', t1.status, t1.body.slice(0,100));
  
  // Test 2: with batchNo but no expiryDate
  const t2 = await post('/inbound', {
    type: 'direct', materialId: 'MAT-HE-001', locationId: 'LOC-A01',
    quantity: 10, batchNo: 'TEST-' + Date.now(), remark: 'E2E with batch'
  }, { Authorization: 'Bearer ' + token });
  console.log('Test2 with batchNo:', t2.status, t2.body.slice(0,100));
  
  // Test 3: with batchNo and expiryDate: null
  const t3 = await post('/inbound', {
    type: 'direct', materialId: 'MAT-HE-001', locationId: 'LOC-A01',
    quantity: 10, batchNo: 'TEST-NULL-' + Date.now(), expiryDate: null, remark: 'E2E null expiry'
  }, { Authorization: 'Bearer ' + token });
  console.log('Test3 expiry null:', t3.status, t3.body.slice(0,100));
}

main().catch(console.error);
