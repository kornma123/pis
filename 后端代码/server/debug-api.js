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
  
  const create = await post('/inbound', {
    type: 'direct', materialId: 'MAT-HE-001', locationId: 'LOC-A01',
    quantity: 10, batchNo: 'TEST-' + Date.now(), remark: 'E2E'
  }, { Authorization: 'Bearer ' + token });
  console.log('Create inbound:', create.status, create.body);
}

main().catch(console.error);
