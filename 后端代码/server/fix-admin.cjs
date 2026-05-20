const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('./data/coreone.db');

try {
  db.prepare('UPDATE users SET is_deleted = 0 WHERE username = ?').run('admin');
  console.log('Fixed admin is_deleted=0');
  const admin = db.prepare('SELECT username, is_deleted, status FROM users WHERE username = ?').get('admin');
  console.log('Admin state:', admin);
} catch(e) {
  console.error('Error:', e.message);
}
db.close();
