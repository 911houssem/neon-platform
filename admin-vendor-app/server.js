const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = 4000;
const ADMIN_PASSWORD = '10032008';

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

// ===== Start =====
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Admin & Vendor App running on http://0.0.0.0:${PORT}`);
});
