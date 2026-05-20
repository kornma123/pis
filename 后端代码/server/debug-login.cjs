const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const db = new DatabaseSync('./data/coreone.db');

try {
  const rows = db.prepare('SELECT id, username, real_name, role, status, is_deleted, substr(password, 1, 30) as pw FROM users').all();
  console.log('All users:');
  for (const r of rows) {
    console.log(`  ${r.username}: role=${r.role}, status=${r.status}, is_deleted=${r.is_deleted}, pw_prefix=${r.pw}`);
  }

  const admin = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  if (!admin) {
    console.log('ERROR: admin user NOT FOUND');
  } else {
    console.log('\nAdmin found:', admin.id, admin.real_name, admin.role, 'status=', admin.status);
    const testPw = 'admin123';
    const match = bcrypt.compareSync(testPw, admin.password);
    console.log('Password match:', match);
  }
} catch(e) {
  console.error('Error:', e.message);
}
db.close();
