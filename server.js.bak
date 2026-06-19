/**
 * NURE Shop Backend v2.0
 * - Paloma365 proxy (CORS fix)
 * - JWT Auth (users + admin)
 * - Product enrichment (photos, descriptions, colors)
 * - File uploads for product images
 */

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
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
const PALOMA_API_KEY  = process.env.PALOMA_API_KEY  || 'efdd95a2708c19ecdeb3d21bac81b834nure29007';
const PALOMA_BASE_URL = 'https://api.paloma365.com/company/api/';
const JWT_SECRET      = process.env.JWT_SECRET || 'nure_secret_2025_change_in_production';
const ADMIN_EMAIL     = 'ismagulshakarim0909@gmail.com';
const FRONTEND_URL    = process.env.FRONTEND_URL || '*';

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

// Инициализация: создать админа если нет
function initData() {
  const users = readJSON('users.json', []);
  const adminExists = users.find(u => u.email === ADMIN_EMAIL);
  if (!adminExists) {
    const hashed = bcrypt.hashSync('admin123', 10);
    users.push({
      id: uuidv4(),
      email: ADMIN_EMAIL,
      password: hashed,
      name: 'Ismagul',
      role: 'admin',
      createdAt: new Date().toISOString()
    });
    writeJSON('users.json', users);
    console.log('✅ Admin account created:', ADMIN_EMAIL, '/ password: admin123');
    console.log('   ⚠️  Смените пароль после первого входа!');
  }
  // Инициализация enrichments если нет
  if (!fs.existsSync(path.join(DATA_DIR, 'enrichments.json'))) {
    writeJSON('enrichments.json', {});
  }
}

// ══════════════════════════════════════
//  MIDDLEWARE
// ══════════════════════════════════════
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));

// Отдаём фронтенд (если есть папка public)
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}

// ── Авторизация ──
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

// ── Multer: загрузка изображений ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const slug = req.params.slug || 'misc';
    const dir  = path.join(UPLOADS_DIR, slug);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = `${uuidv4()}${ext}`;
    cb(null, name);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ══════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════
app.get('/api', (req, res) => {
  res.json({ status: 'ok', service: 'NURE Backend v2.0', time: new Date().toISOString() });
});

// ══════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Заполните все поля' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });

    const users = readJSON('users.json', []);
    if (users.find(u => u.email === email)) return res.status(409).json({ error: 'Email уже зарегистрирован' });

    const hashed = await bcrypt.hash(password, 10);
    const user = {
      id: uuidv4(), email, password: hashed, name,
      role: 'user', createdAt: new Date().toISOString()
    };
    users.push(user);
    writeJSON('users.json', users);

    const token = jwt.sign({ id: user.id, email, name, role: 'user' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email, name, role: 'user' } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/change-password
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════
//  PALOMA365 PROXY
// ══════════════════════════════════════

// GET /api/products — товары Paloma + enrichments
app.get('/api/products', async (req, res) => {
  try {
    const url = `${PALOMA_BASE_URL}?method=getProducts&token=${PALOMA_API_KEY}`;
    const response = await fetch(url, { timeout: 10000 });
    const data = await response.json();

    const enrichments = readJSON('enrichments.json', {});
    const products = (data.products || data.data || data || []).map(p => {
      const slug = slugify(p.name || p.id);
      const enrich = enrichments[p.id] || enrichments[slug] || {};
      return { ...p, slug, ...enrich };
    });

    res.json({ success: true, products });
  } catch (err) {
    // Если Paloma недоступна — вернуть только enriched данные
    const enrichments = readJSON('enrichments.json', {});
    const manual = Object.entries(enrichments).map(([id, e]) => ({ id, ...e }));
    res.json({ success: true, products: manual, offline: true });
  }
});

// GET /api/products/:id — один товар
app.get('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const enrichments = readJSON('enrichments.json', {});

    // Попробуем получить из Paloma
    let palomaProduct = null;
    try {
      const url = `${PALOMA_BASE_URL}?method=getProducts&token=${PALOMA_API_KEY}`;
      const r   = await fetch(url, { timeout: 8000 });
      const d   = await r.json();
      const all = d.products || d.data || d || [];
      palomaProduct = all.find(p => String(p.id) === String(id));
    } catch {}

    const enrich = enrichments[id] || {};
    const product = palomaProduct
      ? { ...palomaProduct, slug: slugify(palomaProduct.name || id), ...enrich }
      : { id, ...enrich };

    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stock/:id
app.get('/api/stock/:id', async (req, res) => {
  try {
    const url = `${PALOMA_BASE_URL}?method=getStock&token=${PALOMA_API_KEY}&product_id=${req.params.id}`;
    const r   = await fetch(url, { timeout: 8000 });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/order
app.post('/api/order', async (req, res) => {
  try {
    const payload = { ...req.body, token: PALOMA_API_KEY, method: 'createOrder' };
    const r = await fetch(PALOMA_BASE_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), timeout: 10000
    });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════
//  ADMIN — УПРАВЛЕНИЕ ТОВАРАМИ
// ══════════════════════════════════════

// GET /api/admin/enrichments — получить все enrichments
app.get('/api/admin/enrichments', adminMiddleware, (req, res) => {
  res.json(readJSON('enrichments.json', {}));
});

// PUT /api/admin/products/:id — обновить описание, категорию, badge товара
app.put('/api/admin/products/:id', adminMiddleware, (req, res) => {
  const { id } = req.params;
  const { description, category, badge, sizes, colors, isActive } = req.body;
  const enrichments = readJSON('enrichments.json', {});
  enrichments[id] = {
    ...(enrichments[id] || {}),
    ...(description !== undefined && { description }),
    ...(category    !== undefined && { category }),
    ...(badge       !== undefined && { badge }),
    ...(sizes       !== undefined && { sizes }),
    ...(colors      !== undefined && { colors }),
    ...(isActive    !== undefined && { isActive }),
    updatedAt: new Date().toISOString()
  };
  writeJSON('enrichments.json', enrichments);
  res.json({ success: true, enrichment: enrichments[id] });
});

// POST /api/admin/products/:slug/images — загрузить фото товара
app.post('/api/admin/products/:slug/images', adminMiddleware, upload.array('images', 10), (req, res) => {
  const { slug } = req.params;
  const colorKey = req.body.colorKey || 'default';
  const baseUrl  = `${req.protocol}://${req.get('host')}`;

  const urls = req.files.map(f => `${baseUrl}/uploads/${slug}/${f.filename}`);

  const enrichments = readJSON('enrichments.json', {});
  const enrich = enrichments[slug] || {};
  if (!enrich.images) enrich.images = {};
  if (!enrich.images[colorKey]) enrich.images[colorKey] = [];
  enrich.images[colorKey].push(...urls);
  enrichments[slug] = enrich;
  writeJSON('enrichments.json', enrichments);

  res.json({ success: true, urls, colorKey });
});

// DELETE /api/admin/products/:slug/images — удалить фото
app.delete('/api/admin/products/:slug/images', adminMiddleware, (req, res) => {
  const { slug } = req.params;
  const { url, colorKey = 'default' } = req.body;

  const enrichments = readJSON('enrichments.json', {});
  const enrich = enrichments[slug] || {};
  if (enrich.images && enrich.images[colorKey]) {
    enrich.images[colorKey] = enrich.images[colorKey].filter(u => u !== url);
    // Удалить файл
    try {
      const filename = path.basename(url);
      fs.unlinkSync(path.join(UPLOADS_DIR, slug, filename));
    } catch {}
    enrichments[slug] = enrich;
    writeJSON('enrichments.json', enrichments);
  }
  res.json({ success: true });
});

// GET /api/admin/users — список пользователей
app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const users = readJSON('users.json', []).map(u => {
    const { password, ...safe } = u;
    return safe;
  });
  res.json({ users });
});

// ══════════════════════════════════════
//  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ══════════════════════════════════════
function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[а-яё]/g, c => {
      const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
      return map[c] || c;
    })
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .trim();
}

// SPA fallback для фронтенда
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
app.listen(PORT, () => {
  console.log(`\n🚀 NURE Backend запущен на порту ${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api`);
  console.log(`   Admin: ${ADMIN_EMAIL}`);
});
