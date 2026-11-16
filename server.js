const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const mod = require('./moderation');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const CATEGORIES = ['comedy', 'music', 'gaming', 'sports', 'food', 'travel', 'art', 'tech', 'pets', 'fashion', 'education', 'other'];
const now = () => Date.now();
const REPORT_THRESHOLD = Number(process.env.REPORT_THRESHOLD || 3); // distinct reports that auto-hide a post/comment
const ADMIN_USERNAMES = String(process.env.ADMIN_USERNAMES || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
const REPORT_REASONS = ['nudity', 'violence', 'hate', 'harassment', 'spam', 'other'];
const blockedMsg = 'That contains words that are not allowed on VBrowse. Please keep it friendly and safe for everyone.';

// ---------- passwords & sessions ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, now());
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30 });
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// Attach the logged-in user (if any)
app.use((req, _res, next) => {
  const token = req.cookies.sid;
  if (token) {
    req.user = db.prepare(`SELECT u.id, u.username, u.display_name, u.bio, u.avatar, u.is_admin, u.banned
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
    if (req.user?.banned) req.user = undefined;
  }
  next();
});
const auth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Please log in first.' });
const adminOnly = (req, res, next) => req.user?.is_admin ? next() : res.status(403).json({ error: 'Moderators only.' });
const canSee = (post, user) => post.status === 'approved' || (user && (user.id === post.user_id || user.is_admin));

// Simple in-memory rate limiter
const hits = new Map();
function rateLimit(key, max, windowMs) {
  return (req, res, next) => {
    const id = `${key}:${req.user?.id || req.ip}`;
    const t = now();
    const arr = (hits.get(id) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Slow down a little and try again shortly.' });
    arr.push(t); hits.set(id, arr); next();
  };
}

// Uploads
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg'];
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = IMAGE_TYPES.includes(file.mimetype) || VIDEO_TYPES.includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG, GIF, WEBP images or MP4, WEBM, MOV videos are allowed.'), ok);
  },
});
const removeUpload = (file) => { if (file) fs.unlink(path.join(UPLOAD_DIR, path.basename(file)), () => {}); };

// ---------- serializers ----------
function userPublic(u) {
  return { id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, bio: u.bio, isAdmin: !!u.is_admin };
}

const POST_SELECT = `
SELECT p.*, u.username, u.display_name, u.avatar,
  (SELECT COUNT(*) FROM reactions r WHERE r.post_id = p.id AND r.value = 1)  AS likes,
  (SELECT COUNT(*) FROM reactions r WHERE r.post_id = p.id AND r.value = -1) AS dislikes,
  (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.hidden = 0) AS comment_count,
  (SELECT value FROM reactions r WHERE r.post_id = p.id AND r.user_id = :me) AS my_reaction,
  EXISTS (SELECT 1 FROM saves s WHERE s.post_id = p.id AND s.user_id = :me) AS saved,
  EXISTS (SELECT 1 FROM follows f WHERE f.followee_id = p.user_id AND f.follower_id = :me) AS following_author
FROM posts p JOIN users u ON u.id = p.user_id`;

function serializePost(p) {
  return {
    id: p.id, kind: p.kind, media: p.media ? `/uploads/${p.media}` : null,
    caption: p.caption, category: p.category, tags: p.tags ? p.tags.split(',') : [],
    views: p.views, createdAt: p.created_at, status: p.status, modReason: p.status !== 'approved' ? p.mod_reason : '',
    likes: p.likes, dislikes: p.dislikes, comments: p.comment_count,
    myReaction: p.my_reaction || 0, saved: !!p.saved, followingAuthor: !!p.following_author,
    author: { id: p.user_id, username: p.username, displayName: p.display_name, avatar: p.avatar },
  };
}
const getPost = (id, user) => {
  const p = db.prepare(`${POST_SELECT} WHERE p.id = :id`).get({ id, me: user?.id || 0 });
  return p && canSee(p, user) ? serializePost(p) : null;
};
// Load a post row the current user is allowed to interact with, or send 404
function visiblePost(req, res) {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!p || !canSee(p, req.user)) { res.status(404).json({ error: 'Post not found.' }); return null; }
  return p;
}

// Tags = the explicit tag field + any #hashtags written in the caption
function parseTags(field, caption) {
  const fromField = String(field || '').toLowerCase().split(/[\s,#]+/);
  const fromCaption = (String(caption || '').toLowerCase().match(/#[a-z0-9_]{1,40}/g) || []).map((t) => t.slice(1));
  const clean = [...fromField, ...fromCaption].map((t) => t.replace(/[^a-z0-9_]/g, '').slice(0, 40)).filter(Boolean);
  return [...new Set(clean)].slice(0, 15).join(',');
}

// ---------- auth routes ----------
app.post('/api/signup', rateLimit('signup', 10, 60 * 60 * 1000), (req, res) => {
  let { username, password, displayName } = req.body || {};
  username = String(username || '').trim().toLowerCase();
  displayName = String(displayName || '').trim() || username;
  password = String(password || '');
  if (!/^[a-z0-9_.]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, _ or .' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (displayName.length > 40) return res.status(400).json({ error: 'Display name is too long (max 40).' });
  if (!mod.checkText(username).ok || !mod.checkText(displayName).ok) return res.status(400).json({ error: blockedMsg });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'That username is taken.' });
  // The very first account (the site owner) and anyone in ADMIN_USERNAMES become moderators.
  const isAdmin = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0 || ADMIN_USERNAMES.includes(username) ? 1 : 0;
  const info = db.prepare('INSERT INTO users (username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, displayName, hashPassword(password), isAdmin, now());
  createSession(res, info.lastInsertRowid);
  res.json({ user: userPublic(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)) });
});

app.post('/api/login', rateLimit('login', 20, 15 * 60 * 1000), (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !checkPassword(password, u.password_hash)) return res.status(401).json({ error: 'Wrong username or password.' });
  if (u.banned) return res.status(403).json({ error: 'This account has been suspended for breaking the community rules.' });
  createSession(res, u.id);
  res.json({ user: userPublic(u) });
});

app.post('/api/logout', (req, res) => {
  if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ user: req.user ? userPublic(req.user) : null, categories: CATEGORIES }));

app.patch('/api/me', auth, upload.single('avatar'), async (req, res) => {
  const displayName = req.body.displayName != null ? String(req.body.displayName).trim().slice(0, 40) : null;
  const bio = req.body.bio != null ? String(req.body.bio).slice(0, 300) : null;
  if (req.file && !IMAGE_TYPES.includes(req.file.mimetype)) { removeUpload(req.file.filename); return res.status(400).json({ error: 'Avatar must be an image.' }); }
  if ((displayName && !mod.checkText(displayName).ok) || (bio && !mod.checkText(bio).ok)) { if (req.file) removeUpload(req.file.filename); return res.status(400).json({ error: blockedMsg }); }
  if (req.file) {
    const scan = await mod.scanMedia(req.file.path, 'image');
    if (scan.verdict !== 'ok') { removeUpload(req.file.filename); return res.status(400).json({ error: 'That profile photo was blocked by our safety check. Please choose a different one.' }); }
  }
  const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (req.file && cur.avatar) removeUpload(cur.avatar.replace('/uploads/', ''));
  db.prepare('UPDATE users SET display_name = ?, bio = ?, avatar = ? WHERE id = ?').run(
    displayName || cur.display_name, bio ?? cur.bio, req.file ? `/uploads/${req.file.filename}` : cur.avatar, req.user.id);
  res.json({ user: userPublic(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// ---------- posts ----------
app.get('/api/posts', (req, res) => {
  const me = req.user?.id || 0;
  const { sort = 'latest', kind, category, q, user, tag, saved } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 12, 50);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const where = [];
  const params = { me, limit, offset };
  // Only approved posts are public. You also see your own posts that are waiting for review on your profile.
  if (user && req.user && String(user).toLowerCase() === req.user.username.toLowerCase()) where.push("p.status IN ('approved','pending')");
  else where.push("p.status = 'approved'");

  if (['video', 'image', 'text'].includes(kind)) { where.push('p.kind = :kind'); params.kind = kind; }
  if (CATEGORIES.includes(category)) { where.push('p.category = :category'); params.category = category; }
  if (user) { where.push('u.username = :user'); params.user = String(user); }
  if (tag) { where.push(`(',' || p.tags || ',') LIKE :tag`); params.tag = `%,${String(tag).toLowerCase()},%`; }
  if (q) {
    where.push(`(p.caption LIKE :q OR p.tags LIKE :q OR u.username LIKE :q OR u.display_name LIKE :q)`);
    params.q = `%${String(q).slice(0, 100)}%`;
  }
  if (saved === '1') {
    if (!me) return res.status(401).json({ error: 'Log in to see saved posts.' });
    where.push('EXISTS (SELECT 1 FROM saves s2 WHERE s2.post_id = p.id AND s2.user_id = :me)');
  }
  if (sort === 'following') {
    if (!me) return res.status(401).json({ error: 'Log in to see posts from people you follow.' });
    where.push('p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = :me)');
  }
  const orders = {
    latest: 'p.created_at DESC',
    following: 'p.created_at DESC',
    oldest: 'p.created_at ASC',
    top: '(likes - dislikes) DESC, likes DESC, p.created_at DESC',
    views: 'p.views DESC, p.created_at DESC',
    discussed: 'comment_count DESC, p.created_at DESC',
    // Hacker-News style decay: engagement / (age_hours + 2)^1.5
    trending: `((likes - dislikes) * 1.0 + comment_count * 2 + p.views * 0.05 + 1)
               / ((((:now - p.created_at) / 3600000.0) + 2) * sqrt(((:now - p.created_at) / 3600000.0) + 2)) DESC`,
  };
  const order = orders[sort] || orders.latest;
  if (order === orders.trending) params.now = now();
  const sql = `${POST_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${order} LIMIT :limit OFFSET :offset`;
  const rows = db.prepare(sql).all(params);
  res.json({ posts: rows.map(serializePost), nextOffset: rows.length === limit ? offset + limit : null });
});

app.get('/api/posts/:id', (req, res) => {
  const p = getPost(Number(req.params.id), req.user);
  p ? res.json({ post: p }) : res.status(404).json({ error: 'Post not found.' });
});

app.post('/api/posts', auth, rateLimit('post', 30, 60 * 60 * 1000), upload.single('media'), async (req, res) => {
  const caption = String(req.body.caption || '').trim().slice(0, 2200);
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'other';
  const tags = parseTags(req.body.tags, caption);
  let kind = 'text';
  if (req.file) kind = VIDEO_TYPES.includes(req.file.mimetype) ? 'video' : 'image';
  else if (!caption) return res.status(400).json({ error: 'Add a photo, video, or write something.' });
  if (!mod.checkText(`${caption} ${tags}`).ok) { if (req.file) removeUpload(req.file.filename); return res.status(400).json({ error: blockedMsg }); }
  let status = 'approved', reason = '';
  if (req.file) {
    const scan = await mod.scanMedia(req.file.path, kind);
    if (scan.verdict === 'reject') {
      removeUpload(req.file.filename);
      return res.status(400).json({ error: 'This upload was blocked: our safety check detected nudity or sexual content, which is not allowed on VBrowse.' });
    }
    if (scan.verdict === 'review') { status = 'pending'; reason = scan.reason; }
  }
  const info = db.prepare('INSERT INTO posts (user_id, kind, media, caption, category, tags, status, mod_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, kind, req.file?.filename || null, caption, category, tags, status, reason, now());
  res.json({ post: getPost(info.lastInsertRowid, req.user) });
});

app.patch('/api/posts/:id', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  if (p.user_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own posts.' });
  const caption = req.body.caption != null ? String(req.body.caption).trim().slice(0, 2200) : p.caption;
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : p.category;
  if (!mod.checkText(caption).ok) return res.status(400).json({ error: blockedMsg });
  db.prepare('UPDATE posts SET caption = ?, category = ?, tags = ? WHERE id = ?').run(caption, category, parseTags(p.tags, caption), p.id);
  res.json({ post: getPost(p.id, req.user) });
});

app.delete('/api/posts/:id', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  if (p.user_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'You can only delete your own posts.' });
  db.prepare('DELETE FROM posts WHERE id = ?').run(p.id);
  removeUpload(p.media);
  res.json({ ok: true });
});

// value: 1 = like, -1 = dislike, 0 = remove reaction
app.post('/api/posts/:id/react', auth, rateLimit('react', 300, 60 * 1000), (req, res) => {
  const id = Number(req.params.id);
  const value = Number(req.body?.value);
  if (![1, -1, 0].includes(value)) return res.status(400).json({ error: 'Invalid reaction.' });
  if (!visiblePost(req, res)) return;
  if (value === 0) db.prepare('DELETE FROM reactions WHERE user_id = ? AND post_id = ?').run(req.user.id, id);
  else db.prepare(`INSERT INTO reactions (user_id, post_id, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, post_id) DO UPDATE SET value = excluded.value`).run(req.user.id, id, value);
  res.json({ post: getPost(id, req.user) });
});

app.post('/api/posts/:id/save', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!visiblePost(req, res)) return;
  const existing = db.prepare('SELECT 1 FROM saves WHERE user_id = ? AND post_id = ?').get(req.user.id, id);
  if (existing) db.prepare('DELETE FROM saves WHERE user_id = ? AND post_id = ?').run(req.user.id, id);
  else db.prepare('INSERT INTO saves (user_id, post_id, created_at) VALUES (?, ?, ?)').run(req.user.id, id, now());
  res.json({ saved: !existing });
});

// Views: counted once per viewer per post per hour
const viewSeen = new Map();
app.post('/api/posts/:id/view', (req, res) => {
  const id = Number(req.params.id);
  const key = `${req.user?.id || req.ip}:${id}`;
  const last = viewSeen.get(key);
  if (!last || now() - last > 60 * 60 * 1000) {
    viewSeen.set(key, now());
    db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(id);
  }
  const row = db.prepare('SELECT views FROM posts WHERE id = ?').get(id);
  res.json({ views: row ? row.views : 0 });
});

// ---------- comments ----------
app.get('/api/posts/:id/comments', (req, res) => {
  if (!visiblePost(req, res)) return;
  const me = req.user?.id || 0;
  const sort = req.query.sort === 'new' ? 'c.created_at DESC' : 'likes DESC, c.created_at ASC';
  const rows = db.prepare(`SELECT c.*, u.username, u.display_name, u.avatar,
      (SELECT COUNT(*) FROM comment_likes l WHERE l.comment_id = c.id) AS likes,
      EXISTS (SELECT 1 FROM comment_likes l WHERE l.comment_id = c.id AND l.user_id = :me) AS liked
    FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = :post AND (c.hidden = 0 OR :admin) ORDER BY ${sort}`)
    .all({ me, post: Number(req.params.id), admin: req.user?.is_admin ? 1 : 0 });
  res.json({ comments: rows.map(serializeComment) });
});
function serializeComment(c) {
  return {
    id: c.id, postId: c.post_id, parentId: c.parent_id, body: c.body, createdAt: c.created_at,
    likes: c.likes || 0, liked: !!c.liked, hidden: !!c.hidden,
    author: { id: c.user_id, username: c.username, displayName: c.display_name, avatar: c.avatar },
  };
}

app.post('/api/posts/:id/comments', auth, rateLimit('comment', 30, 60 * 1000), (req, res) => {
  const postId = Number(req.params.id);
  const body = String(req.body?.body || '').trim().slice(0, 1000);
  let parentId = req.body?.parentId ? Number(req.body.parentId) : null;
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
  if (!mod.checkText(body).ok) return res.status(400).json({ error: blockedMsg });
  if (!visiblePost(req, res)) return;
  if (parentId) {
    const parent = db.prepare('SELECT * FROM comments WHERE id = ? AND post_id = ?').get(parentId, postId);
    if (!parent) return res.status(400).json({ error: 'Replying to a comment that no longer exists.' });
    parentId = parent.parent_id || parent.id; // keep threads one level deep, like YouTube
  }
  const info = db.prepare('INSERT INTO comments (post_id, user_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(postId, req.user.id, parentId, body, now());
  const c = db.prepare(`SELECT c.*, u.username, u.display_name, u.avatar, 0 AS likes, 0 AS liked
    FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`).get(info.lastInsertRowid);
  res.json({ comment: serializeComment(c) });
});

app.delete('/api/comments/:id', auth, (req, res) => {
  const c = db.prepare(`SELECT c.*, p.user_id AS post_owner FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?`).get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Comment not found.' });
  if (c.user_id !== req.user.id && c.post_owner !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Not allowed.' });
  db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

app.post('/api/comments/:id/like', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM comments WHERE id = ?').get(id)) return res.status(404).json({ error: 'Comment not found.' });
  const has = db.prepare('SELECT 1 FROM comment_likes WHERE user_id = ? AND comment_id = ?').get(req.user.id, id);
  if (has) db.prepare('DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?').run(req.user.id, id);
  else db.prepare('INSERT INTO comment_likes (user_id, comment_id) VALUES (?, ?)').run(req.user.id, id);
  const likes = db.prepare('SELECT COUNT(*) AS n FROM comment_likes WHERE comment_id = ?').get(id).n;
  res.json({ liked: !has, likes });
});

// ---------- users ----------
app.get('/api/users/:username', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!u || (u.banned && !req.user?.is_admin)) return res.status(404).json({ error: 'User not found.' });
  const me = req.user?.id || 0;
  const stats = db.prepare(`SELECT
      (SELECT COUNT(*) FROM follows WHERE followee_id = :id) AS followers,
      (SELECT COUNT(*) FROM follows WHERE follower_id = :id) AS following,
      (SELECT COUNT(*) FROM posts WHERE user_id = :id AND status = 'approved') AS posts,
      (SELECT COUNT(*) FROM reactions r JOIN posts p ON p.id = r.post_id WHERE p.user_id = :id AND r.value = 1) AS likes,
      EXISTS (SELECT 1 FROM follows WHERE followee_id = :id AND follower_id = :me) AS is_following`).get({ id: u.id, me });
  res.json({ user: { ...userPublic(u), createdAt: u.created_at, followers: stats.followers, following: stats.following,
    posts: stats.posts, likes: stats.likes, isFollowing: !!stats.is_following, isMe: me === u.id } });
});

app.post('/api/users/:username/follow', auth, (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (u.id === req.user.id) return res.status(400).json({ error: "You can't follow yourself." });
  const has = db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.user.id, u.id);
  if (has) db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, u.id);
  else db.prepare('INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)').run(req.user.id, u.id, now());
  const followers = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?').get(u.id).n;
  res.json({ isFollowing: !has, followers });
});

app.get(['/api/users/:username/followers', '/api/users/:username/following'], (req, res) => {
  req.params.list = req.path.endsWith('/followers') ? 'followers' : 'following';
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const sql = req.params.list === 'followers'
    ? 'SELECT u.* FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = ? ORDER BY f.created_at DESC'
    : 'SELECT u.* FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? ORDER BY f.created_at DESC';
  res.json({ users: db.prepare(sql).all(u.id).map(userPublic) });
});

app.get('/api/search/users', (req, res) => {
  const q = `%${String(req.query.q || '').slice(0, 50)}%`;
  const rows = db.prepare('SELECT * FROM users WHERE banned = 0 AND (username LIKE ? OR display_name LIKE ?) LIMIT 8').all(q, q);
  res.json({ users: rows.map(userPublic) });
});

app.get('/api/tags/popular', (_req, res) => {
  const counts = {};
  for (const { tags } of db.prepare("SELECT tags FROM posts WHERE tags != '' AND status = 'approved' ORDER BY created_at DESC LIMIT 500").all())
    for (const t of tags.split(',')) counts[t] = (counts[t] || 0) + 1;
  res.json({ tags: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t]) => t) });
});

// ---------- reports ----------
app.post('/api/posts/:id/report', auth, rateLimit('report', 30, 60 * 60 * 1000), (req, res) => {
  const p = visiblePost(req, res); if (!p) return;
  const reason = REPORT_REASONS.includes(req.body?.reason) ? req.body.reason : 'other';
  if (p.user_id === req.user.id) return res.status(400).json({ error: "You can't report your own post." });
  db.prepare('INSERT OR IGNORE INTO reports (reporter_id, post_id, reason, created_at) VALUES (?, ?, ?, ?)').run(req.user.id, p.id, reason, now());
  const n = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE post_id = ?').get(p.id).n;
  // Nudity reports hide a post faster, since that's the most harmful thing to leave up.
  const nudity = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE post_id = ? AND reason = 'nudity'").get(p.id).n;
  if (p.status === 'approved' && (n >= REPORT_THRESHOLD || nudity >= Math.max(1, REPORT_THRESHOLD - 1))) {
    db.prepare("UPDATE posts SET status = 'pending', mod_reason = 'Hidden after reports from the community' WHERE id = ?").run(p.id);
  }
  res.json({ ok: true });
});
app.post('/api/comments/:id/report', auth, rateLimit('report', 30, 60 * 60 * 1000), (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Comment not found.' });
  if (c.user_id === req.user.id) return res.status(400).json({ error: "You can't report your own comment." });
  const reason = REPORT_REASONS.includes(req.body?.reason) ? req.body.reason : 'other';
  db.prepare('INSERT OR IGNORE INTO reports (reporter_id, comment_id, reason, created_at) VALUES (?, ?, ?, ?)').run(req.user.id, c.id, reason, now());
  const n = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE comment_id = ?').get(c.id).n;
  if (n >= REPORT_THRESHOLD) db.prepare('UPDATE comments SET hidden = 1 WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

// ---------- moderation (admins) ----------
app.get('/api/mod/queue', auth, adminOnly, (req, res) => {
  const me = req.user.id;
  const reasonsFor = (col, id) => db.prepare(`SELECT reason, COUNT(*) AS n FROM reports WHERE ${col} = ? GROUP BY reason ORDER BY n DESC`).all(id);
  const posts = db.prepare(`${POST_SELECT}
      WHERE p.status = 'pending' OR (p.status = 'approved' AND EXISTS (SELECT 1 FROM reports r WHERE r.post_id = p.id))
      ORDER BY (p.status = 'pending') DESC, p.created_at DESC LIMIT 100`).all({ me })
    .map((p) => ({ ...serializePost(p), modReason: p.mod_reason, reports: reasonsFor('post_id', p.id) }));
  const comments = db.prepare(`SELECT c.*, u.username, u.display_name, u.avatar, 0 AS likes, 0 AS liked
      FROM comments c JOIN users u ON u.id = c.user_id
      WHERE EXISTS (SELECT 1 FROM reports r WHERE r.comment_id = c.id) ORDER BY c.hidden DESC, c.created_at DESC LIMIT 100`).all()
    .map((c) => ({ ...serializeComment(c), hidden: !!c.hidden, reports: reasonsFor('comment_id', c.id) }));
  res.json({ posts, comments });
});
app.post('/api/mod/posts/:id', auth, adminOnly, (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  if (req.body?.action === 'approve') {
    db.prepare("UPDATE posts SET status = 'approved', mod_reason = '' WHERE id = ?").run(p.id);
    db.prepare('DELETE FROM reports WHERE post_id = ?').run(p.id);
  } else if (req.body?.action === 'remove') {
    db.prepare('DELETE FROM posts WHERE id = ?').run(p.id);
    removeUpload(p.media);
  } else return res.status(400).json({ error: 'Unknown action.' });
  res.json({ ok: true });
});
app.post('/api/mod/comments/:id', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (req.body?.action === 'keep') {
    db.prepare('UPDATE comments SET hidden = 0 WHERE id = ?').run(id);
    db.prepare('DELETE FROM reports WHERE comment_id = ?').run(id);
  } else if (req.body?.action === 'remove') db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  else return res.status(400).json({ error: 'Unknown action.' });
  res.json({ ok: true });
});
app.post('/api/mod/users/:username', auth, adminOnly, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (u.id === req.user.id) return res.status(400).json({ error: "You can't ban yourself." });
  if (req.body?.action === 'ban') {
    db.tx(() => {
      db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      for (const p of db.prepare('SELECT media FROM posts WHERE user_id = ?').all(u.id)) removeUpload(p.media);
      db.prepare('DELETE FROM posts WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM comments WHERE user_id = ?').run(u.id);
    });
  } else if (req.body?.action === 'unban') db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(u.id);
  else return res.status(400).json({ error: 'Unknown action.' });
  res.json({ ok: true });
});

// ---------- static ----------
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^\/(?!api|uploads).*/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Error handler (upload errors etc.)
app.use((err, req, res, _next) => {
  if (req.file) removeUpload(req.file.filename);
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too big (max 200 MB).' : err.message || 'Something went wrong.';
  res.status(400).json({ error: msg });
});

app.listen(PORT, () => {
  console.log(`VBrowse is running at http://localhost:${PORT}`);
  // Warm up the safety model so the first upload isn't slow
  mod.loadModel().then(() => console.log('Safety model ready')).catch((e) => console.error('Safety model failed to load:', e.message));
});
