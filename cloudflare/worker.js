// VBrowse on Cloudflare Workers (free plan): the same API as server.js, on D1 (database) + KV (media).
// Static files in /public are served by Workers Static Assets; this Worker handles /api/* and /media/*.
//
// Differences from the Node server, forced by the free plan's ~10 ms CPU limit per request:
//  - The NSFW image/video scan runs in the uploader's browser (public/scan.js) instead of on the server.
//    The server trusts the client's verdict, so reports + the moderation queue remain the backstop.
//  - Passwords use PBKDF2-SHA256 (built into the runtime) instead of scrypt.
import * as textfilter from '../public/textfilter.js'; // shared word filter + validation (also used by the browser)

const V = globalThis.VBTextFilter || textfilter.default || textfilter;
const CATEGORIES = ['comedy', 'music', 'gaming', 'sports', 'food', 'travel', 'art', 'tech', 'pets', 'fashion', 'education', 'other'];
const REPORT_REASONS = ['nudity', 'violence', 'hate', 'harassment', 'spam', 'other'];
const REPORT_THRESHOLD = 3;
const SESSION_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_UPLOAD = 25 * 1024 * 1024; // KV value limit
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
const PBKDF2_ITERATIONS = 100000; // the Workers runtime maximum
const blockedMsg = 'That contains words that are not allowed on VBrowse. Please keep it friendly and safe for everyone.';
const now = () => Date.now();

// ---------- small helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array((s.match(/../g) || []).map((h) => parseInt(h, 16)));
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const textOk = (s) => V.checkText(s).ok;

// D1 binds positional params; this lets queries use readable :named params (each name may repeat).
function q(env, sql, params = {}) {
  const names = [];
  const text = sql.replace(/:([a-zA-Z_]\w*)/g, (_, n) => { let i = names.indexOf(n); if (i < 0) { names.push(n); i = names.length - 1; } return `?${i + 1}`; });
  return env.DB.prepare(text).bind(...names.map((n) => (params[n] === undefined ? null : params[n])));
}
const one = (env, sql, params) => q(env, sql, params).first();
const all = async (env, sql, params) => (await q(env, sql, params).all()).results || [];
const run = (env, sql, params) => q(env, sql, params).run();

// ---------- passwords ----------
async function pbkdf2(pw, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${hex(salt)}$${hex(await pbkdf2(pw, salt, PBKDF2_ITERATIONS))}`;
}
async function checkPassword(pw, stored) {
  const [alg, iter, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2') return false;
  const test = new Uint8Array(await pbkdf2(pw, unhex(salt), Number(iter)));
  const want = unhex(hash);
  if (test.length !== want.length) return false;
  let diff = 0; for (let i = 0; i < test.length; i++) diff |= test[i] ^ want[i];
  return diff === 0;
}

// ---------- in-memory rate limiting (per Worker instance; a light speed bump) ----------
const hits = new Map();
function rateLimit(ctx, key, max, windowMs) {
  const id = `${key}:${ctx.user?.id || ctx.ip}`;
  const t = now();
  const arr = (hits.get(id) || []).filter((x) => t - x < windowMs);
  if (arr.length >= max) fail(429, 'Slow down a little and try again shortly.');
  arr.push(t); hits.set(id, arr);
  if (hits.size > 5000) hits.clear();
}
const viewSeen = new Map();

// ---------- media storage (R2 if bound, otherwise KV) ----------
async function putMedia(env, file) {
  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' })[file.type] || 'bin';
  const key = `${now()}-${randomHex(6)}.${ext}`;
  const body = await file.arrayBuffer();
  if (env.BUCKET) await env.BUCKET.put(key, body, { httpMetadata: { contentType: file.type } });
  else await env.MEDIA.put(key, body, { metadata: { type: file.type } });
  return key;
}
async function deleteMedia(env, key) {
  if (!key) return;
  key = String(key).replace(/^\/media\//, '');
  try { if (env.BUCKET) await env.BUCKET.delete(key); else await env.MEDIA.delete(key); } catch {}
}
async function serveMedia(env, request, key, waitUntil) {
  if (!/^[\w.-]+$/.test(key)) return new Response('Not found', { status: 404 });
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/media/${key}`, request.url).toString());
  let full = await cache.match(cacheKey);
  if (!full) {
    let body, type;
    if (env.BUCKET) { const obj = await env.BUCKET.get(key); if (!obj) return new Response('Not found', { status: 404 }); body = await obj.arrayBuffer(); type = obj.httpMetadata?.contentType; }
    else { const r = await env.MEDIA.getWithMetadata(key, { type: 'arrayBuffer' }); if (!r.value) return new Response('Not found', { status: 404 }); body = r.value; type = r.metadata?.type; }
    full = new Response(body, { headers: { 'content-type': type || 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable', 'accept-ranges': 'bytes' } });
    waitUntil(cache.put(cacheKey, full.clone()));
  }
  // Videos need byte ranges (seeking, and Safari won't play without them)
  const range = request.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return full;
  const buf = await full.arrayBuffer();
  const size = buf.byteLength;
  let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : size - 1;
  if (isNaN(start) || start < 0) start = 0;
  end = Math.min(end, size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  return new Response(buf.slice(start, end + 1), { status: 206, headers: {
    'content-type': full.headers.get('content-type'), 'content-range': `bytes ${start}-${end}/${size}`,
    'content-length': String(end - start + 1), 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=31536000, immutable' } });
}
const mediaUrl = (key) => (key ? `/media/${key}` : null);

// ---------- serializers ----------
function userPublic(u) {
  return { id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, banner: u.banner || null, bio: u.bio, isAdmin: !!u.is_admin };
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
    id: p.id, kind: p.kind, media: mediaUrl(p.media), caption: p.caption, category: p.category, tags: p.tags ? p.tags.split(',') : [],
    views: p.views, createdAt: p.created_at, status: p.status, modReason: p.status !== 'approved' ? p.mod_reason : '',
    likes: p.likes, dislikes: p.dislikes, comments: p.comment_count,
    myReaction: p.my_reaction || 0, saved: !!p.saved, followingAuthor: !!p.following_author,
    author: { id: p.user_id, username: p.username, displayName: p.display_name, avatar: p.avatar },
  };
}
function serializeComment(c) {
  return {
    id: c.id, postId: c.post_id, parentId: c.parent_id, body: c.body, createdAt: c.created_at,
    likes: c.likes || 0, liked: !!c.liked, hidden: !!c.hidden,
    author: { id: c.user_id, username: c.username, displayName: c.display_name, avatar: c.avatar },
  };
}
const canSee = (post, user) => post.status === 'approved' || (user && (user.id === post.user_id || user.is_admin));
async function getPost(env, id, user) {
  const p = await one(env, `${POST_SELECT} WHERE p.id = :id`, { id, me: user?.id || 0 });
  return p && canSee(p, user) ? serializePost(p) : null;
}
async function visiblePost(env, id, user) {
  const p = await one(env, 'SELECT * FROM posts WHERE id = :id', { id });
  if (!p || !canSee(p, user)) fail(404, 'Post not found.');
  return p;
}
function parseTags(field, caption) {
  const fromField = String(field || '').toLowerCase().split(/[\s,#]+/);
  const fromCaption = (String(caption || '').toLowerCase().match(/#[a-z0-9_]{1,40}/g) || []).map((t) => t.slice(1));
  const clean = [...fromField, ...fromCaption].map((t) => t.replace(/[^a-z0-9_]/g, '').slice(0, 40)).filter(Boolean);
  return [...new Set(clean)].slice(0, 15).join(',');
}
const adminList = (env) => String(env.ADMIN_USERNAMES || '').toLowerCase().split(',').map((x) => x.trim().replace(/^@/, '')).filter(Boolean);

// ---------- sessions ----------
function cookie(ctx, token, maxAgeSec) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${ctx.secure ? '; Secure' : ''}`;
}
async function createSession(env, ctx, userId) {
  const token = randomHex(32);
  await run(env, 'INSERT INTO sessions (token, user_id, created_at) VALUES (:t, :u, :c)', { t: token, u: userId, c: now() });
  ctx.setCookie = cookie(ctx, token, SESSION_MS / 1000);
}
function readCookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

// ---------- routes ----------
const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });
const auth = (ctx) => { if (!ctx.user) fail(401, 'Please sign in first.'); return ctx.user; };
const admin = (ctx) => { if (!auth(ctx).is_admin) fail(403, 'Moderators only.'); };
const limits = { maxUploadMB: 25, clientScan: true, accept: [...VIDEO_TYPES, ...IMAGE_TYPES].join(',') };

on('GET', '/api/me', async (env, ctx) => ({ user: ctx.user ? { ...userPublic(ctx.user), email: ctx.user.email } : null, categories: CATEGORIES, limits }));

on('POST', '/api/signup', async (env, ctx) => {
  rateLimit(ctx, 'signup', 10, 60 * 60 * 1000);
  const b = await ctx.json();
  const handle = String(b.username || '').trim().replace(/^@/, '').toLowerCase();
  const email = String(b.email || '').trim().toLowerCase();
  const displayName = V.cleanName(b.displayName);
  const password = String(b.password || '');
  const err = V.validateName(displayName) || V.validateEmail(email) || V.validateHandle(handle) || V.validatePassword(password, handle, email);
  if (err) fail(400, err);
  if (await one(env, 'SELECT 1 AS x FROM users WHERE email = :e', { e: email })) fail(409, 'An account with that email already exists. Try signing in.');
  if (await one(env, 'SELECT 1 AS x FROM users WHERE username = :h', { h: handle })) fail(409, `@${handle} is taken. Try another handle.`);
  const count = (await one(env, 'SELECT COUNT(*) AS n FROM users')).n;
  const isAdmin = count === 0 || adminList(env).includes(handle) ? 1 : 0;
  const res = await run(env, 'INSERT INTO users (username, display_name, email, password_hash, is_admin, created_at) VALUES (:h, :n, :e, :p, :a, :c)',
    { h: handle, n: displayName, e: email, p: await hashPassword(password), a: isAdmin, c: now() });
  const id = res.meta.last_row_id;
  await createSession(env, ctx, id);
  return { user: { ...userPublic(await one(env, 'SELECT * FROM users WHERE id = :id', { id })), email } };
});

on('GET', '/api/handle-check', async (env, ctx) => {
  rateLimit(ctx, 'handlecheck', 120, 60 * 1000);
  const handle = String(ctx.url.searchParams.get('h') || '').trim().replace(/^@/, '').toLowerCase();
  const err = V.validateHandle(handle);
  if (err) return { ok: false, error: err };
  const taken = await one(env, 'SELECT id FROM users WHERE username = :h', { h: handle });
  if (taken && taken.id !== ctx.user?.id) return { ok: false, error: `@${handle} is taken.` };
  return { ok: true };
});

on('POST', '/api/login', async (env, ctx) => {
  rateLimit(ctx, 'login', 20, 15 * 60 * 1000);
  const b = await ctx.json();
  const login = String(b.username || '').trim().replace(/^@/, '').toLowerCase();
  const u = await one(env, 'SELECT * FROM users WHERE username = :l OR email = :l', { l: login });
  if (!u || !(await checkPassword(String(b.password || ''), u.password_hash))) fail(401, "That email/handle and password don't match. Try again.");
  if (u.banned) fail(403, 'This account has been suspended for breaking the community rules.');
  await createSession(env, ctx, u.id);
  return { user: { ...userPublic(u), email: u.email } };
});

on('POST', '/api/logout', async (env, ctx) => {
  if (ctx.token) await run(env, 'DELETE FROM sessions WHERE token = :t', { t: ctx.token });
  ctx.setCookie = cookie(ctx, '', 0);
  return { ok: true };
});

on('PATCH', '/api/me', async (env, ctx) => {
  const me = auth(ctx);
  const fd = await ctx.form();
  const cur = await one(env, 'SELECT * FROM users WHERE id = :id', { id: me.id });
  const displayName = fd.get('displayName') != null ? V.cleanName(fd.get('displayName')) : cur.display_name;
  const handle = fd.get('username') != null ? String(fd.get('username')).trim().replace(/^@/, '').toLowerCase() : cur.username;
  const bio = fd.get('bio') != null ? String(fd.get('bio')).replace(/\r/g, '').trim().slice(0, 1000) : cur.bio;
  const err = V.validateName(displayName) || (handle !== cur.username ? V.validateHandle(handle) : '');
  if (err) fail(400, err);
  if (bio && !textOk(bio)) fail(400, blockedMsg);
  if (handle !== cur.username && await one(env, 'SELECT 1 AS x FROM users WHERE username = :h AND id != :id', { h: handle, id: cur.id })) fail(409, `@${handle} is taken. Try another handle.`);
  const files = { avatar: fd.get('avatar'), banner: fd.get('banner') };
  for (const [k, f] of Object.entries(files)) {
    if (!f || typeof f === 'string' || !f.size) { files[k] = null; continue; }
    if (!IMAGE_TYPES.includes(f.type)) fail(400, 'Profile pictures and banners must be JPG, PNG, GIF or WEBP images.');
    if (f.size > MAX_UPLOAD) fail(400, 'That image is too big (max 25 MB).');
    if (fd.get(k === 'avatar' ? 'scanAvatar' : 'scanBanner') !== 'ok') fail(400, 'That image was blocked by our safety check. Please choose a different one.');
  }
  let avatar = cur.avatar, banner = cur.banner;
  if (files.avatar || fd.get('removeAvatar') === '1') { await deleteMedia(env, cur.avatar); avatar = files.avatar ? mediaUrl(await putMedia(env, files.avatar)) : null; }
  if (files.banner || fd.get('removeBanner') === '1') { await deleteMedia(env, cur.banner); banner = files.banner ? mediaUrl(await putMedia(env, files.banner)) : null; }
  await run(env, 'UPDATE users SET display_name = :n, username = :h, bio = :b, avatar = :a, banner = :bn WHERE id = :id', { n: displayName, h: handle, b: bio, a: avatar, bn: banner, id: cur.id });
  return { user: { ...userPublic(await one(env, 'SELECT * FROM users WHERE id = :id', { id: cur.id })), email: cur.email } };
});

on('PATCH', '/api/account', async (env, ctx) => {
  const me = auth(ctx);
  rateLimit(ctx, 'account', 20, 15 * 60 * 1000);
  const b = await ctx.json();
  const cur = await one(env, 'SELECT * FROM users WHERE id = :id', { id: me.id });
  if (!(await checkPassword(String(b.currentPassword || ''), cur.password_hash))) fail(403, 'Your current password is incorrect.');
  if (b.email != null) {
    const email = String(b.email).trim().toLowerCase();
    const err = V.validateEmail(email); if (err) fail(400, err);
    if (await one(env, 'SELECT 1 AS x FROM users WHERE email = :e AND id != :id', { e: email, id: cur.id })) fail(409, 'Another account already uses that email.');
    await run(env, 'UPDATE users SET email = :e WHERE id = :id', { e: email, id: cur.id });
  }
  if (b.newPassword != null) {
    const pw = String(b.newPassword);
    const err = V.validatePassword(pw, cur.username, cur.email); if (err) fail(400, err);
    await run(env, 'UPDATE users SET password_hash = :p WHERE id = :id', { p: await hashPassword(pw), id: cur.id });
    await run(env, 'DELETE FROM sessions WHERE user_id = :id AND token != :t', { id: cur.id, t: ctx.token }); // sign out other devices
  }
  const u = await one(env, 'SELECT * FROM users WHERE id = :id', { id: cur.id });
  return { user: { ...userPublic(u), email: u.email } };
});

on('DELETE', '/api/account', async (env, ctx) => {
  const me = auth(ctx);
  const b = await ctx.json();
  const cur = await one(env, 'SELECT * FROM users WHERE id = :id', { id: me.id });
  if (!(await checkPassword(String(b.password || ''), cur.password_hash))) fail(403, 'Your password is incorrect.');
  const media = (await all(env, 'SELECT media FROM posts WHERE user_id = :id', { id: cur.id })).map((p) => p.media);
  await run(env, 'DELETE FROM users WHERE id = :id', { id: cur.id }); // cascades
  ctx.wait(Promise.all([...media, cur.avatar, cur.banner].map((m) => deleteMedia(env, m))));
  ctx.setCookie = cookie(ctx, '', 0);
  return { ok: true };
});

on('GET', '/api/posts', async (env, ctx) => {
  const sp = ctx.url.searchParams;
  const me = ctx.user?.id || 0;
  const sort = sp.get('sort') || 'latest', kind = sp.get('kind'), category = sp.get('category'), search = sp.get('q'), user = sp.get('user'), tag = sp.get('tag');
  const limit = Math.min(parseInt(sp.get('limit'), 10) || 12, 50);
  const offset = Math.max(parseInt(sp.get('offset'), 10) || 0, 0);
  const where = []; const params = { me, limit, offset };
  if (user && ctx.user && user.toLowerCase() === ctx.user.username.toLowerCase()) where.push("p.status IN ('approved','pending')");
  else where.push("p.status = 'approved'");
  if (['video', 'image', 'text'].includes(kind)) { where.push('p.kind = :kind'); params.kind = kind; }
  if (CATEGORIES.includes(category)) { where.push('p.category = :category'); params.category = category; }
  if (user) { where.push('u.username = :user'); params.user = user; }
  if (tag) { where.push(`(',' || p.tags || ',') LIKE :tag`); params.tag = `%,${tag.toLowerCase()},%`; }
  if (search) { where.push('(p.caption LIKE :q OR p.tags LIKE :q OR u.username LIKE :q OR u.display_name LIKE :q)'); params.q = `%${search.slice(0, 100)}%`; }
  if (sp.get('saved') === '1') { if (!me) fail(401, 'Sign in to see saved posts.'); where.push('EXISTS (SELECT 1 FROM saves s2 WHERE s2.post_id = p.id AND s2.user_id = :me)'); }
  if (sort === 'following') { if (!me) fail(401, 'Sign in to see posts from people you follow.'); where.push('p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = :me)'); }
  const orders = {
    latest: 'p.created_at DESC', following: 'p.created_at DESC', oldest: 'p.created_at ASC',
    top: '(likes - dislikes) DESC, likes DESC, p.created_at DESC', views: 'p.views DESC, p.created_at DESC', discussed: 'comment_count DESC, p.created_at DESC',
    // engagement / (age_hours + 2)^1.5 (written as x * sqrt(x) since D1 has no pow())
    trending: `((likes - dislikes) * 1.0 + comment_count * 2 + p.views * 0.05 + 1)
               / ((((:now - p.created_at) / 3600000.0) + 2) * sqrt(((:now - p.created_at) / 3600000.0) + 2)) DESC`,
  };
  const order = orders[sort] || orders.latest;
  if (order === orders.trending) params.now = now();
  const rows = await all(env, `${POST_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT :limit OFFSET :offset`, params);
  return { posts: rows.map(serializePost), nextOffset: rows.length === limit ? offset + limit : null };
});

on('GET', '/api/posts/:id', async (env, ctx, { id }) => {
  const p = await getPost(env, Number(id), ctx.user);
  if (!p) fail(404, 'Post not found.');
  return { post: p };
});

on('POST', '/api/posts', async (env, ctx) => {
  const me = auth(ctx);
  rateLimit(ctx, 'post', 30, 60 * 60 * 1000);
  const fd = await ctx.form();
  const file = fd.get('media');
  const hasFile = file && typeof file !== 'string' && file.size > 0;
  const caption = String(fd.get('caption') || '').trim().slice(0, 2200);
  const category = CATEGORIES.includes(fd.get('category')) ? fd.get('category') : 'other';
  const tags = parseTags(fd.get('tags'), caption);
  let kind = 'text', media = null, status = 'approved', reason = '';
  if (!hasFile && !caption) fail(400, 'Add a photo, video, or write something.');
  if (!textOk(`${caption} ${tags}`)) fail(400, blockedMsg);
  if (hasFile) {
    if (!IMAGE_TYPES.includes(file.type) && !VIDEO_TYPES.includes(file.type)) fail(400, 'Only JPG, PNG, GIF, WEBP images or MP4, WEBM, MOV videos are allowed.');
    if (file.size > MAX_UPLOAD) fail(400, 'File is too big (max 25 MB).');
    kind = VIDEO_TYPES.includes(file.type) ? 'video' : 'image';
    const verdict = String(fd.get('scan') || '');
    if (verdict === 'reject') fail(400, 'This upload was blocked: our safety check detected nudity or sexual content, which is not allowed on VBrowse.');
    if (verdict !== 'ok') { status = 'pending'; reason = verdict === 'review' ? 'Possibly sensitive content (auto-flagged)' : 'Automatic safety check unavailable'; }
    media = await putMedia(env, file);
  }
  const res = await run(env, 'INSERT INTO posts (user_id, kind, media, caption, category, tags, status, mod_reason, created_at) VALUES (:u, :k, :m, :c, :cat, :t, :s, :r, :at)',
    { u: me.id, k: kind, m: media, c: caption, cat: category, t: tags, s: status, r: reason, at: now() });
  return { post: await getPost(env, res.meta.last_row_id, me) };
});

on('PATCH', '/api/posts/:id', async (env, ctx, { id }) => {
  const me = auth(ctx);
  const p = await one(env, 'SELECT * FROM posts WHERE id = :id', { id: Number(id) });
  if (!p) fail(404, 'Post not found.');
  if (p.user_id !== me.id) fail(403, 'You can only edit your own posts.');
  const b = await ctx.json();
  const caption = b.caption != null ? String(b.caption).trim().slice(0, 2200) : p.caption;
  const category = CATEGORIES.includes(b.category) ? b.category : p.category;
  if (!textOk(caption)) fail(400, blockedMsg);
  await run(env, 'UPDATE posts SET caption = :c, category = :cat, tags = :t WHERE id = :id', { c: caption, cat: category, t: parseTags(p.tags, caption), id: p.id });
  return { post: await getPost(env, p.id, me) };
});

on('DELETE', '/api/posts/:id', async (env, ctx, { id }) => {
  const me = auth(ctx);
  const p = await one(env, 'SELECT * FROM posts WHERE id = :id', { id: Number(id) });
  if (!p) fail(404, 'Post not found.');
  if (p.user_id !== me.id && !me.is_admin) fail(403, 'You can only delete your own posts.');
  await run(env, 'DELETE FROM posts WHERE id = :id', { id: p.id });
  ctx.wait(deleteMedia(env, p.media));
  return { ok: true };
});

on('POST', '/api/posts/:id/react', async (env, ctx, { id }) => {
  const me = auth(ctx);
  rateLimit(ctx, 'react', 300, 60 * 1000);
  const value = Number((await ctx.json()).value);
  if (![1, -1, 0].includes(value)) fail(400, 'Invalid reaction.');
  await visiblePost(env, Number(id), me);
  if (value === 0) await run(env, 'DELETE FROM reactions WHERE user_id = :u AND post_id = :p', { u: me.id, p: Number(id) });
  else await run(env, `INSERT INTO reactions (user_id, post_id, value) VALUES (:u, :p, :v) ON CONFLICT(user_id, post_id) DO UPDATE SET value = excluded.value`, { u: me.id, p: Number(id), v: value });
  return { post: await getPost(env, Number(id), me) };
});

on('POST', '/api/posts/:id/save', async (env, ctx, { id }) => {
  const me = auth(ctx);
  await visiblePost(env, Number(id), me);
  const has = await one(env, 'SELECT 1 AS x FROM saves WHERE user_id = :u AND post_id = :p', { u: me.id, p: Number(id) });
  if (has) await run(env, 'DELETE FROM saves WHERE user_id = :u AND post_id = :p', { u: me.id, p: Number(id) });
  else await run(env, 'INSERT INTO saves (user_id, post_id, created_at) VALUES (:u, :p, :c)', { u: me.id, p: Number(id), c: now() });
  return { saved: !has };
});

on('POST', '/api/posts/:id/view', async (env, ctx, { id }) => {
  const key = `${ctx.user?.id || ctx.ip}:${id}`;
  const last = viewSeen.get(key);
  if (!last || now() - last > 60 * 60 * 1000) {
    viewSeen.set(key, now()); if (viewSeen.size > 20000) viewSeen.clear();
    await run(env, 'UPDATE posts SET views = views + 1 WHERE id = :id', { id: Number(id) });
  }
  const row = await one(env, 'SELECT views FROM posts WHERE id = :id', { id: Number(id) });
  return { views: row ? row.views : 0 };
});

// ---------- comments ----------
on('GET', '/api/posts/:id/comments', async (env, ctx, { id }) => {
  await visiblePost(env, Number(id), ctx.user);
  const sort = ctx.url.searchParams.get('sort') === 'new' ? 'c.created_at DESC' : 'likes DESC, c.created_at ASC';
  const rows = await all(env, `SELECT c.*, u.username, u.display_name, u.avatar,
      (SELECT COUNT(*) FROM comment_likes l WHERE l.comment_id = c.id) AS likes,
      EXISTS (SELECT 1 FROM comment_likes l WHERE l.comment_id = c.id AND l.user_id = :me) AS liked
    FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = :post AND (c.hidden = 0 OR :admin) ORDER BY ${sort}`,
    { me: ctx.user?.id || 0, post: Number(id), admin: ctx.user?.is_admin ? 1 : 0 });
  return { comments: rows.map(serializeComment) };
});
on('POST', '/api/posts/:id/comments', async (env, ctx, { id }) => {
  const me = auth(ctx);
  rateLimit(ctx, 'comment', 30, 60 * 1000);
  const b = await ctx.json();
  const postId = Number(id);
  const body = String(b.body || '').trim().slice(0, 1000);
  let parentId = b.parentId ? Number(b.parentId) : null;
  if (!body) fail(400, 'Comment cannot be empty.');
  if (!textOk(body)) fail(400, blockedMsg);
  await visiblePost(env, postId, me);
  if (parentId) {
    const parent = await one(env, 'SELECT * FROM comments WHERE id = :id AND post_id = :p', { id: parentId, p: postId });
    if (!parent) fail(400, 'Replying to a comment that no longer exists.');
    parentId = parent.parent_id || parent.id;
  }
  const res = await run(env, 'INSERT INTO comments (post_id, user_id, parent_id, body, created_at) VALUES (:p, :u, :pa, :b, :c)', { p: postId, u: me.id, pa: parentId, b: body, c: now() });
  const c = await one(env, `SELECT c.*, u.username, u.display_name, u.avatar, 0 AS likes, 0 AS liked FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = :id`, { id: res.meta.last_row_id });
  return { comment: serializeComment(c) };
});
on('DELETE', '/api/comments/:id', async (env, ctx, { id }) => {
  const me = auth(ctx);
  const c = await one(env, 'SELECT c.*, p.user_id AS post_owner FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = :id', { id: Number(id) });
  if (!c) fail(404, 'Comment not found.');
  if (c.user_id !== me.id && c.post_owner !== me.id && !me.is_admin) fail(403, 'Not allowed.');
  await run(env, 'DELETE FROM comments WHERE id = :id', { id: c.id });
  return { ok: true };
});
on('POST', '/api/comments/:id/like', async (env, ctx, { id }) => {
  const me = auth(ctx);
  const cid = Number(id);
  if (!(await one(env, 'SELECT 1 AS x FROM comments WHERE id = :id', { id: cid }))) fail(404, 'Comment not found.');
  const has = await one(env, 'SELECT 1 AS x FROM comment_likes WHERE user_id = :u AND comment_id = :c', { u: me.id, c: cid });
  if (has) await run(env, 'DELETE FROM comment_likes WHERE user_id = :u AND comment_id = :c', { u: me.id, c: cid });
  else await run(env, 'INSERT INTO comment_likes (user_id, comment_id) VALUES (:u, :c)', { u: me.id, c: cid });
  return { liked: !has, likes: (await one(env, 'SELECT COUNT(*) AS n FROM comment_likes WHERE comment_id = :c', { c: cid })).n };
});

// ---------- users ----------
on('GET', '/api/users/:username/followers', async (env, ctx, { username }) => {
  const u = await one(env, 'SELECT id FROM users WHERE username = :h', { h: decodeURIComponent(username) });
  if (!u) fail(404, 'User not found.');
  return { users: (await all(env, 'SELECT u.* FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = :id AND u.banned = 0 ORDER BY f.created_at DESC', { id: u.id })).map(userPublic) };
});
on('GET', '/api/users/:username/following', async (env, ctx, { username }) => {
  const u = await one(env, 'SELECT id FROM users WHERE username = :h', { h: decodeURIComponent(username) });
  if (!u) fail(404, 'User not found.');
  return { users: (await all(env, 'SELECT u.* FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = :id AND u.banned = 0 ORDER BY f.created_at DESC', { id: u.id })).map(userPublic) };
});
on('GET', '/api/users/:username', async (env, ctx, { username }) => {
  const u = await one(env, 'SELECT * FROM users WHERE username = :h', { h: decodeURIComponent(username) });
  if (!u || (u.banned && !ctx.user?.is_admin)) fail(404, 'User not found.');
  const me = ctx.user?.id || 0;
  const s = await one(env, `SELECT
      (SELECT COUNT(*) FROM follows WHERE followee_id = :id) AS followers,
      (SELECT COUNT(*) FROM follows WHERE follower_id = :id) AS following,
      (SELECT COUNT(*) FROM posts WHERE user_id = :id AND status = 'approved') AS posts,
      (SELECT COUNT(*) FROM reactions r JOIN posts p ON p.id = r.post_id WHERE p.user_id = :id AND r.value = 1) AS likes,
      EXISTS (SELECT 1 FROM follows WHERE followee_id = :id AND follower_id = :me) AS is_following`, { id: u.id, me });
  return { user: { ...userPublic(u), createdAt: u.created_at, followers: s.followers, following: s.following, posts: s.posts, likes: s.likes, isFollowing: !!s.is_following, isMe: me === u.id } };
});
on('POST', '/api/users/:username/follow', async (env, ctx, { username }) => {
  const me = auth(ctx);
  const u = await one(env, 'SELECT id FROM users WHERE username = :h', { h: decodeURIComponent(username) });
  if (!u) fail(404, 'User not found.');
  if (u.id === me.id) fail(400, "You can't follow yourself.");
  const has = await one(env, 'SELECT 1 AS x FROM follows WHERE follower_id = :a AND followee_id = :b', { a: me.id, b: u.id });
  if (has) await run(env, 'DELETE FROM follows WHERE follower_id = :a AND followee_id = :b', { a: me.id, b: u.id });
  else await run(env, 'INSERT INTO follows (follower_id, followee_id, created_at) VALUES (:a, :b, :c)', { a: me.id, b: u.id, c: now() });
  return { isFollowing: !has, followers: (await one(env, 'SELECT COUNT(*) AS n FROM follows WHERE followee_id = :b', { b: u.id })).n };
});
on('GET', '/api/search/users', async (env, ctx) => {
  const s = `%${String(ctx.url.searchParams.get('q') || '').slice(0, 50)}%`;
  return { users: (await all(env, 'SELECT * FROM users WHERE banned = 0 AND (username LIKE :s OR display_name LIKE :s) LIMIT 8', { s })).map(userPublic) };
});
on('GET', '/api/tags/popular', async (env) => {
  const counts = {};
  for (const { tags } of await all(env, "SELECT tags FROM posts WHERE tags != '' AND status = 'approved' ORDER BY created_at DESC LIMIT 500"))
    for (const t of tags.split(',')) counts[t] = (counts[t] || 0) + 1;
  return { tags: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t]) => t) };
});

// ---------- reports ----------
on('POST', '/api/posts/:id/report', async (env, ctx, { id }) => {
  const me = auth(ctx);
  rateLimit(ctx, 'report', 30, 60 * 60 * 1000);
  const p = await visiblePost(env, Number(id), me);
  const reason = REPORT_REASONS.includes((await ctx.json()).reason) ? ctx.body.reason : 'other';
  if (p.user_id === me.id) fail(400, "You can't report your own post.");
  await run(env, 'INSERT OR IGNORE INTO reports (reporter_id, post_id, reason, created_at) VALUES (:u, :p, :r, :c)', { u: me.id, p: p.id, r: reason, c: now() });
  const n = (await one(env, 'SELECT COUNT(*) AS n FROM reports WHERE post_id = :p', { p: p.id })).n;
  const nudity = (await one(env, "SELECT COUNT(*) AS n FROM reports WHERE post_id = :p AND reason = 'nudity'", { p: p.id })).n;
  if (p.status === 'approved' && (n >= REPORT_THRESHOLD || nudity >= Math.max(1, REPORT_THRESHOLD - 1)))
    await run(env, "UPDATE posts SET status = 'pending', mod_reason = 'Hidden after reports from the community' WHERE id = :p", { p: p.id });
  return { ok: true };
});
on('POST', '/api/comments/:id/report', async (env, ctx, { id }) => {
  const me = auth(ctx);
  rateLimit(ctx, 'report', 30, 60 * 60 * 1000);
  const c = await one(env, 'SELECT * FROM comments WHERE id = :id', { id: Number(id) });
  if (!c) fail(404, 'Comment not found.');
  if (c.user_id === me.id) fail(400, "You can't report your own comment.");
  const reason = REPORT_REASONS.includes((await ctx.json()).reason) ? ctx.body.reason : 'other';
  await run(env, 'INSERT OR IGNORE INTO reports (reporter_id, comment_id, reason, created_at) VALUES (:u, :c, :r, :t)', { u: me.id, c: c.id, r: reason, t: now() });
  const n = (await one(env, 'SELECT COUNT(*) AS n FROM reports WHERE comment_id = :c', { c: c.id })).n;
  if (n >= REPORT_THRESHOLD) await run(env, 'UPDATE comments SET hidden = 1 WHERE id = :c', { c: c.id });
  return { ok: true };
});

// ---------- moderation ----------
on('GET', '/api/mod/queue', async (env, ctx) => {
  admin(ctx);
  const reasonsFor = (col, id) => all(env, `SELECT reason, COUNT(*) AS n FROM reports WHERE ${col} = :id GROUP BY reason ORDER BY n DESC`, { id });
  const postRows = await all(env, `${POST_SELECT}
      WHERE p.status = 'pending' OR (p.status = 'approved' AND EXISTS (SELECT 1 FROM reports r WHERE r.post_id = p.id))
      ORDER BY (p.status = 'pending') DESC, p.created_at DESC LIMIT 100`, { me: ctx.user.id });
  const posts = await Promise.all(postRows.map(async (p) => ({ ...serializePost(p), modReason: p.mod_reason, reports: await reasonsFor('post_id', p.id) })));
  const commentRows = await all(env, `SELECT c.*, u.username, u.display_name, u.avatar, 0 AS likes, 0 AS liked FROM comments c JOIN users u ON u.id = c.user_id
      WHERE EXISTS (SELECT 1 FROM reports r WHERE r.comment_id = c.id) ORDER BY c.hidden DESC, c.created_at DESC LIMIT 100`);
  const comments = await Promise.all(commentRows.map(async (c) => ({ ...serializeComment(c), hidden: !!c.hidden, reports: await reasonsFor('comment_id', c.id) })));
  return { posts, comments };
});
on('POST', '/api/mod/posts/:id', async (env, ctx, { id }) => {
  admin(ctx);
  const p = await one(env, 'SELECT * FROM posts WHERE id = :id', { id: Number(id) });
  if (!p) fail(404, 'Post not found.');
  const action = (await ctx.json()).action;
  if (action === 'approve') await env.DB.batch([q(env, "UPDATE posts SET status = 'approved', mod_reason = '' WHERE id = :id", { id: p.id }), q(env, 'DELETE FROM reports WHERE post_id = :id', { id: p.id })]);
  else if (action === 'remove') { await run(env, 'DELETE FROM posts WHERE id = :id', { id: p.id }); ctx.wait(deleteMedia(env, p.media)); }
  else fail(400, 'Unknown action.');
  return { ok: true };
});
on('POST', '/api/mod/comments/:id', async (env, ctx, { id }) => {
  admin(ctx);
  const action = (await ctx.json()).action;
  if (action === 'keep') await env.DB.batch([q(env, 'UPDATE comments SET hidden = 0 WHERE id = :id', { id: Number(id) }), q(env, 'DELETE FROM reports WHERE comment_id = :id', { id: Number(id) })]);
  else if (action === 'remove') await run(env, 'DELETE FROM comments WHERE id = :id', { id: Number(id) });
  else fail(400, 'Unknown action.');
  return { ok: true };
});
on('POST', '/api/mod/users/:username', async (env, ctx, { username }) => {
  admin(ctx);
  const u = await one(env, 'SELECT * FROM users WHERE username = :h', { h: decodeURIComponent(username) });
  if (!u) fail(404, 'User not found.');
  if (u.id === ctx.user.id) fail(400, "You can't ban yourself.");
  const action = (await ctx.json()).action;
  if (action === 'ban') {
    const media = (await all(env, 'SELECT media FROM posts WHERE user_id = :id', { id: u.id })).map((p) => p.media);
    await env.DB.batch([
      q(env, 'UPDATE users SET banned = 1 WHERE id = :id', { id: u.id }),
      q(env, 'DELETE FROM sessions WHERE user_id = :id', { id: u.id }),
      q(env, 'DELETE FROM posts WHERE user_id = :id', { id: u.id }),
      q(env, 'DELETE FROM comments WHERE user_id = :id', { id: u.id }),
    ]);
    ctx.wait(Promise.all(media.map((m) => deleteMedia(env, m))));
  } else if (action === 'unban') await run(env, 'UPDATE users SET banned = 0 WHERE id = :id', { id: u.id });
  else fail(400, 'Unknown action.');
  return { ok: true };
});

// ---------- entry point ----------
export default {
  async fetch(request, env, execCtx) {
    const url = new URL(request.url);
    const wait = (p) => execCtx.waitUntil(Promise.resolve(p).catch(() => {}));
    if (url.pathname.startsWith('/media/')) return serveMedia(env, request, url.pathname.slice(7), wait);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const ctx = {
      url, wait, secure: url.protocol === 'https:', ip: request.headers.get('cf-connecting-ip') || 'local', setCookie: null, body: null,
      json: async () => { if (ctx.body === null) { try { ctx.body = await request.json(); } catch { ctx.body = {}; } } return ctx.body || {}; },
      form: async () => { try { return await request.formData(); } catch { fail(400, 'Could not read the upload. Try again.'); } },
    };
    try {
      await env.DB.prepare('PRAGMA foreign_keys = ON').run().catch(() => {});
      ctx.token = readCookie(request, 'sid');
      if (ctx.token) {
        const u = await one(env, `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = :t AND s.created_at > :min`, { t: ctx.token, min: now() - SESSION_MS });
        ctx.user = u && !u.banned ? u : null;
      }
      for (const r of routes) {
        if (r.method !== request.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const data = await r.fn(env, ctx, m.groups || {});
        return json(data, 200, ctx.setCookie ? { 'set-cookie': ctx.setCookie } : {});
      }
      return json({ error: 'Not found.' }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, ctx.setCookie ? { 'set-cookie': ctx.setCookie } : {});
      console.error(e && e.stack || e);
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  },
  // Daily cleanup of expired sessions
  async scheduled(_event, env) {
    await run(env, 'DELETE FROM sessions WHERE created_at < :t', { t: now() - SESSION_MS });
  },
};
