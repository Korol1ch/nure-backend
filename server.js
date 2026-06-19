/**
 * NURE Shop Backend v4.0
 * - Реальная интеграция с Paloma365 (метод guide2xml / таблица s_items)
 * - Товары (название, цена, описание, категория) подтягиваются из Paloma365 в реальном времени
 * - Admin добавляет "поверх" товара: фото, цвета, размеры, бейдж, описание-переопределение,
 *   видимость в каталоге (т.к. Paloma365 не отдаёт остатки без индивидуальной настройки —
 *   см. комментарий у fetchPalomaStock ниже)
 * - JWT Auth (users + admin)
 * - Локальные заказы (orders.json)
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

const PALOMA_API_KEY  = process.env.PALOMA_API_KEY || 'efdd95a2708c19ecdeb3d21bac81b834nure29007';
const PALOMA_BASE_URL = 'https://api.paloma365.com/company/api/';
const PALOMA_CACHE_TTL_MS = 5 * 60 * 1000; // обновляем кэш товаров раз в 5 минут

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

function initData() {
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
  if (!fs.existsSync(path.join(DATA_DIR, 'enrichments.json'))) {
    writeJSON('enrichments.json', {});
  }
}

// ══════════════════════════════════════
//  PALOMA365 — ПОЛУЧЕНИЕ ТОВАРОВ
// ══════════════════════════════════════
// Документация: https://help.paloma365.com/knowledgebase/api-dok/
// Реальный метод (используется в их официальных примерах для 1С/сайтов):
//   GET https://api.paloma365.com/company/api/?class=guide2xml&method=to_file
//       &tables[0]=s_items&output_format=json&authkey=AUTHKEY
// Ответ: { "s_items": { "<id>": { name, price, description, articul, parentid, isgroup, ... } } }
// Товары — это записи с isgroup="0", категории (группы) — записи с isgroup="1",
// у товара "parentid" указывает на UID его категории.

let palomaCache = { products: [], categories: {}, fetchedAt: 0, lastError: null };

function cleanNull(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' && v.trim().toUpperCase() === 'NULL') return '';
  return typeof v === 'string' ? v.trim() : v;
}

async function fetchPalomaRaw() {
  const url = `${PALOMA_BASE_URL}?class=guide2xml&method=to_file&tables%5B0%5D=s_items&output_format=json&authkey=${encodeURIComponent(PALOMA_API_KEY)}`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const response = await fetch(url, { signal: ctrl.signal });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); }
    catch { throw new Error('Paloma365 вернула не-JSON ответ (возможно неверный authkey или метод недоступен): ' + text.slice(0, 300)); }
    if (json && json.errors) throw new Error('Paloma365 API: ' + json.errors);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ⚠️ ОСТАТКИ (наличие на складе)
// Paloma365 не отдаёт остатки через guide2xml/s_items. Согласно официальному сайту
// Paloma365 ("Выгрузка данных из Paloma365 в интернет-магазин: Наименование, Стоимость,
// Остатки — интеграция требует индивидуальной настройки"), для остатков нужно отдельно
// согласовать с поддержкой Paloma365 (help@paloma365.com / WhatsApp в их Help-центре)
// конкретный метод API для вашего аккаунта — по аналогии с их методом для Kaspi Магазина
// (class=dev7\KaspiRemains). Когда вам выдадут такой метод — впишите его сюда,
// и в getPalomaCatalog() ниже останется добавить пару строк для подмешивания остатков.
async function fetchPalomaStock() {
  return null; // пока не подключено
}

async function getPalomaCatalog(force = false) {
  const now = Date.now();
  if (!force && palomaCache.products.length && (now - palomaCache.fetchedAt) < PALOMA_CACHE_TTL_MS) {
    return palomaCache;
  }
  try {
    const raw   = await fetchPalomaRaw();
    const items = (raw && raw.s_items) || {};

    const categories = {};
    for (const it of Object.values(items)) {
      if (String(it.isgroup) === '1') categories[it.UID] = cleanNull(it.name);
    }

    const products = [];
    for (const [key, it] of Object.entries(items)) {
      if (String(it.isgroup) === '1') continue; // это категория, не товар
      products.push({
        palomaId:     key,
        uid:          it.UID || key,
        name:         cleanNull(it.name) || 'Без названия',
        price:        parseFloat(it.price) || 0,
        description:  cleanNull(it.description),
        articul:      cleanNull(it.articul),
        barcode:      cleanNull(it.mainShtrih),
        categoryUid:  it.parentid,
        categoryName: categories[it.parentid] || '',
      });
    }

    palomaCache = { products, categories, fetchedAt: now, lastError: null };
    return palomaCache;
  } catch (err) {
    palomaCache.lastError = err.message;
    if (palomaCache.products.length) {
      // Paloma недоступна — отдаём то, что было закэшировано раньше, чтобы сайт не падал
      return palomaCache;
    }
    throw err;
  }
}

// ══════════════════════════════════════
//  ОБЪЕДИНЕНИЕ: Paloma365 + ручные данные админа (enrichments.json)
// ══════════════════════════════════════
function mergeProduct(p, enrich) {
  enrich = enrich || {};
  return {
    id:           p.palomaId,
    articul:      p.articul,
    name:         p.name,
    price:        p.price,
    description:  enrich.description ? enrich.description : p.description,
    category:     enrich.category || p.categoryName || '',
    palomaCategory: p.categoryName || '',
    badge:        enrich.badge || '',
    sizes:        enrich.sizes || [],
    colors:       enrich.colors || [],
    images:       enrich.images || { default: [] },
    hidden:       !!enrich.hidden,
    hasPhotos:    !!(enrich.images && Object.values(enrich.images).some(arr => Array.isArray(arr) && arr.length)),
    updatedAt:    enrich.updatedAt || null,
  };
}

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
    const slug = req.params.id || 'misc';
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
  res.json({ status: 'ok', service: 'NURE Backend v4.0', time: new Date().toISOString() });
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
//  ПУБЛИЧНЫЕ МАРШРУТЫ ТОВАРОВ (из Paloma365 + enrichments)
// ══════════════════════════════════════

app.get('/api/products', async (req, res) => {
  try {
    const catalog     = await getPalomaCatalog();
    const enrichments = readJSON('enrichments.json', {});
    const products = catalog.products
      .filter(p => !(enrichments[p.palomaId] && enrichments[p.palomaId].hidden))
      .map(p => mergeProduct(p, enrichments[p.palomaId]));
    res.json({
      success: true,
      products,
      syncedAt: catalog.fetchedAt,
      offline: !!catalog.lastError
    });
  } catch (err) {
    res.status(503).json({ success: false, error: 'Не удалось получить товары из Paloma365: ' + err.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const catalog = await getPalomaCatalog();
    const p = catalog.products.find(x => x.palomaId === req.params.id || x.articul === req.params.id);
    if (!p) return res.status(404).json({ error: 'Товар не найден' });
    const enrichments = readJSON('enrichments.json', {});
    res.json({ success: true, product: mergeProduct(p, enrichments[p.palomaId]) });
  } catch (err) {
    res.status(503).json({ success: false, error: 'Не удалось получить товар из Paloma365: ' + err.message });
  }
});

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
//  ADMIN — ТОВАРЫ (только "обогащение" Paloma-товаров, без ручного создания)
// ══════════════════════════════════════

// GET /api/admin/products — все товары из Paloma + статус синхронизации
app.get('/api/admin/products', adminMiddleware, async (req, res) => {
  try {
    const catalog      = await getPalomaCatalog();
    const enrichments  = readJSON('enrichments.json', {});
    const products = catalog.products.map(p => mergeProduct(p, enrichments[p.palomaId]));
    res.json({
      success: true,
      products,
      syncedAt: catalog.fetchedAt,
      lastError: catalog.lastError
    });
  } catch (err) {
    res.status(503).json({ success: false, error: 'Не удалось получить товары из Paloma365: ' + err.message });
  }
});

// POST /api/admin/sync — принудительно обновить кэш товаров из Paloma365
app.post('/api/admin/sync', adminMiddleware, async (req, res) => {
  try {
    const catalog = await getPalomaCatalog(true);
    res.json({ success: true, count: catalog.products.length, syncedAt: catalog.fetchedAt });
  } catch (err) {
    res.status(503).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/products/:id — обновить "обогащение" товара (фото НЕ здесь, см. ниже)
app.put('/api/admin/products/:id', adminMiddleware, async (req, res) => {
  try {
    const { description, category, badge, sizes, colors, hidden } = req.body;
    const enrichments = readJSON('enrichments.json', {});
    const current = enrichments[req.params.id] || {};
    enrichments[req.params.id] = {
      ...current,
      ...(description !== undefined && { description }),
      ...(category    !== undefined && { category }),
      ...(badge       !== undefined && { badge }),
      ...(sizes       !== undefined && { sizes }),
      ...(colors      !== undefined && { colors }),
      ...(hidden      !== undefined && { hidden }),
      updatedAt: new Date().toISOString()
    };
    writeJSON('enrichments.json', enrichments);

    let product;
    try {
      const catalog = await getPalomaCatalog();
      const p = catalog.products.find(x => x.palomaId === req.params.id);
      product = p ? mergeProduct(p, enrichments[req.params.id]) : null;
    } catch { /* Paloma временно недоступна — данные уже сохранены, просто не можем обогатить ответ */ }
    if (!product) product = { id: req.params.id, ...enrichments[req.params.id] };

    res.json({ success: true, product });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/products/:id/images — загрузить фото товара
app.post('/api/admin/products/:id/images', adminMiddleware, upload.array('images', 10), (req, res) => {
  try {
    const colorKey = req.body.colorKey || 'default';
    const baseUrl  = `${req.protocol}://${req.get('host')}`;
    const urls     = req.files.map(f => `${baseUrl}/uploads/${req.params.id}/${f.filename}`);

    const enrichments = readJSON('enrichments.json', {});
    const enrich = enrichments[req.params.id] || {};
    if (!enrich.images) enrich.images = {};
    if (!enrich.images[colorKey]) enrich.images[colorKey] = [];
    enrich.images[colorKey].push(...urls);
    enrich.updatedAt = new Date().toISOString();
    enrichments[req.params.id] = enrich;
    writeJSON('enrichments.json', enrichments);

    res.json({ success: true, urls, colorKey });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/products/:id/images — удалить фото
app.delete('/api/admin/products/:id/images', adminMiddleware, (req, res) => {
  try {
    const { url, colorKey = 'default' } = req.body;
    const enrichments = readJSON('enrichments.json', {});
    const enrich = enrichments[req.params.id] || {};
    if (enrich.images && enrich.images[colorKey]) {
      enrich.images[colorKey] = enrich.images[colorKey].filter(u => u !== url);
      try {
        const filename = path.basename(url);
        fs.unlinkSync(path.join(UPLOADS_DIR, req.params.id, filename));
      } catch {}
      enrich.updatedAt = new Date().toISOString();
      enrichments[req.params.id] = enrich;
      writeJSON('enrichments.json', enrichments);
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
//  ЗАПУСК
// ══════════════════════════════════════
initData();
getPalomaCatalog().then(
  c => console.log(`✅ Paloma365: загружено ${c.products.length} товаров`),
  e => console.warn('⚠️  Paloma365 пока недоступна при старте:', e.message, '— сайт попробует снова при первом запросе')
);
app.listen(PORT, () => {
  console.log(`\n🚀 NURE Backend запущен на порту ${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api`);
  console.log(`   Admin: ${ADMIN_EMAIL}`);
});
