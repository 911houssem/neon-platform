const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 4000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '10032008';

// Evolution API config
const EVO_URL = process.env.EVOLUTION_API_URL || 'http://evolution-api:8080';
const EVO_KEY = process.env.EVOLUTION_API_KEY || '123456';
const N8N_URL = process.env.N8N_WEBHOOK_URL || 'http://n8n:5678/webhook/customer-service';
const evoHeaders = { apikey: EVO_KEY, 'Content-Type': 'application/json' };

const qrCache = {};

// === Database ===
const db = new Database(path.join(__dirname, 'store.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    password TEXT DEFAULT '',
    info TEXT DEFAULT '',
    store_name TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL REFERENCES vendors(vendor_id),
    name TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    quantity INTEGER NOT NULL DEFAULT 0,
    description TEXT DEFAULT '',
    image TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL REFERENCES vendors(vendor_id),
    product_id INTEGER REFERENCES products(id),
    customer_name TEXT,
    customer_phone TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    total REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS registration_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    code TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function genVendorId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  while (true) {
    let id = 'VND-';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    if (!db.prepare('SELECT 1 FROM vendors WHERE vendor_id = ?').get(id)) return id;
  }
}

// === Middleware ===
app.use(express.json());
app.get('/qr', (req, res) => res.sendFile(path.join(__dirname, 'qr-public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

// === Auth Middleware ===
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (token === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function vendorAuth(req, res, next) {
  const name = req.params.name;
  const vendor = db.prepare('SELECT * FROM vendors WHERE name = ? OR vendor_id = ?').get(name, name);
  if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
  req.vendor = vendor;
  next();
}

// ===================== ADMIN ROUTES =====================

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.json({ token: ADMIN_PASSWORD, success: true });
  } else {
    res.status(401).json({ error: 'كلمة السر خطأ' });
  }
});

app.get('/api/admin/vendors', adminAuth, (req, res) => {
  const vendors = db.prepare('SELECT id, vendor_id, name, phone, status, created_at, store_name FROM vendors ORDER BY created_at DESC').all();
  const prodCount = db.prepare('SELECT vendor_id, COUNT(*) as count FROM products GROUP BY vendor_id').all();
  const orderCount = db.prepare('SELECT vendor_id, COUNT(*) as count FROM orders GROUP BY vendor_id').all();
  const pMap = Object.fromEntries(prodCount.map(r => [r.vendor_id, r.count]));
  const oMap = Object.fromEntries(orderCount.map(r => [r.vendor_id, r.count]));
  res.json(vendors.map(v => ({ ...v, products: pMap[v.vendor_id] || 0, orders: oMap[v.vendor_id] || 0, user_count: 0 })));
});

app.post('/api/admin/vendors', adminAuth, (req, res) => {
  const { name, phone, password, status } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const vid = genVendorId();
  db.prepare('INSERT INTO vendors (vendor_id, name, phone, password, status) VALUES (?, ?, ?, ?, ?)').run(vid, name, phone || '', password || '', status || 'active');
  res.json({ success: true, vendor_id: vid });
});

app.put('/api/admin/vendors/:id', adminAuth, (req, res) => {
  const { name, phone, password, status } = req.body;
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ? OR vendor_id = ?').get(req.params.id, req.params.id);
  if (!vendor) return res.status(404).json({ error: 'Not found' });
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (phone !== undefined) { sets.push('phone = ?'); vals.push(phone); }
  if (password !== undefined) { sets.push('password = ?'); vals.push(password); }
  if (status !== undefined) { sets.push('status = ?'); vals.push(status); }
  if (sets.length) { vals.push(vendor.id); db.prepare(`UPDATE vendors SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
  res.json({ success: true });
});

app.delete('/api/admin/vendors/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM orders WHERE vendor_id = ?').run(req.params.id);
  db.prepare('DELETE FROM products WHERE vendor_id = ?').run(req.params.id);
  db.prepare('DELETE FROM vendors WHERE vendor_id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/orders', adminAuth, (req, res) => {
  const orders = db.prepare(`SELECT o.*, p.name as product_name, p.price as product_price, v.name as vendor_name, v.store_name FROM orders o LEFT JOIN products p ON o.product_id = p.id LEFT JOIN vendors v ON o.vendor_id = v.vendor_id ORDER BY o.created_at DESC`).all();
  res.json(orders);
});

app.put('/api/admin/orders/:id/status', adminAuth, (req, res) => {
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
  res.json({ success: true });
});

// ===================== VENDOR ROUTES =====================

app.post('/api/vendor/login', (req, res) => {
  const { name, password } = req.body;
  const vendor = db.prepare('SELECT * FROM vendors WHERE name = ?').get(name);
  if (!vendor) return res.status(401).json({ error: 'المتجر غير موجود' });
  if (vendor.password && vendor.password !== password) return res.status(401).json({ error: 'كلمة السر خطأ' });
  res.json({ success: true, token: vendor.vendor_id, name: vendor.name, vendor });
});

app.get('/api/vendor/:name/products', vendorAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM products WHERE vendor_id = ? ORDER BY created_at DESC').all(req.vendor.vendor_id));
});

app.post('/api/vendor/:name/products', vendorAuth, (req, res) => {
  const { name, price, description, image } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const r = db.prepare('INSERT INTO products (vendor_id, name, price, description, image) VALUES (?, ?, ?, ?, ?)').run(req.vendor.vendor_id, name, parseFloat(price) || 0, description || '', image || '');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.delete('/api/vendor/:name/products/:id', vendorAuth, (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ? AND vendor_id = ?').run(req.params.id, req.vendor.vendor_id);
  res.json({ success: true });
});

app.get('/api/vendor/:name/orders', vendorAuth, (req, res) => {
  res.json(db.prepare(`SELECT o.*, p.name as product_name FROM orders o LEFT JOIN products p ON o.product_id = p.id WHERE o.vendor_id = ? ORDER BY o.created_at DESC`).all(req.vendor.vendor_id));
});

app.put('/api/vendor/:name/orders/:id/status', vendorAuth, (req, res) => {
  db.prepare('UPDATE orders SET status = ? WHERE id = ? AND vendor_id = ?').run(req.body.status, req.params.id, req.vendor.vendor_id);
  res.json({ success: true });
});

// ===================== REGISTER ROUTES =====================

app.post('/api/register', (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'الاسم والهاتف مطلوبان' });
  if (db.prepare('SELECT 1 FROM vendors WHERE name = ?').get(name)) return res.status(400).json({ error: 'المتجر موجود مسبقاً' });
  const code = String(Math.floor(1000 + Math.random() * 9000));
  db.prepare('DELETE FROM registration_codes WHERE phone = ?').run(phone);
  db.prepare('INSERT INTO registration_codes (phone, code) VALUES (?, ?)').run(phone, code);
  console.log(`[REGISTER] Verification code for ${phone}: ${code}`);
  res.json({ success: true, message: 'تم الإرسال', debug_code: code });
});

app.post('/api/register/verify-code', (req, res) => {
  const { code, phone } = req.body;
  const record = db.prepare('SELECT * FROM registration_codes WHERE phone = ? AND code = ?').get(phone, code);
  if (!record) return res.status(400).json({ error: 'رمز غير صحيح' });
  db.prepare('DELETE FROM registration_codes WHERE phone = ?').run(phone);
  res.json({ success: true, verified: true });
});

app.post('/api/register/complete', (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'بيانات ناقصة' });
  const vid = genVendorId();
  db.prepare('INSERT INTO vendors (vendor_id, name, phone, password, status) VALUES (?, ?, ?, ?, ?)').run(vid, name, phone, password || '', 'pending');
  res.json({ success: true, vendor_id: vid, token: vid });
});

// ===================== CHATBOT API =====================

app.get('/api/chat/products', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  res.json(db.prepare(`SELECT p.id, p.name, p.price, p.quantity, p.description, p.image, v.store_name, v.vendor_id FROM products p JOIN vendors v ON p.vendor_id = v.vendor_id WHERE p.quantity > 0 AND (p.name LIKE ? OR p.description LIKE ?) LIMIT 10`).all(`%${q}%`, `%${q}%`));
});

app.get('/api/chat/products/:id', (req, res) => {
  const p = db.prepare('SELECT p.*, v.store_name, v.vendor_id FROM products p JOIN vendors v ON p.vendor_id = v.vendor_id WHERE p.id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'غير موجود' });
  res.json(p);
});

app.post('/api/chat/order', (req, res) => {
  const { product_id, customer_name, customer_phone, quantity } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
  if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });
  if (product.quantity < (quantity || 1)) return res.status(400).json({ error: 'الكمية غير متوفرة' });
  const qty = quantity || 1;
  db.prepare('UPDATE products SET quantity = quantity - ? WHERE id = ?').run(qty, product_id);
  const r = db.prepare('INSERT INTO orders (vendor_id, product_id, customer_name, customer_phone, quantity, total) VALUES (?, ?, ?, ?, ?, ?)').run(product.vendor_id, product_id, customer_name || '', customer_phone || '', qty, product.price * qty);
  res.json({ success: true, order_id: r.lastInsertRowid, product: product.name, remaining: product.quantity - qty });
});

app.get('/api/chat/vendor/:vid', (req, res) => {
  const v = db.prepare('SELECT vendor_id, store_name, info, name, phone FROM vendors WHERE vendor_id = ?').get(req.params.vid);
  if (!v) return res.status(404).json({ error: 'غير موجود' });
  res.json(v);
});

// ===================== QR / EVOLUTION API ROUTES =====================

app.post('/api/instance/create', async (req, res) => {
  try {
    const { instanceName } = req.body;
    const r = await fetch(`${EVO_URL}/instance/create`, { method: 'POST', headers: evoHeaders, body: JSON.stringify({ instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS' }) });
    const data = await r.json();
    if (data.qrcode?.base64) qrCache[instanceName] = data.qrcode.base64;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/instance/qrcode/:name', async (req, res) => {
  const { name } = req.params;
  if (qrCache[name]) return res.json({ base64: qrCache[name] });
  try { const r = await fetch(`${EVO_URL}/instance/qrcode/${name}`, { headers: evoHeaders }); const data = await r.json(); if (data.qrcode?.base64) qrCache[name] = data.qrcode.base64; res.json(data); } catch { res.json({ base64: null }); }
});

app.get('/api/instance/state/:name', async (req, res) => {
  try { const r = await fetch(`${EVO_URL}/instance/connectionState/${req.params.name}`, { headers: evoHeaders }); res.json(await r.json()); } catch { res.json({ state: 'disconnected' }); }
});

app.post('/api/instance/webhook/:name', async (req, res) => {
  try { const r = await fetch(`${EVO_URL}/instance/setWebhook/${req.params.name}`, { method: 'POST', headers: evoHeaders, body: JSON.stringify({ webhook: { url: N8N_URL, byEvents: false, base64: false } }) }); res.json(await r.json()); } catch (err) { res.json({ error: err.message }); }
});

app.post('/api/instance/logout/:name', async (req, res) => {
  try { const r = await fetch(`${EVO_URL}/instance/logout/${req.params.name}`, { method: 'DELETE', headers: evoHeaders }); res.json(await r.json()); } catch (err) { res.json({ error: err.message }); }
});

// ===== Static fallback =====
app.get(['/admin', '/admin.html'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/vendor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vendor.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/', (req, res) => res.redirect('/admin'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Neon Platform running on http://0.0.0.0:${PORT}`);
});
