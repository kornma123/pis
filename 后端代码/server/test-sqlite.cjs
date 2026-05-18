const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('./data/coreone.db');
try {
  // Test 1: raw args with run
  const stmt = db.prepare('INSERT INTO inbound_records (id, inbound_no, type, material_id, batch_no, quantity, unit, price, amount, supplier_id, location_id, production_date, expiry_date, operator, status, remark, purchase_order_id, purchase_order_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const id = 'test-' + Date.now();
  stmt.run(id, 'IB-' + Date.now(), 'direct', 'MAT-HE-001', null, 10, '瓶', 0, 0, null, 'LOC-A01', null, null, 'system', 'completed', null, null, null);
  console.log('INSERT OK with run()');
  db.prepare('DELETE FROM inbound_records WHERE id = ?').run(id);
  console.log('Cleanup OK');
  
  // Test 2: object binding like in the route code
  const stmt2 = db.prepare('INSERT INTO inbound_records (id, inbound_no, type, material_id, batch_no, quantity, unit, price, amount, supplier_id, location_id, production_date, expiry_date, operator, status, remark, purchase_order_id, purchase_order_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const id2 = 'test2-' + Date.now();
  const params = [id2, 'IB2-' + Date.now(), 'direct', 'MAT-HE-001', null, 10, '瓶', 0, 0, null, 'LOC-A01', null, null, 'system', 'completed', null, null, null];
  stmt2.run(...params);
  console.log('INSERT OK with spread');
  db.prepare('DELETE FROM inbound_records WHERE id = ?').run(id2);
  console.log('Cleanup OK');
} catch(e) {
  console.error('Error:', e.message);
}
db.close();
