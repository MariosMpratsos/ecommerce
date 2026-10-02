const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');

// Without JWT_SECRET in .env we keep a generated secret on disk, so restarting the
// server does not log everybody out (and does not silently break sessions).
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  const secretFile = path.join(__dirname, 'data', 'jwt.secret');
  try {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    if (fs.existsSync(secretFile)) JWT_SECRET = fs.readFileSync(secretFile, 'utf8').trim();
    if (!JWT_SECRET) {
      JWT_SECRET = crypto.randomBytes(48).toString('hex');
      fs.writeFileSync(secretFile, JWT_SECRET, { mode: 0o600 });
    }
    console.warn('Note: JWT_SECRET is not set in .env. Using the secret saved in data/jwt.secret.');
  } catch {
    JWT_SECRET = crypto.randomBytes(48).toString('hex');
    console.warn('Warning: JWT_SECRET is not set and data/ is not writable. Sessions end on every restart.');
  }
}
const TOKEN_TTL = '7d';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const BCRYPT_COST = 12;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

// ---- Tiny in-memory rate limiter (fine for a single server instance) ----
const buckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  const blocked = hits.length >= max;
  if (!blocked) hits.push(now);
  buckets.set(key, hits);
  return blocked;
}
// Failed-attempt counters (only failures count, and a success clears them).
const tooManyAttempts = (key, max, windowMs) => {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  buckets.set(key, hits);
  return hits.length >= max;
};
const noteAttempt = (key) => buckets.set(key, [...(buckets.get(key) || []), Date.now()]);
const clearAttempts = (key) => buckets.delete(key);

setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of buckets) {
    if (!hits.length || now - hits[hits.length - 1] > 3600_000) buckets.delete(key);
  }
}, 600_000).unref();

const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const publicUser = (u) => ({
  id: u.id,
  firstName: u.first_name,
  lastName: u.last_name,
  email: u.email,
  role: u.role,
});

const signToken = (u) => jwt.sign({ sub: u.id }, JWT_SECRET, { expiresIn: TOKEN_TTL });

// ---- Middleware ----
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Απαιτείται σύνδεση.' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Reload from DB so deleted users / role changes take effect immediately.
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'Ο λογαριασμός δεν υπάρχει.' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Η σύνδεση έληξε. Συνδέσου ξανά.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Μόνο για διαχειριστές.' });
  next();
}

// ---- Routes ----
const authRouter = express.Router();

authRouter.post('/register', async (req, res) => {
  if (rateLimited(`register:${req.ip}`, 10, 3600_000)) {
    return res.status(429).json({ error: 'Πολλές προσπάθειες. Δοκίμασε αργότερα.' });
  }

  const firstName = clean(req.body?.firstName);
  const lastName = clean(req.body?.lastName);
  const email = clean(req.body?.email).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!firstName || firstName.length > 60) return res.status(400).json({ error: 'Μη έγκυρο όνομα.' });
  if (!lastName || lastName.length > 60) return res.status(400).json({ error: 'Μη έγκυρο επίθετο.' });
  if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: 'Μη έγκυρο email.' });
  if (password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: 'Ο κωδικός πρέπει να έχει 8–72 χαρακτήρες.' });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  const insertUser = db.transaction(() => {
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM users').get();
    // First account, or the account matching ADMIN_EMAIL, becomes admin.
    const role = c === 0 || (ADMIN_EMAIL && email === ADMIN_EMAIL) ? 'admin' : 'user';
    const info = db
      .prepare('INSERT INTO users (first_name, last_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
      .run(firstName, lastName, email, passwordHash, role);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  });

  try {
    const user = insertUser();
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Υπάρχει ήδη λογαριασμός με αυτό το email.' });
    }
    console.error('Register failed:', err);
    res.status(500).json({ error: 'Σφάλμα διακομιστή.' });
  }
});

authRouter.post('/login', async (req, res) => {
  const email = clean(req.body?.email).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  const attemptKey = `login:${req.ip}:${email}`;
  if (tooManyAttempts(attemptKey, 8, 15 * 60_000)) {
    console.warn(`[auth] login blocked (too many failed attempts): ${email}`);
    return res.status(429).json({ error: 'Πολλές αποτυχημένες προσπάθειες. Δοκίμασε σε λίγα λεπτά.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Always run bcrypt so response time doesn't reveal whether the email exists.
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    noteAttempt(attemptKey);
    // Server console only; the browser always gets the same generic message.
    console.warn(`[auth] login failed for ${email}: ${user ? 'wrong password' : 'no such account in this database'}`);
    return res.status(401).json({ error: 'Λάθος email ή κωδικός.' });
  }
  clearAttempts(attemptKey);

  res.json({ token: signToken(user), user: publicUser(user) });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = { authRouter, requireAuth, requireAdmin, rateLimited };
