const Database = require('better-sqlite3');
const db = new Database('/app/store.db');
const rows = db.prepare('SELECT name, description FROM products').all();
console.log('Products:', JSON.stringify(rows, null, 2));
const q = 'عسل';
const results = db.prepare('SELECT name, price, quantity FROM products WHERE name LIKE ?').all('%' + q + '%');
console.log('Search for عسل:', JSON.stringify(results, null, 2));
// Try direct LIKE
const all = db.prepare("SELECT name FROM products WHERE name LIKE '%عسل%'").all();
console.log('Direct LIKE:', JSON.stringify(all, null, 2));
