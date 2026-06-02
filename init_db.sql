-- Customer Service AI - Database Schema
-- SQLite initialization script

CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL CHECK(platform IN ('whatsapp','instagram')),
    external_id TEXT NOT NULL,
    name TEXT,
    language TEXT DEFAULT 'ar',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform, external_id)
);

CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    message_id TEXT UNIQUE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    intent TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    order_number TEXT UNIQUE,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','confirmed','shipped','delivered','cancelled','returned')),
    total REAL,
    items TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customers_platform ON customers(platform, external_id);
CREATE INDEX IF NOT EXISTS idx_conversations_customer ON conversations(customer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_msgid ON conversations(message_id);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);

-- Sample Knowledge Base
CREATE TABLE IF NOT EXISTS knowledge_base (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    keywords TEXT,
    language TEXT DEFAULT 'ar',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO knowledge_base (category, question, answer, keywords, language) VALUES
('pricing', 'what is the price', 'تختلف الأسعار حسب المنتج. يبدأ سعر منتجاتنا من ٥٠ ريال سعودي. هل تفضل تصفح قائمة الأسعار كاملة؟', 'سعر,price,كم,تكلفة,cost', 'ar'),
('hours', 'what are your working hours', 'أوقات العمل: السبت إلى الخميس من ٩ صباحاً إلى ١٠ مساءً. الجمعة إجازة.', 'ساعات,working hours,مواعيد,دوام,وقت', 'ar'),
('return', 'what is your return policy', 'سياسة الاسترجاع: يمكن إرجاع المنتجات خلال ١٤ يوماً من تاريخ الشراء بشرط أن تكون بحالتها الأصلية. يتم استرداد المبلغ خلال ٥-٧ أيام عمل.', 'استرجاع,return,مرتجع, refund,استبدال', 'ar'),
('delivery', 'how long does delivery take', 'مدة التوصيل: داخل المدينة ١-٢ يوم عمل، خارج المدينة ٣-٥ أيام عمل. التوصيل مجاني للطلبات فوق ٢٠٠ ريال.', 'توصيل,delivery,شحن,shipping,وصل', 'ar');
