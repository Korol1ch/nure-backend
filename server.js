/**
 * NURE Shop Backend v3.0
 * - Локальное хранилище товаров (products.json)
 * - JWT Auth (users + admin)
 * - Product enrichment (photos, descriptions, colors)
 * - File uploads for product images
 * - Деактивация товаров: неделю показывается как "нет в наличии", потом удаляется
 */

const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════
//  КОНФИГ
// ══════════════════════════════════════
const JWT_SECRET   = process.env.JWT_SECRET || 'nure_secret_2025_change_in_production';
const ADMIN_EMAIL  = 'ismagulshakarim0909@gmail.com';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const ONE_WEEK_MS  = 7 * 24 * 60 * 60 * 1000;

// ══════════════════════════════════════
//  ХРАНИЛИЩЕ ДАННЫХ (JSON файлы)
// ══════════════════════════════════════
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

function readJSON(file, def = {}) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return def;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// Инициализация данных
function initData() {
  // Создать админа если нет
  const users = readJSON('users.json', []);
  if (!users.find(u => u.email === ADMIN_EMAIL)) {
    const hashed = bcrypt.hashSync('admin123', 10);
    users.push({
      id: uuidv4(), email: ADMIN_EMAIL, password: hashed,
      name: 'Ismagul', role: 'admin', createdAt: new Date().toISOString()
    });
    writeJSON('users.json', users);
    console.log('✅ Admin account created:', ADMIN_EMAIL, '/ password: admin123');
    console.log('   ⚠️  Смените пароль после первого входа!');
  }
  // Инициализация products.json если нет
  if (!fs.existsSync(path.join(DATA_DIR, 'products.json'))) {
    writeJSON('products.json', []);
  }
}

// ══════════════════════════════════════
//  АВТОУДАЛЕНИЕ ДЕАКТИВИРОВАННЫХ ТОВАРОВ
// ══════════════════════════════════════
function purgeExpiredProducts() {
  const products = readJSON('products.json', []);
  const now = Date.now();
  const filtered = products.filter(p => {
    if (p.deactivatedAt) {
      const elapsed = now - new Date(p.deactivatedAt).getTime();
      if (elapsed >= ONE_WEEK_MS) {
        // Удалить файлы изображений
        try {
          const imgDir = path.join(UPLOADS_DIR, p.slug || p.id);
          if (fs.existsSync(imgDir)) fs.rmSync(imgDir, { recursive: true });
        } catch {}
        console.log(`🗑️  Товар "${p.name}" удалён (прошла неделя после деактивации)`);
        return false;
      }
    }
    return true;
  });
  if (filtered.length !== products.length) {
    writeJSON('products.json', filtered);
  }
}

// Запускаем проверку раз в час
setInterval(purgeExpiredProducts, 60 * 60 * 1000);

// ══════════════════════════════════════
//  MIDDLEWARE
// ══════════════════════════════════════
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));

const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Не авторизован' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Токен недействителен' });
  }
}
function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });
    next();
  });
}

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const slug = req.params.slug || req.params.id || 'misc';
    const dir  = path.join(UPLOADS_DIR, slug);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ══════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════
app.get('/api', (req, res) => {
  res.json({ status: 'ok', service: 'NURE Backend v3.0', time: new Date().toISOString() });
});

// ══════════════════════════════════════
//  AUTH
// ══════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Заполните все поля' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    const users = readJSON('users.json', []);
    if (users.find(u => u.email === email)) return res.status(409).json({ error: 'Email уже зарегистрирован' });
    const hashed = await bcrypt.hash(password, 10);
    const user = { id: uuidv4(), email, password: hashed, name, role: 'user', createdAt: new Date().toISOString() };
    users.push(user);
    writeJSON('users.json', users);
    const token = jwt.sign({ id: user.id, email, name, role: 'user' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email, name, role: 'user' } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Введите email и пароль' });
    const users = readJSON('users.json', []);
    const user  = users.find(u => u.email === email);
    if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' });
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET, { expiresIn: '30d' }
    );
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const users = readJSON('users.json', []);
    const user  = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const ok = await bcrypt.compare(oldPassword, user.password);
    if (!ok) return res.status(401).json({ error: 'Неверный текущий пароль' });
    user.password = await bcrypt.hash(newPassword, 10);
    writeJSON('users.json', users);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════
//  ПУБЛИЧНЫЕ МАРШРУТЫ ТОВАРОВ
// ══════════════════════════════════════

// GET /api/products — только активные товары (isActive !== false)
app.get('/api/products', (req, res) => {
  purgeExpiredProducts();
  const products = readJSON('products.json', []);
  const visible = products
    .filter(p => p.isActive !== false)
    .map(p => ({
      ...p,
      outOfStock: !!p.deactivatedAt
    }));
  res.json({ success: true, products: visible });
});

// GET /api/products/:id — один товар
app.get('/api/products/:id', (req, res) => {
  const products = readJSON('products.json', []);
  const product  = products.find(p => p.id === req.params.id || p.slug === req.params.id);
  if (!product) return res.status(404).json({ error: 'Товар не найден' });
  res.json({ success: true, product: { ...product, outOfStock: !!product.deactivatedAt } });
});

// POST /api/order — создать заказ (сохраняем локально)
app.post('/api/order', authMiddleware, (req, res) => {
  try {
    const orders = readJSON('orders.json', []);
    const order  = {
      id: uuidv4(),
      userId: req.user.id,
      ...req.body,
      status: 'new',
      createdAt: new Date().toISOString()
    };
    orders.push(order);
    writeJSON('orders.json', orders);
    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════
//  ADMIN — ТОВАРЫ
// ══════════════════════════════════════

// GET /api/admin/products — все товары для админа (включая деактивированные)
app.get('/api/admin/products', adminMiddleware, (req, res) => {
  const products = readJSON('products.json', []);
  res.json({ success: true, products });
});

// POST /api/admin/products — создать товар
app.post('/api/admin/products', adminMiddleware, (req, res) => {
  try {
    const { name, price, category, description, badge, sizes, colors } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });

    const products = readJSON('products.json', []);
    const id   = uuidv4();
    const slug = slugify(name) + '-' + id.slice(0, 6);
    const product = {
      id, slug, name,
      price:       price || 0,
      category:    category || '',
      description: description || '',
      badge:       badge || '',
      sizes:       sizes || [],
      colors:      colors || [],
      images:      { default: [] },
      isActive:    true,
      createdAt:   new Date().toISOString()
    };
    products.push(product);
    writeJSON('products.json', products);
    res.json({ success: true, product });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/products/:id — редактировать товар
app.put('/api/admin/products/:id', adminMiddleware, (req, res) => {
  try {
    const products = readJSON('products.json', []);
    const idx = products.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Товар не найден' });

    const allowed = ['name', 'price', 'category', 'description', 'badge', 'sizes', 'colors'];
    allowed.forEach(key => {
      if (req.body[key] !== undefined) products[idx][key] = req.body[key];
    });
    products[idx].updatedAt = new Date().toISOString();
    writeJSON('products.json', products);
    res.json({ success: true, product: products[idx] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/products/:id/deactivate — деактивировать товар
app.post('/api/admin/products/:id/deactivate', adminMiddleware, (req, res) => {
  try {
    const products = readJSON('products.json', []);
    const idx = products.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Товар не найден' });

    products[idx].isActive     = false;
    products[idx].deactivatedAt = new Date().toISOString();
    writeJSON('products.json', products);
    console.log(`⏸️  Товар "${products[idx].name}" деактивирован — удалится через 7 дней`);
    res.json({ success: true, product: products[idx] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/products/:id/activate — реактивировать товар
app.post('/api/admin/products/:id/activate', adminMiddleware, (req, res) => {
  try {
    const products = readJSON('products.json', []);
    const idx = products.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Товар не найден' });

    products[idx].isActive      = true;
    delete products[idx].deactivatedAt;
    writeJSON('products.json', products);
    res.json({ success: true, product: products[idx] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/products/:id/images — загрузить фото
app.post('/api/admin/products/:id/images', adminMiddleware, upload.array('images', 10), (req, res) => {
  try {
    const products = readJSON('products.json', []);
    const idx = products.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Товар не найден' });

    const colorKey = req.body.colorKey || 'default';
    const baseUrl  = `${req.protocol}://${req.get('host')}`;
    const slug     = products[idx].slug || req.params.id;
    const urls     = req.files.map(f => `${baseUrl}/uploads/${slug}/${f.filename}`);

    if (!products[idx].images) products[idx].images = {};
    if (!products[idx].images[colorKey]) products[idx].images[colorKey] = [];
    products[idx].images[colorKey].push(...urls);
    writeJSON('products.json', products);
    res.json({ success: true, urls, colorKey });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/products/:id/images — удалить фото
app.delete('/api/admin/products/:id/images', adminMiddleware, (req, res) => {
  try {
    const { url, colorKey = 'default' } = req.body;
    const products = readJSON('products.json', []);
    const idx = products.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Товар не найден' });

    if (products[idx].images && products[idx].images[colorKey]) {
      products[idx].images[colorKey] = products[idx].images[colorKey].filter(u => u !== url);
      try {
        const slug     = products[idx].slug || req.params.id;
        const filename = path.basename(url);
        fs.unlinkSync(path.join(UPLOADS_DIR, slug, filename));
      } catch {}
      writeJSON('products.json', products);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/users
app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const users = readJSON('users.json', []).map(({ password, ...safe }) => safe);
  res.json({ users });
});

// GET /api/admin/orders
app.get('/api/admin/orders', adminMiddleware, (req, res) => {
  res.json({ orders: readJSON('orders.json', []) });
});

// ══════════════════════════════════════
//  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ══════════════════════════════════════
function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[а-яё]/g, c => {
      const map = {а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
      return map[c] || c;
    })
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .trim();
}

// SPA fallback
if (fs.existsSync(PUBLIC_DIR)) {
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    }
    res.status(404).json({ error: 'Not found' });
  });
}

// ══════════════════════════════════════
//  KEEP-ALIVE (Render free tier не засыпает)
// ══════════════════════════════════════
function startKeepAlive() {
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      const http = require('http');
      const https = require('https');
      const url = new URL(SELF_URL + '/api');
      const client = url.protocol === 'https:' ? https : http;
      client.get(url.href, (res) => {
        console.log(`💓 Keep-alive ping → ${res.statusCode}`);
        res.resume();
      }).on('error', (err) => {
        console.log(`⚠️  Keep-alive ошибка: ${err.message}`);
      });
    } catch (e) {
      console.log('⚠️  Keep-alive ошибка:', e.message);
    }
  }, 14 * 60 * 1000); // каждые 14 минут
  console.log('   💓 Keep-alive активирован (пинг каждые 14 мин)');
}

// ══════════════════════════════════════
//  ЗАПУСК
// ══════════════════════════════════════
initData();
purgeExpiredProducts();
app.listen(PORT, () => {
  console.log(`\n🚀 NURE Backend запущен на порту ${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api`);
  console.log(`   Admin: ${ADMIN_EMAIL}`);
  startKeepAlive();
});
