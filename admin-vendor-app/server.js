const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');

const app = express();
const PORT = 4000;
const ADMIN_PASSWORD = '10032008';
const N8N_QR_WEBHOOK = process.env.N8N_QR_WEBHOOK_URL || 'http://n8n:5678/webhook/qr-scan';

// ===== Database =====
const db = new Database(path.join(__dirname, 'store.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    info TEXT DEFAULT '',
    store_name TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL REFERENCES vendors(vendor_id),
    name TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    quantity INTEGER NOT NULL DEFAULT 0,
    description TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL REFERENCES vendors(vendor_id),
    product_id INTEGER REFERENCES products(id),
    customer_name TEXT,
    customer_phone TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_vendor_id ON vendors(vendor_id);
  CREATE INDEX IF NOT EXISTS idx_products_vendor ON products(vendor_id);
  CREATE INDEX IF NOT EXISTS idx_orders_vendor ON orders(vendor_id);
  CREATE TABLE IF NOT EXISTS qr_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    redirect_url TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS qr_scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_code TEXT NOT NULL REFERENCES qr_campaigns(code),
    ip TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    browser TEXT DEFAULT '',
    os TEXT DEFAULT '',
    device TEXT DEFAULT '',
    screen TEXT DEFAULT '',
    language TEXT DEFAULT '',
    platform TEXT DEFAULT '',
    timezone TEXT DEFAULT '',
    referrer TEXT DEFAULT '',
    country TEXT DEFAULT '',
    city TEXT DEFAULT '',
    raw_data TEXT DEFAULT '{}',
    scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Generate unique vendor ID
function genVendorId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id;
    while (true) {
        id = 'VND-';
        for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
        if (!db.prepare('SELECT 1 FROM vendors WHERE vendor_id = ?').get(id)) break;
    }
    return id;
}

// ===== Middleware =====
app.use(express.json());
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Route static pages
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/vendor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vendor.html')));
app.get('/', (req, res) => res.redirect('/admin'));

// ===== Admin Routes =====
app.post('/api/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        res.json({ success: true, token: ADMIN_PASSWORD });
    } else {
        res.status(401).json({ success: false, error: 'كلمة السر خطأ' });
    }
});

app.get('/api/admin/vendors', (req, res) => {
    if (req.headers['x-admin-token'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    const vendors = db.prepare('SELECT * FROM vendors ORDER BY created_at DESC').all();
    const productsCount = db.prepare('SELECT vendor_id, COUNT(*) as count FROM products GROUP BY vendor_id').all();
    const ordersCount = db.prepare('SELECT vendor_id, COUNT(*) as count FROM orders GROUP BY vendor_id').all();
    const pMap = Object.fromEntries(productsCount.map(r => [r.vendor_id, r.count]));
    const oMap = Object.fromEntries(ordersCount.map(r => [r.vendor_id, r.count]));
    res.json(vendors.map(v => ({ ...v, products: pMap[v.vendor_id] || 0, orders: oMap[v.vendor_id] || 0 })));
});

app.delete('/api/admin/vendors/:id', (req, res) => {
    if (req.headers['x-admin-token'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    const vid = req.params.id;
    db.prepare('DELETE FROM orders WHERE vendor_id = ?').run(vid);
    db.prepare('DELETE FROM products WHERE vendor_id = ?').run(vid);
    db.prepare('DELETE FROM vendors WHERE vendor_id = ?').run(vid);
    res.json({ success: true });
});

app.get('/api/admin/orders', (req, res) => {
    if (req.headers['x-admin-token'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    const orders = db.prepare(`
        SELECT o.*, p.name as product_name, v.name as vendor_name, v.store_name
        FROM orders o
        LEFT JOIN products p ON o.product_id = p.id
        LEFT JOIN vendors v ON o.vendor_id = v.vendor_id
        ORDER BY o.created_at DESC
    `).all();
    res.json(orders);
});

// ===== Vendor Registration =====
app.post('/api/vendor/register', (req, res) => {
    const { name, phone, store_name, info } = req.body;
    if (!name) return res.status(400).json({ error: 'الاسم مطلوب' });
    const vendorId = genVendorId();
    db.prepare('INSERT INTO vendors (vendor_id, name, phone, store_name, info) VALUES (?, ?, ?, ?, ?)')
        .run(vendorId, name, phone || '', store_name || '', info || '');
    res.json({ success: true, vendor_id: vendorId, name, store_name });
});

// ===== Vendor Dashboard =====
app.get('/api/vendor/info', (req, res) => {
    const vendor = db.prepare('SELECT * FROM vendors WHERE vendor_id = ?').get(req.headers['x-vendor-id']);
    if (!vendor) return res.status(404).json({ error: 'البائع غير موجود' });
    res.json(vendor);
});

app.post('/api/vendor/update', (req, res) => {
    const vid = req.headers['x-vendor-id'];
    const { name, phone, store_name, info } = req.body;
    db.prepare('UPDATE vendors SET name=?, phone=?, store_name=?, info=? WHERE vendor_id=?')
        .run(name, phone, store_name, info, vid);
    res.json({ success: true });
});

// Products
app.get('/api/vendor/products', (req, res) => {
    const products = db.prepare('SELECT * FROM products WHERE vendor_id = ? ORDER BY created_at DESC')
        .all(req.headers['x-vendor-id']);
    res.json(products);
});

app.post('/api/vendor/products', (req, res) => {
    const { name, price, quantity, description } = req.body;
    if (!name || price === undefined) return res.status(400).json({ error: 'اسم المنتج والسعر مطلوبان' });
    const r = db.prepare('INSERT INTO products (vendor_id, name, price, quantity, description) VALUES (?, ?, ?, ?, ?)')
        .run(req.headers['x-vendor-id'], name, parseFloat(price) || 0, parseInt(quantity) || 0, description || '');
    res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/vendor/products/:id', (req, res) => {
    const { name, price, quantity, description } = req.body;
    db.prepare('UPDATE products SET name=?, price=?, quantity=?, description=? WHERE id=? AND vendor_id=?')
        .run(name, parseFloat(price) || 0, parseInt(quantity) || 0, description || '', req.params.id, req.headers['x-vendor-id']);
    res.json({ success: true });
});

app.delete('/api/vendor/products/:id', (req, res) => {
    db.prepare('DELETE FROM products WHERE id=? AND vendor_id=?')
        .run(req.params.id, req.headers['x-vendor-id']);
    res.json({ success: true });
});

// Orders
app.get('/api/vendor/orders', (req, res) => {
    const orders = db.prepare(`
        SELECT o.*, p.name as product_name
        FROM orders o
        LEFT JOIN products p ON o.product_id = p.id
        WHERE o.vendor_id = ?
        ORDER BY o.created_at DESC
    `).all(req.headers['x-vendor-id']);
    res.json(orders);
});

app.post('/api/vendor/orders/status/:id', (req, res) => {
    const { status } = req.body;
    db.prepare('UPDATE orders SET status=? WHERE id=? AND vendor_id=?')
        .run(status, req.params.id, req.headers['x-vendor-id']);
    res.json({ success: true });
});

// ===== Chatbot API (used by n8n / WhatsApp) =====
// Search products across all vendors
app.get('/api/chat/products', (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);

    const products = db.prepare(`
        SELECT p.id, p.name, p.price, p.quantity, p.description,
               v.store_name, v.vendor_id
        FROM products p
        JOIN vendors v ON p.vendor_id = v.vendor_id
        WHERE p.quantity > 0 AND (p.name LIKE ? OR p.description LIKE ?)
        LIMIT 10
    `).all(`%${q}%`, `%${q}%`);

    res.json(products);
});

// Get single product
app.get('/api/chat/products/:id', (req, res) => {
    const product = db.prepare(`
        SELECT p.*, v.store_name, v.vendor_id
        FROM products p
        JOIN vendors v ON p.vendor_id = v.vendor_id
        WHERE p.id = ?
    `).get(req.params.id);
    if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });
    res.json(product);
});

// Place order (from chat)
app.post('/api/chat/order', (req, res) => {
    const { product_id, customer_name, customer_phone, quantity } = req.body;

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
    if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });
    if (product.quantity < (quantity || 1)) return res.status(400).json({ error: 'الكمية غير متوفرة' });

    // Decrease stock
    db.prepare('UPDATE products SET quantity = quantity - ? WHERE id = ?')
        .run(quantity || 1, product_id);

    // Create order
    const r = db.prepare('INSERT INTO orders (vendor_id, product_id, customer_name, customer_phone, quantity) VALUES (?, ?, ?, ?, ?)')
        .run(product.vendor_id, product_id, customer_name || '', customer_phone || '', quantity || 1);

    res.json({
        success: true,
        order_id: r.lastInsertRowid,
        product: product.name,
        remaining: product.quantity - (quantity || 1)
    });
});

// Get vendor by ID (for chat to return store info)
app.get('/api/chat/vendor/:vid', (req, res) => {
    const vendor = db.prepare('SELECT vendor_id, store_name, info FROM vendors WHERE vendor_id = ?').get(req.params.vid);
    if (!vendor) return res.status(404).json({ error: 'البائع غير موجود' });
    res.json(vendor);
});

// ===================== QR TOOL ROUTES =====================

app.get('/qr-tool', (req, res) => res.sendFile(path.join(__dirname, 'public', 'qr-tool.html')));
app.get('/qr-tool/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'qr-tool.html')));

app.get('/s', (req, res) => res.sendFile(path.join(__dirname, 'public', 'scan.html')));

function genCampCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  while (true) {
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    if (!db.prepare('SELECT 1 FROM qr_campaigns WHERE code = ?').get(code)) return code;
  }
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || '';
}

async function sendToN8n(data) {
  try {
    await fetch(N8N_QR_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'qr_scan', ...data, timestamp: new Date().toISOString() })
    });
  } catch (e) {
    console.error('[QR-TOOL] n8n webhook error:', e.message);
  }
}

app.post('/api/qr-tool/create', async (req, res) => {
  try {
    const { name, redirect, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'اسم الحملة مطلوب' });
    const code = genCampCode();
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const scanUrl = `${baseUrl}/s?c=${code}`;
    const qrBase64 = await QRCode.toDataURL(scanUrl, { width: 400, margin: 2, color: { dark: '#ff2d7b', light: '#06060e00' } });
    db.prepare('INSERT INTO qr_campaigns (code, name, redirect_url, notes) VALUES (?, ?, ?, ?)').run(code, name, redirect || '', notes || '');
    res.json({ success: true, id: code, code, scan_url: scanUrl, qr_base64: qrBase64 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/qr-tool/campaigns', (req, res) => {
  try {
    const camps = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM qr_scans WHERE campaign_code = c.code) as scans,
      (SELECT MAX(scanned_at) FROM qr_scans WHERE campaign_code = c.code) as last_scan
      FROM qr_campaigns c ORDER BY c.created_at DESC
    `).all();
    res.json(camps);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/qr-tool/campaign/:code', (req, res) => {
  try {
    const camp = db.prepare('SELECT * FROM qr_campaigns WHERE code = ?').get(req.params.code);
    if (!camp) return res.status(404).json({ error: 'غير موجود' });
    const scans = db.prepare('SELECT * FROM qr_scans WHERE campaign_code = ? ORDER BY scanned_at DESC').all(req.params.code);
    res.json({ ...camp, scans });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/qr-tool/scan', async (req, res) => {
  try {
    const { campaign_code, user_agent, browser, os, device, screen, language, platform, timezone, referrer } = req.body;
    const ip = getClientIp(req);
    let country = '', city = '';
    try {
      const geo = await fetch(`http://ip-api.com/json/${ip}?fields=country,city`);
      if (geo.ok) { const g = await geo.json(); country = g.country || ''; city = g.city || ''; }
    } catch {}
    const camp = db.prepare('SELECT * FROM qr_campaigns WHERE code = ?').get(campaign_code);
    db.prepare(`INSERT INTO qr_scans (campaign_code, ip, user_agent, browser, os, device, screen, language, platform, timezone, referrer, country, city, raw_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      campaign_code, ip, user_agent || '', browser || '', os || '', device || '', screen || '', language || '', platform || '', timezone || '', referrer || '', country, city, JSON.stringify(req.body)
    );
    const scanData = { campaign_code, ip, user_agent, browser, os, device, screen, language, platform, timezone, referrer, country, city };
    sendToN8n(scanData);
    res.json({ success: true, ip, country, city, redirect_url: camp?.redirect_url || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/qr-tool/scans', (req, res) => {
  try {
    const scans = db.prepare(`
      SELECT s.*, c.name as campaign_name FROM qr_scans s
      LEFT JOIN qr_campaigns c ON s.campaign_code = c.code
      ORDER BY s.scanned_at DESC LIMIT 100
    `).all();
    res.json(scans);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/qr-tool/scan/:id', (req, res) => {
  try {
    const scan = db.prepare(`
      SELECT s.*, c.name as campaign_name FROM qr_scans s
      LEFT JOIN qr_campaigns c ON s.campaign_code = c.code
      WHERE s.id = ?
    `).get(req.params.id);
    if (!scan) return res.status(404).json({ error: 'غير موجود' });
    try { scan.raw_data = JSON.parse(scan.raw_data || '{}'); } catch {}
    res.json(scan);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Start =====
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Admin & Vendor App running on http://0.0.0.0:${PORT}`);
});
