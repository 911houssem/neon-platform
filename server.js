const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 4000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '10032008';

// Evolution API config
const EVO_URL = process.env.EVOLUTION_API_URL || 'http://evolution-api:8080';
const EVO_KEY = process.env.EVOLUTION_API_KEY || '123456';
const N8N_URL = process.env.N8N_WEBHOOK_URL || 'http://n8n:5678/webhook/customer-service';
const N8N_QR_WEBHOOK = process.env.N8N_QR_WEBHOOK_URL || 'http://n8n:5678/webhook/qr-scan';
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
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
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

const VERIFIED_PHONES = new Set();

app.post('/api/register', async (req, res) => {
  const { name, phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'رقم الهاتف مطلوب' });
  const code = String(Math.floor(1000 + Math.random() * 9000)).padStart(4, '0');
  db.prepare('DELETE FROM registration_codes WHERE phone = ?').run(phone);
  db.prepare('INSERT INTO registration_codes (phone, code) VALUES (?, ?)').run(phone, code);

  // Send code via WhatsApp using Evolution API
  try {
    const data = await (await fetch(`${EVO_URL}/instance/fetchInstances`, { headers: evoHeaders })).json();
    const list = Array.isArray(data) ? data : (data.value || []);
    const openInst = list.find(i => i.instance?.status === 'open');
    if (openInst) {
      const instName = openInst.instance.instanceName;
      const digits = phone.replace(/\D/g, '');
      const clean = digits.replace(/^0+/, '');
      const recipient = clean.startsWith('213') ? clean : '213' + clean;
      await fetch(`${EVO_URL}/message/sendText/${instName}`, {
        method: 'POST', headers: evoHeaders,
        body: JSON.stringify({ number: recipient, textMessage: { text: `🔐 رمز التوثيق الخاص بك:\n\n${code}\n\nأدخل هذا الرمز في التطبيق لإكمال التسجيل.` } })
      });
    }
  } catch (e) { console.error('[REGISTER] WhatsApp error:', e.message); }

  console.log(`[REGISTER] Verification code for ${phone}: ${code}`);
  res.json({ success: true, message: 'تم إرسال الكود عبر واتساب' });
});

app.post('/api/register/verify-code', (req, res) => {
  const { code, phone } = req.body;
  const record = db.prepare('SELECT * FROM registration_codes WHERE phone = ? AND code = ?').get(phone, code);
  if (!record) return res.status(400).json({ error: 'رمز غير صحيح' });
  db.prepare('DELETE FROM registration_codes WHERE phone = ?').run(phone);
  VERIFIED_PHONES.add(phone);
  res.json({ success: true, verified: true });
});

app.post('/api/register/complete', (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'بيانات ناقصة' });
  if (!VERIFIED_PHONES.has(phone)) return res.status(400).json({ error: 'يرجى توثيق الرقم أولاً' });
  const vid = genVendorId();
  db.prepare('INSERT INTO vendors (vendor_id, name, phone, password, status) VALUES (?, ?, ?, ?, ?)').run(vid, name, phone, password || '', 'active');
  VERIFIED_PHONES.delete(phone);
  res.json({ success: true, vendor_id: vid, token: vid });
});

// ===================== CHATBOT API =====================

app.post('/api/chat/message', (req, res) => {
  const { message, phone, name, context } = req.body;
  if (!message) return res.status(400).json({ error: 'الرسالة مطلوبة' });

  const msg = message.trim();
  let reply = '';

  // Search products
  const products = db.prepare(`SELECT p.name, p.price, p.description, v.store_name FROM products p JOIN vendors v ON p.vendor_id = v.vendor_id WHERE p.quantity > 0 AND (p.name LIKE ? OR p.description LIKE ?) LIMIT 5`).all(`%${msg}%`, `%${msg}%`);

  if (products.length > 0) {
    reply = '🛍️ وجدت هذه المنتجات:\n' + products.map((p, i) => `${i+1}. ${p.name} (${p.store_name}) - ${p.price} د.ج`).join('\n');
  } else if (/^(السلام|مرحبا|hi|hello|مرحباً)/i.test(msg)) {
    reply = `وعليكم السلام ${name}! 👋\nأنا المساعد الذكي. أستطيع:\n🔍 البحث عن منتجات\n🛒 تقديم طلبات\n📞 مساعدتك في أي استفسار`;
  } else if (/^(شكراً|شكرا|thanks|ok|تمام)/i.test(msg)) {
    reply = 'العفو! 😊 في خدمتك دائماً. هل تريد شيئاً آخر؟';
  } else if (/^(منتجات|عروض|what do you have)/i.test(msg)) {
    const all = db.prepare(`SELECT p.name, p.price, v.store_name FROM products p JOIN vendors v ON p.vendor_id = v.vendor_id WHERE p.quantity > 0 LIMIT 10`).all();
    if (all.length > 0) reply = '📋 قائمة المنتجات المتوفرة:\n' + all.map((p, i) => `${i+1}. ${p.name} (${p.store_name}) - ${p.price} د.ج`).join('\n');
    else reply = '🚫 لا توجد منتجات متوفرة حالياً.';
  } else if (/سعر|كم\s?ثمن|price/i.test(msg)) {
    const prod = db.prepare(`SELECT p.name, p.price, p.description, v.store_name FROM products p JOIN vendors v ON p.vendor_id = v.vendor_id WHERE p.quantity > 0 AND p.name LIKE ? LIMIT 1`).all(`%${msg.replace(/سعر|كم\s?ثمن/g,'').trim()}%`);
    if (prod.length > 0) reply = `💰 ${prod[0].name}\nالسعر: ${prod[0].price} د.ج\nالمتجر: ${prod[0].store_name}`;
    else reply = 'لم أجد المنتج. جرب اسم آخر 🔍';
  } else if (/طلب|أطلب|شراء/i.test(msg)) {
    reply = '✅ لطلب منتج، أرسل اسم المنتج وكميته وسيتم تأكيد الطلب.';
  } else {
    reply = '🤖 شكراً لرسالتك! سأحاول مساعدتك.\nيمكنك البحث عن منتجات أو طلب المساعدة.';
  }

  res.json({ reply });
});

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

// ===================== QR TOOL ROUTES =====================

app.use('/qr-tool', express.static(path.join(__dirname, 'qr-tool', 'public')));
app.get('/qr-tool', (req, res) => res.sendFile(path.join(__dirname, 'qr-tool', 'public', 'index.html')));
app.get('/qr-tool/*', (req, res) => res.sendFile(path.join(__dirname, 'qr-tool', 'public', 'index.html')));

app.get('/s', (req, res) => res.sendFile(path.join(__dirname, 'qr-tool', 'public', 'scan.html')));

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

// ===== Static fallback =====
app.get(['/admin', '/admin.html'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/vendor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vendor.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/', (req, res) => res.redirect('/admin'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Neon Platform running on http://0.0.0.0:${PORT}`);
});
