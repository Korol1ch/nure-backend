/**
 * NURE Shop Backend v5.0
 * - Группировка товаров Paloma365 по иерархии (stub-модель → варианты цвет/размер)
 * - Admin добавляет "поверх": фото, бейдж, описание
 * - JWT Auth, локальные заказы
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

const JWT_SECRET   = process.env.JWT_SECRET || 'nure_secret_2025_change_in_production';
const ADMIN_EMAIL  = 'ismagulshakarim0909@gmail.com';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';

const PALOMA_API_KEY  = process.env.PALOMA_API_KEY || 'efdd95a2708c19ecdeb3d21bac81b834nure29007';
const PALOMA_BASE_URL = 'https://api.paloma365.com/company/api/';
const PALOMA_CACHE_TTL_MS = 5 * 60 * 1000;

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
  }
  if (!fs.existsSync(path.join(DATA_DIR, 'enrichments.json'))) {
    writeJSON('enrichments.json', {});
  }
}

// ══════════════════════════════════════
//  PALOMA365 FETCH
// ══════════════════════════════════════

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
    catch { throw new Error('Paloma365 вернула не-JSON: ' + text.slice(0, 300)); }
    if (json && json.errors) throw new Error('Paloma365 API: ' + json.errors);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ══════════════════════════════════════
//  ГРУППИРОВКА ТОВАРОВ
//
//  Иерархия Paloma: Категория → Бренд → Модель (stub, isgroup=0, имеет дочерние SKU)
//                                               → SKU (isgroup=0, нет детей, название = "Модель Размер Цвет")
//
//  Алгоритм:
//  1. Все записи: isgroup=1 — папки/категории, isgroup=0 — либо stub-модели, либо листья-SKU
//  2. Строим Set<UID> тех isgroup=0 записей, у которых есть хотя бы один ребёнок → это stub-модели
//  3. Для каждого stub: собираем дочерние SKU, парсим из имени цвет и размер
//  4. Остатки листьев без stub-родителя — оставляем как отдельные товары (аксессуары и т.п.)
// ══════════════════════════════════════

// Популярные цвета на русском для извлечения из названия
const KNOWN_COLORS = [
  'Розовый','Чёрный','Черный','Белый','Голубой','Синий','Красный','Серый','Бежевый',
  'Коричневый','Хаки','Лимонный','Зеленый','Зелёный','Пудровый','Айвори','Оливковый',
  'Бордовый','Тауп','Мятный','Фиолетовый','Оранжевый','Желтый','Жёлтый'
];
// Популярные размеры
const KNOWN_SIZES = [
  'XS','S-M','M-L','S','M','L','XL','XXL','XXXL','STANDART','STANDARTS','+'
];

function parseSizeColor(name) {
  // Пробуем выделить цвет и размер из конца строки
  // Например: "Clothe блузка бохо S Пудровый" → size=S, color=Пудровый
  let color = '';
  let size  = '';

  // Ищем цвет (может быть последним словом)
  for (const c of KNOWN_COLORS) {
    if (name.endsWith(' ' + c) || name.endsWith(' ' + c.toLowerCase())) {
      color = c;
      name = name.slice(0, name.length - c.length - 1).trim();
      break;
    }
    // Регистронезависимо
    const re = new RegExp('\\s' + c + '$', 'i');
    if (re.test(name)) {
      color = c;
      name = name.replace(re, '').trim();
      break;
    }
  }

  // Ищем размер (в конце оставшегося, после удаления цвета)
  for (const s of KNOWN_SIZES) {
    if (name.endsWith(' ' + s)) {
      size = s;
      name = name.slice(0, name.length - s.length - 1).trim();
      break;
    }
  }

  return { baseName: name, size, color };
}

function groupPalomaItems(items) {
  // items — объект { key: { UID, isgroup, parentid, name, price, ... } }

  // 1. Строим карту UID → запись
  const byUid = {};
  for (const [key, it] of Object.entries(items)) {
    byUid[it.UID || key] = { ...it, _key: key };
  }

  // 2. Находим UID всех записей isgroup=0, которые являются родителями для других isgroup=0
  //    т.е. stub-модели (у них isgroup=0, но на них ссылаются другие через parentid)
  const stubUids = new Set();
  for (const it of Object.values(items)) {
    if (String(it.isgroup) === '0' && it.parentid && byUid[it.parentid]) {
      const parent = byUid[it.parentid];
      if (String(parent.isgroup) === '0') {
        stubUids.add(it.parentid);
      }
    }
  }

  // 3. Находим категории (isgroup=1) — строим путь для каждого stub/sku
  function getCategoryPath(uid) {
    const visited = new Set();
    const parts = [];
    let cur = uid;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      const rec = byUid[cur];
      if (!rec) break;
      if (String(rec.isgroup) === '1') parts.unshift(cleanNull(rec.name));
      cur = rec.parentid;
    }
    return parts;
  }

  // 4. Группируем SKU под stub-модели
  const groups = {}; // stubUid → { stub, skus: [] }

  for (const [key, it] of Object.entries(items)) {
    if (String(it.isgroup) === '1') continue; // папки — пропускаем
    const uid = it.UID || key;

    if (stubUids.has(uid)) {
      // Это stub-модель
      if (!groups[uid]) groups[uid] = { stub: it, _key: key, skus: [] };
      else groups[uid].stub = it;
      continue;
    }

    // Это SKU или самостоятельный товар
    const parentUid = it.parentid;
    if (parentUid && stubUids.has(parentUid)) {
      // Дочерний SKU под stub
      if (!groups[parentUid]) groups[parentUid] = { stub: byUid[parentUid], _key: parentUid, skus: [] };
      groups[parentUid].skus.push({ ...it, _key: key });
    }
    // (одиночные без stub-родителя обработаем ниже)
  }

  // 5. Формируем итоговый массив продуктов
  const products = [];

  // Обработка stub-групп
  for (const [stubUid, group] of Object.entries(groups)) {
    const stub = group.stub;
    if (!stub) continue;

    // Категория — путь через isgroup=1 предков
    const catPath = getCategoryPath(stub.parentid || stub.UID);

    // Если нет SKU — одиночный товар (stub без детей)
    if (group.skus.length === 0) {
      products.push({
        palomaId:    group._key || stubUid,
        uid:         stubUid,
        name:        cleanNull(stub.name) || 'Без названия',
        price:       parseFloat(stub.price) || 0,
        description: cleanNull(stub.description),
        articul:     cleanNull(stub.articul),
        barcode:     cleanNull(stub.mainShtrih),
        categoryName: catPath.join(' / '),
        variants:    [], // нет вариантов
      });
      continue;
    }

    // Собираем варианты из SKU
    // Группируем по цвету → размеры
    const colorMap = {}; // color → { price, sizes: Set, skuIds: [] }

    for (const sku of group.skus) {
      const { baseName, size, color } = parseSizeColor(cleanNull(sku.name));
      const colorKey = color || 'Без цвета';
      if (!colorMap[colorKey]) {
        colorMap[colorKey] = {
          color:  colorKey,
          price:  parseFloat(sku.price) || parseFloat(stub.price) || 0,
          sizes:  [],
          skuIds: [],
        };
      }
      if (size && !colorMap[colorKey].sizes.includes(size)) {
        colorMap[colorKey].sizes.push(size);
      }
      colorMap[colorKey].skuIds.push(sku._key);
    }

    const variants = Object.values(colorMap);

    // Цена продукта — минимальная среди вариантов (или цена stub)
    const prices = variants.map(v => v.price).filter(p => p > 0);
    const minPrice = prices.length ? Math.min(...prices) : (parseFloat(stub.price) || 0);

    products.push({
      palomaId:    group._key || stubUid,
      uid:         stubUid,
      name:        cleanNull(stub.name) || 'Без названия',
      price:       minPrice,
      description: cleanNull(stub.description),
      articul:     cleanNull(stub.articul),
      barcode:     cleanNull(stub.mainShtrih),
      categoryName: catPath.join(' / '),
      variants,    // [{ color, price, sizes: [], skuIds: [] }]
    });
  }

  // 6. Одиночные товары (isgroup=0, без stub-родителя, сами не stub)
  for (const [key, it] of Object.entries(items)) {
    if (String(it.isgroup) === '1') continue;
    const uid = it.UID || key;
    if (stubUids.has(uid)) continue; // уже обработан как stub
    const parentUid = it.parentid;
    if (parentUid && stubUids.has(parentUid)) continue; // уже обработан как SKU под stub

    // Проверяем: родитель — папка (isgroup=1)? Тогда это одиночный товар
    const catPath = getCategoryPath(parentUid);
    products.push({
      palomaId:    key,
      uid:         uid,
      name:        cleanNull(it.name) || 'Без названия',
      price:       parseFloat(it.price) || 0,
      description: cleanNull(it.description),
      articul:     cleanNull(it.articul),
      barcode:     cleanNull(it.mainShtrih),
      categoryName: catPath.join(' / '),
      variants:    [],
    });
  }

  return products;
}

// ══════════════════════════════════════
//  ОТСЛЕЖИВАНИЕ "НЕДАВНО ДОБАВЛЕННЫХ" ТОВАРОВ
//
//  Paloma365 не отдаёт дату создания товара, поэтому отслеживаем сами:
//  при каждой синхронизации сверяем список palomaId с тем, что видели раньше
//  (data/product-history.json). Новые id получают текущую метку времени —
//  именно её используем как "дата добавления" для сортировки "Новинки".
//
//  Особый случай — самый первый запуск (файл истории пуст): чтобы не считать
//  весь существующий каталог "добавленным только что" одной пачкой, раздаём
//  товарам по порядку из Paloma бэкдатированные метки (последний в списке —
//  самый "свежий"). Любой товар, появившийся уже ПОСЛЕ этого момента,
//  получит реальное now() и автоматически окажется выше бэкдатированных.
// ══════════════════════════════════════
function trackProductHistory(products) {
  const history = readJSON('product-history.json', {});
  const isBootstrap = Object.keys(history).length === 0;
  const now = Date.now();
  let changed = false;
  const currentIds = new Set();

  products.forEach((p, idx) => {
    currentIds.add(p.palomaId);
    if (!history[p.palomaId]) {
      history[p.palomaId] = isBootstrap
        ? now - (products.length - idx) * 1000   // псевдо-хронология по порядку каталога
        : now;                                     // реально новый товар — метка "сейчас"
      changed = true;
    }
  });

  // Чистим историю от товаров, которых больше нет в каталоге Paloma
  for (const id of Object.keys(history)) {
    if (!currentIds.has(id)) { delete history[id]; changed = true; }
  }

  if (changed) writeJSON('product-history.json', history);
  return history;
}

async function getPalomaCatalog(force = false) {
  const now = Date.now();
  if (!force && palomaCache.products.length && (now - palomaCache.fetchedAt) < PALOMA_CACHE_TTL_MS) {
    return palomaCache;
  }
  try {
    const raw  = await fetchPalomaRaw();
    const items = (raw && raw.s_items) || {};
    const products = groupPalomaItems(items);

    // Помечаем каждый товар временем первого появления в нашей системе
    const history = trackProductHistory(products);
    products.forEach(p => { p.addedAt = history[p.palomaId] || now; });

    // Собираем категории для фильтров
    const categories = {};
    for (const it of Object.values(items)) {
      if (String(it.isgroup) === '1') categories[it.UID] = cleanNull(it.name);
    }

    palomaCache = { products, categories, fetchedAt: now, lastError: null };
    return palomaCache;
  } catch (err) {
    palomaCache.lastError = err.message;
    if (palomaCache.products.length) return palomaCache;
    throw err;
  }
}

// ══════════════════════════════════════
//  MERGE: Paloma + enrichments
// ══════════════════════════════════════
function mergeProduct(p, enrich) {
  enrich = enrich || {};

  // Маппим variants → colors в формат, совместимый с фронтендом
  // Фронт ожидает: colors[i].name, colors[i].key, colors[i].sizes, colors[i].images
  const colors = (p.variants || []).map(v => ({
    name:   v.color,
    key:    v.color,
    sizes:  v.sizes || [],
    price:  v.price || p.price,
    images: (enrich.images && enrich.images[v.color]) ? enrich.images[v.color] : [],
  }));

  // Первое фото для обложки (из первого цвета или default)
  const defaultImages = (enrich.images && enrich.images.default) ? enrich.images.default
    : (colors.length && colors[0].images.length) ? colors[0].images
    : [];

  return {
    id:           p.palomaId,
    uid:          p.uid,
    articul:      p.articul,
    name:         p.name,
    price:        p.price,
    description:  enrich.description ? enrich.description : p.description,
    category:     enrich.category || p.categoryName || '',
    palomaCategory: p.categoryName || '',
    badge:        enrich.badge || '',
    colors,                            // [{name, key, sizes, price, images}]
    images:       { ...((enrich.images)||{}), default: defaultImages },
    hidden:       !!enrich.hidden,
    hasPhotos:    !!(colors.some(c => c.images.length) || defaultImages.length),
    updatedAt:    enrich.updatedAt || null,
    addedAt:      p.addedAt || null,
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
//  ROUTES
// ══════════════════════════════════════

app.get('/api', (req, res) => {
  res.json({ status: 'ok', service: 'NURE Backend v5.0', time: new Date().toISOString() });
});

// AUTH
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

// ПУБЛИЧНЫЕ ТОВАРЫ
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
    res.status(503).json({ success: false, error: 'Не удалось получить товар: ' + err.message });
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

// ADMIN ТОВАРЫ
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

app.post('/api/admin/sync', adminMiddleware, async (req, res) => {
  try {
    const catalog = await getPalomaCatalog(true);
    res.json({ success: true, count: catalog.products.length, syncedAt: catalog.fetchedAt });
  } catch (err) {
    res.status(503).json({ success: false, error: err.message });
  }
});

app.put('/api/admin/products/:id', adminMiddleware, async (req, res) => {
  try {
    const { description, category, badge, hidden } = req.body;
    const enrichments = readJSON('enrichments.json', {});
    const current = enrichments[req.params.id] || {};
    enrichments[req.params.id] = {
      ...current,
      ...(description !== undefined && { description }),
      ...(category    !== undefined && { category }),
      ...(badge       !== undefined && { badge }),
      ...(hidden      !== undefined && { hidden }),
      updatedAt: new Date().toISOString()
    };
    writeJSON('enrichments.json', enrichments);

    let product;
    try {
      const catalog = await getPalomaCatalog();
      const p = catalog.products.find(x => x.palomaId === req.params.id);
      product = p ? mergeProduct(p, enrichments[req.params.id]) : null;
    } catch {}
    if (!product) product = { id: req.params.id, ...enrichments[req.params.id] };

    res.json({ success: true, product });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Загрузка фото — colorKey теперь это имя цвета из variants
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

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const users = readJSON('users.json', []).map(({ password, ...safe }) => safe);
  res.json({ users });
});

app.get('/api/admin/orders', adminMiddleware, (req, res) => {
  res.json({ orders: readJSON('orders.json', []) });
});

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
  c => console.log(`✅ Paloma365: загружено ${c.products.length} сгруппированных товаров`),
  e => console.warn('⚠️  Paloma365 при старте:', e.message)
);
app.listen(PORT, () => {
  console.log(`\n🚀 NURE Backend v5.0 на порту ${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api`);
});
