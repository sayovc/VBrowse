/* VBrowse hosted backend.
 * Runs in the browser on top of the Claude Artifact runtime (db + assets + user) and answers the
 * same /api/... calls the Node server does, so the frontend (app.js) is shared by both builds.
 *
 * Data layout (each person writes only their own document; the owner moderates):
 *   profiles/<uid>   {username, displayName, bio, avatar, createdAt}
 *   posts/<uid>      {items: {<postId>: post}}
 *   comments/<uid>   {items: {<commentId>: comment}}
 *   reactions/<uid>  {votes: {<postId>: 1|-1}}
 *   follows/<uid>    {following: {<uid>: ts}}
 *   clikes/<uid>     {liked: {<commentId>: 1}}
 *   views/<uid>      {seen: {<postId>: 1}}
 *   reports/<uid>    {posts: {<postId>: reason}, comments: {<commentId>: reason}}
 *   mod/state        {banned, removed, approved, cleared, removedComments, keptComments}   (owner only)
 *   data/users/<uid>/saves  {posts: {<postId>: ts}}   (private)
 */
(() => {
'use strict';

const CATEGORIES = ['comedy', 'music', 'gaming', 'sports', 'food', 'travel', 'art', 'tech', 'pets', 'fashion', 'education', 'other'];
const REPORT_THRESHOLD = 3;
const REPORT_REASONS = ['nudity', 'violence', 'hate', 'harassment', 'spam', 'other'];
const MAX_BYTES = 20 * 1024 * 1024; // platform per-file limit
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const VIDEO_TYPES = ['video/mp4', 'video/webm'];
const blockedMsg = 'That contains words that are not allowed on VBrowse. Please keep it friendly and safe for everyone.';
const USER_COLLECTIONS = ['profiles', 'posts', 'comments', 'reactions', 'follows', 'clikes', 'views', 'reports'];

let db = null, assets = null, user = null;
let uid = null, isOwner = false, canWrite = null, writeRefused = false;
const raw = Object.fromEntries(USER_COLLECTIONS.map((c) => [c, new Map()])); // collection -> uid -> body
let mod = {};
let mySaves = {};
const listeners = new Set();

// ---------- helpers ----------
const now = () => Date.now();
const newId = () => now() * 1000 + Math.floor(Math.random() * 1000); // numeric, unique enough, < 2^53
const fail = (status, error) => { const e = new Error(error); e.status = status; throw e; };
const checkText = (s) => window.VBTextFilter.checkText(s).ok;
const V = window.VBTextFilter;
const blobUrl = (id) => (id ? `/_blob/${id}` : null);
const writeQueues = new Map();
// One write at a time per document, as the store asks.
function write(path, fn) {
  const prev = writeQueues.get(path) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn).catch((e) => {
    if (e && e.code === 'invalid_argument' && !uid) fail(401, 'Sign in to Claude to take part.');
    if (e && e.code === 'invalid_argument') { writeRefused = true; fail(403, "You can browse VBrowse, but the owner hasn't given you permission to post or react yet."); }
    if (e && e.code === 'quota_exceeded') fail(507, 'VBrowse is out of storage space. Ask the owner to clean up old posts.');
    if (e && e.status) throw e;
    fail(500, (e && e.message) || 'Could not save. Try again.');
  });
  writeQueues.set(path, next);
  return next;
}
const myDoc = (col) => raw[col].get(uid) || {};
async function setMine(col, body) {
  requireMember();
  raw[col].set(uid, body); // optimistic
  await write(`${col}/${uid}`, () => db.doc(`${col}/${uid}`).set(body));
}
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

// ---------- derived views ----------
function profiles() {
  const out = new Map();
  for (const [id, p] of raw.profiles) if (p && p.username) out.set(id, p);
  return out;
}
const isBanned = (id) => !!(mod.banned && mod.banned[id]);
function allPosts() {
  const out = new Map();
  for (const [author, body] of raw.posts) {
    if (isBanned(author)) continue;
    for (const [pid, p] of Object.entries((body && body.items) || {})) {
      if (mod.removed && mod.removed[pid]) continue;
      out.set(Number(pid), { ...p, id: Number(pid), authorId: author });
    }
  }
  return out;
}
function allComments() {
  const out = new Map();
  for (const [author, body] of raw.comments) {
    if (isBanned(author)) continue;
    for (const [cid, c] of Object.entries((body && body.items) || {})) {
      if (mod.removedComments && mod.removedComments[cid]) continue;
      out.set(Number(cid), { ...c, id: Number(cid), authorId: author });
    }
  }
  return out;
}
function reportsFor(kind, id) {
  const reasons = {}; let n = 0;
  for (const [reporter, body] of raw.reports) {
    if (isBanned(reporter)) continue;
    const r = body && body[kind] && body[kind][id];
    if (r) { n++; reasons[r] = (reasons[r] || 0) + 1; }
  }
  return { n, reasons };
}
function postStatus(p) {
  const id = String(p.id);
  const rep = reportsFor('posts', id);
  const cleared = (mod.cleared && mod.cleared[id]) || 0;
  const fresh = rep.n - cleared;
  if (fresh > 0 && (fresh >= REPORT_THRESHOLD || (rep.reasons.nudity || 0) - Math.min(cleared, rep.reasons.nudity || 0) >= 2)) {
    return { status: 'pending', reason: 'Hidden after reports from the community' };
  }
  if (p.status === 'pending' && !(mod.approved && mod.approved[id])) return { status: 'pending', reason: p.modReason || 'Waiting for review' };
  return { status: 'approved', reason: '' };
}
function commentHidden(c) {
  const id = String(c.id);
  const rep = reportsFor('comments', id);
  return rep.n - ((mod.keptComments && mod.keptComments[id]) || 0) >= REPORT_THRESHOLD;
}
function userPublic(id) {
  const p = profiles().get(id);
  if (!p) return { id, username: 'unknown', displayName: 'Unknown', avatar: null, banner: null, bio: '', isAdmin: false };
  return { id, username: p.username, displayName: p.displayName || p.username, avatar: blobUrl(p.avatar), banner: blobUrl(p.banner), bio: p.bio || '', isAdmin: false };
}
function counts() {
  const likes = new Map(), dislikes = new Map(), views = new Map(), ccount = new Map(), clikes = new Map();
  for (const [voter, body] of raw.reactions) {
    if (isBanned(voter)) continue;
    for (const [pid, v] of Object.entries((body && body.votes) || {})) {
      const m = v === 1 ? likes : v === -1 ? dislikes : null;
      if (m) m.set(Number(pid), (m.get(Number(pid)) || 0) + 1);
    }
  }
  for (const [, body] of raw.views) for (const pid of Object.keys((body && body.seen) || {})) views.set(Number(pid), (views.get(Number(pid)) || 0) + 1);
  for (const c of allComments().values()) if (!commentHidden(c)) ccount.set(c.postId, (ccount.get(c.postId) || 0) + 1);
  for (const [, body] of raw.clikes) for (const cid of Object.keys((body && body.liked) || {})) clikes.set(Number(cid), (clikes.get(Number(cid)) || 0) + 1);
  return { likes, dislikes, views, ccount, clikes };
}
function isFollowing(a, b) { return !!(raw.follows.get(a) && raw.follows.get(a).following && raw.follows.get(a).following[b]); }
function serializePost(p, C = counts()) {
  const st = postStatus(p);
  const author = userPublic(p.authorId);
  return {
    id: p.id, kind: p.kind, media: blobUrl(p.media), caption: p.caption || '', category: p.category || 'other',
    tags: p.tags ? String(p.tags).split(',').filter(Boolean) : [], views: C.views.get(p.id) || 0, createdAt: p.createdAt,
    status: st.status, modReason: st.reason, likes: C.likes.get(p.id) || 0, dislikes: C.dislikes.get(p.id) || 0,
    comments: C.ccount.get(p.id) || 0, myReaction: (myDoc('reactions').votes || {})[p.id] || 0,
    saved: !!(mySaves.posts && mySaves.posts[p.id]), followingAuthor: uid ? isFollowing(uid, p.authorId) : false,
    author: { id: author.id, username: author.username, displayName: author.displayName, avatar: author.avatar },
  };
}
const canSee = (p) => postStatus(p).status === 'approved' || (uid && (p.authorId === uid || isOwner));
function visiblePost(id) {
  const p = allPosts().get(Number(id));
  if (!p || !canSee(p)) fail(404, 'Post not found.');
  return p;
}
function me() { return uid && profiles().get(uid) && !isBanned(uid) ? { ...userPublic(uid), isAdmin: isOwner } : null; }
function requireMember() {
  if (!uid) fail(401, 'Sign in to Claude to take part.');
  if (writeRefused) fail(403, "You can browse VBrowse, but the owner hasn't given you permission to post or react yet.");
  if (isBanned(uid)) fail(403, 'This account has been suspended for breaking the community rules.');
}
function requireProfile() { requireMember(); if (!profiles().get(uid)) fail(401, 'Create your VBrowse profile first.'); }
function parseTags(field, caption) {
  const fromField = String(field || '').toLowerCase().split(/[\s,#]+/);
  const fromCaption = (String(caption || '').toLowerCase().match(/#[a-z0-9_]{1,40}/g) || []).map((t) => t.slice(1));
  const clean = [...fromField, ...fromCaption].map((t) => t.replace(/[^a-z0-9_]/g, '').slice(0, 40)).filter(Boolean);
  return [...new Set(clean)].slice(0, 15).join(',');
}

// ---------- NSFW scanning in the browser ----------
let modelPromise = null;
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load failed')); document.head.appendChild(s); });
}
function loadModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      // The nsfwjs browser bundle includes TensorFlow.js. Its model files are separate scripts that
      // must be loaded first (they register globals the bundle picks up), as nsfwjs's docs describe.
      const base = 'https://cdn.jsdelivr.net/npm/nsfwjs@4.4.0/dist';
      if (!window.nsfwjs) {
        for (const f of ['model.min.js', 'group1-shard1of2.min.js', 'group1-shard2of2.min.js']) await loadScript(`${base}/models/mobilenet_v2_mid/${f}`);
        await loadScript(`${base}/browser/nsfwjs.min.js`);
      }
      return window.nsfwjs.load('MobileNetV2Mid');
    })().catch((e) => { modelPromise = null; throw e; });
  }
  return modelPromise;
}
function decide(preds) {
  const s = Object.fromEntries(preds.map((p) => [p.className, p.probability]));
  const explicit = (s.Porn || 0) + (s.Hentai || 0), sexy = s.Sexy || 0;
  return explicit >= 0.5 ? 'reject' : (explicit >= 0.2 || sexy >= 0.7) ? 'review' : 'ok';
}
const rank = { ok: 0, review: 1, reject: 2 };
async function scanFile(file) {
  try {
    const model = await loadModel();
    const url = URL.createObjectURL(file);
    try {
      if (file.type.startsWith('image/')) {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
        return decide(await model.classify(img));
      }
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; setTimeout(() => rej(new Error('timeout')), 20000); });
      const canvas = document.createElement('canvas'); canvas.width = 224; canvas.height = 224;
      const ctx = canvas.getContext('2d');
      const d = v.duration && isFinite(v.duration) ? v.duration : 1;
      let worst = 'ok';
      for (let i = 0; i < 8; i++) {
        v.currentTime = (d * (i + 0.5)) / 8;
        await new Promise((res) => { v.onseeked = res; setTimeout(res, 3000); });
        ctx.drawImage(v, 0, 0, 224, 224);
        const verdict = decide(await model.classify(canvas));
        if (rank[verdict] > rank[worst]) worst = verdict;
        if (worst === 'reject') break;
      }
      return worst;
    } finally { URL.revokeObjectURL(url); }
  } catch (e) {
    console.warn('Safety scan unavailable:', e && e.message);
    return 'unavailable'; // fail safe: held for review
  }
}

// ---------- routes ----------
const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });

on('GET', '/api/me', () => ({
  user: me(), categories: CATEGORIES,
  hosted: { signedIn: !!uid, banned: !!(uid && isBanned(uid)), canWrite: !!uid && !writeRefused && canWrite !== false && !isBanned(uid), isOwner, hasProfile: !!(uid && profiles().get(uid)) },
}));

const handleTaken = (h) => { for (const [id, p] of profiles()) if (id !== uid && p.username === h) return true; return false; };
on('GET', '/api/handle-check', (_p, q) => {
  const h = String(q.get('h') || '').trim().replace(/^@/, '').toLowerCase();
  const err = V.validateHandle(h);
  if (err) return { ok: false, error: err };
  return handleTaken(h) ? { ok: false, error: `@${h} is taken.` } : { ok: true };
});
on('POST', '/api/signup', async (_p, _q, body) => {
  requireMember();
  const username = String(body.username || '').trim().replace(/^@/, '').toLowerCase();
  const displayName = V.cleanName(body.displayName);
  const err = V.validateName(displayName) || V.validateHandle(username);
  if (err) fail(400, err);
  if (handleTaken(username)) fail(409, `@${username} is taken. Try another handle.`);
  const cur = myDoc('profiles');
  await setMine('profiles', { ...cur, username, displayName, bio: cur.bio || '', avatar: cur.avatar || null, banner: cur.banner || null, createdAt: cur.createdAt || now() });
  return { user: me() };
});
on('POST', '/api/login', () => fail(400, 'No password needed: VBrowse uses your Claude account.'));
on('POST', '/api/logout', () => ({ ok: true }));

async function uploadChecked(file, what) {
  if (!IMAGE_TYPES.includes(file.type)) fail(400, `${what} must be a JPG, PNG, GIF or WEBP image.`);
  if (file.size > MAX_BYTES) fail(400, `${what} is too big (max 20 MB).`);
  if ((await scanFile(file)) !== 'ok') fail(400, 'That image was blocked by our safety check. Please choose a different one.');
  if (!assets) fail(403, "Uploading images isn't available for your account on this page.");
  return (await assets.upload(file)).id;
}
on('PATCH', '/api/me', async (_p, _q, fd) => {
  requireProfile();
  const cur = clone(myDoc('profiles'));
  const displayName = fd.get('displayName') != null ? V.cleanName(fd.get('displayName')) : cur.displayName;
  const username = fd.get('username') != null ? String(fd.get('username')).trim().replace(/^@/, '').toLowerCase() : cur.username;
  const bio = fd.get('bio') != null ? String(fd.get('bio')).replace(/\r/g, '').trim().slice(0, 1000) : cur.bio;
  const err = V.validateName(displayName) || (username !== cur.username ? V.validateHandle(username) : '');
  if (err) fail(400, err);
  if (bio && !checkText(bio)) fail(400, blockedMsg);
  if (username !== cur.username && handleTaken(username)) fail(409, `@${username} is taken. Try another handle.`);
  const avatar = fd.get('avatar'), banner = fd.get('banner');
  const old = [];
  if (avatar && avatar.size) { old.push(cur.avatar); cur.avatar = await uploadChecked(avatar, 'Profile picture'); }
  else if (fd.get('removeAvatar') === '1') { old.push(cur.avatar); cur.avatar = null; }
  if (banner && banner.size) { old.push(cur.banner); cur.banner = await uploadChecked(banner, 'Banner'); }
  else if (fd.get('removeBanner') === '1') { old.push(cur.banner); cur.banner = null; }
  await setMine('profiles', { ...cur, displayName, username, bio });
  if (assets) old.filter(Boolean).forEach((id) => assets.delete(id).catch(() => {}));
  return { user: me() };
});
on('PATCH', '/api/account', () => fail(400, 'Your email and password are managed by your Claude account.'));
on('DELETE', '/api/account', async () => {
  requireMember();
  const mediaIds = Object.values(myDoc('posts').items || {}).map((p) => p.media).concat([myDoc('profiles').avatar, myDoc('profiles').banner]).filter(Boolean);
  for (const col of USER_COLLECTIONS) {
    if (!raw[col].has(uid)) continue;
    raw[col].delete(uid);
    await write(`${col}/${uid}`, () => db.doc(`${col}/${uid}`).delete());
  }
  mySaves = {};
  await write(`data/users/${uid}/saves`, () => db.doc(`data/users/${uid}/saves`).delete());
  if (assets) mediaIds.forEach((id) => assets.delete(id).catch(() => {}));
  return { ok: true };
});

on('GET', '/api/posts', (_p, q) => {
  const C = counts();
  const sort = q.get('sort') || 'latest';
  const kind = q.get('kind'), category = q.get('category'), search = (q.get('q') || '').toLowerCase();
  const userQ = (q.get('user') || '').toLowerCase(), tag = (q.get('tag') || '').toLowerCase(), saved = q.get('saved') === '1';
  const limit = Math.min(parseInt(q.get('limit'), 10) || 12, 50), offset = Math.max(parseInt(q.get('offset'), 10) || 0, 0);
  const profs = profiles();
  let list = [...allPosts().values()].filter((p) => {
    const st = postStatus(p).status;
    const author = profs.get(p.authorId);
    const ownView = userQ && uid && author && author.username === userQ && p.authorId === uid;
    if (!(st === 'approved' || (ownView && st === 'pending'))) return false;
    if (['video', 'image', 'text'].includes(kind) && p.kind !== kind) return false;
    if (CATEGORIES.includes(category) && p.category !== category) return false;
    if (userQ && (!author || author.username !== userQ)) return false;
    if (tag && !(`,${p.tags || ''},`).includes(`,${tag},`)) return false;
    if (search && !`${p.caption} ${p.tags} ${author ? author.username + ' ' + author.displayName : ''}`.toLowerCase().includes(search)) return false;
    if (saved && !(mySaves.posts && mySaves.posts[p.id])) return false;
    if (sort === 'following' && !(uid && isFollowing(uid, p.authorId))) return false;
    return true;
  });
  if (saved && !uid) fail(401, 'Log in to see saved posts.');
  if (sort === 'following' && !me()) fail(401, 'Log in to see posts from people you follow.');
  const L = (p) => C.likes.get(p.id) || 0, D = (p) => C.dislikes.get(p.id) || 0, V = (p) => C.views.get(p.id) || 0, K = (p) => C.ccount.get(p.id) || 0;
  const t = now();
  const trend = (p) => { const h = (t - p.createdAt) / 3600000 + 2; return ((L(p) - D(p)) + K(p) * 2 + V(p) * 0.05 + 1) / (h * Math.sqrt(h)); };
  const sorters = {
    latest: (a, b) => b.createdAt - a.createdAt, following: (a, b) => b.createdAt - a.createdAt, oldest: (a, b) => a.createdAt - b.createdAt,
    top: (a, b) => (L(b) - D(b)) - (L(a) - D(a)) || L(b) - L(a) || b.createdAt - a.createdAt,
    views: (a, b) => V(b) - V(a) || b.createdAt - a.createdAt, discussed: (a, b) => K(b) - K(a) || b.createdAt - a.createdAt,
    trending: (a, b) => trend(b) - trend(a),
  };
  list.sort(sorters[sort] || sorters.latest);
  const page = list.slice(offset, offset + limit);
  return { posts: page.map((p) => serializePost(p, C)), nextOffset: offset + limit < list.length ? offset + limit : null };
});

on('GET', '/api/posts/:id', ({ id }) => ({ post: serializePost(visiblePost(id)) }));

on('POST', '/api/posts', async (_p, _q, fd, opts = {}) => {
  requireProfile();
  const file = fd.get('media');
  const caption = String(fd.get('caption') || '').trim().slice(0, 2200);
  const category = CATEGORIES.includes(fd.get('category')) ? fd.get('category') : 'other';
  const tags = parseTags(fd.get('tags'), caption);
  let kind = 'text', media = null, status = 'approved', modReason = '';
  if (!file && !caption) fail(400, 'Add a photo, video, or write something.');
  if (!checkText(`${caption} ${tags}`)) fail(400, blockedMsg);
  if (file) {
    if (!IMAGE_TYPES.includes(file.type) && !VIDEO_TYPES.includes(file.type)) fail(400, 'Only JPG, PNG, GIF, WEBP images or MP4 / WEBM videos are allowed here.');
    if (file.size > MAX_BYTES) fail(400, 'File is too big — the limit is 20 MB per upload.');
    kind = VIDEO_TYPES.includes(file.type) ? 'video' : 'image';
    opts.onStage?.('Running safety check…');
    const verdict = await scanFile(file);
    if (verdict === 'reject') fail(400, 'This upload was blocked: our safety check detected nudity or sexual content, which is not allowed on VBrowse.');
    if (verdict === 'review') { status = 'pending'; modReason = 'Possibly sensitive content (auto-flagged)'; }
    if (verdict === 'unavailable') { status = 'pending'; modReason = 'Automatic safety check unavailable'; }
    if (!assets) fail(403, "Uploading photos and videos isn't available for your account on this page. You can still make text posts.");
    opts.onStage?.('Uploading…');
    try { media = (await assets.upload(file)).id; }
    catch (e) {
      const msg = { too_large: 'File is too big — the limit is 20 MB per upload.', unsupported_type: 'That file type is not supported.',
        quota_or_state: 'VBrowse is out of storage space.', rate_limited: 'Too many uploads — wait a moment.' }[e && e.code];
      fail(400, msg || 'Upload failed. Try again.');
    }
  }
  if (isOwner && status === 'pending' && modReason.startsWith('Automatic')) { status = 'approved'; modReason = ''; } // owner's own posts skip the queue when the scanner is down
  const pid = newId();
  const body = clone(myDoc('posts'));
  body.items = body.items || {};
  body.items[pid] = { kind, media, caption, category, tags, status, modReason, createdAt: now() };
  await setMine('posts', body);
  return { post: serializePost({ ...body.items[pid], id: pid, authorId: uid }) };
});

on('PATCH', '/api/posts/:id', async ({ id }, _q, body) => {
  requireProfile();
  const mine = clone(myDoc('posts'));
  const p = mine.items && mine.items[id];
  if (!p) fail(403, 'You can only edit your own posts.');
  const caption = body.caption != null ? String(body.caption).trim().slice(0, 2200) : p.caption;
  if (!checkText(caption)) fail(400, blockedMsg);
  p.caption = caption; p.tags = parseTags(p.tags, caption);
  if (CATEGORIES.includes(body.category)) p.category = body.category;
  await setMine('posts', mine);
  return { post: serializePost({ ...p, id: Number(id), authorId: uid }) };
});

on('DELETE', '/api/posts/:id', async ({ id }) => {
  requireMember();
  const mine = clone(myDoc('posts'));
  if (mine.items && mine.items[id]) {
    const media = mine.items[id].media;
    delete mine.items[id];
    await setMine('posts', mine);
    if (media && assets) assets.delete(media).catch(() => {});
    return { ok: true };
  }
  if (isOwner) { await setMod((m) => { (m.removed = m.removed || {})[id] = true; }); return { ok: true }; }
  fail(403, 'You can only delete your own posts.');
});

on('POST', '/api/posts/:id/react', async ({ id }, _q, body) => {
  requireProfile(); visiblePost(id);
  const value = Number(body.value);
  if (![1, -1, 0].includes(value)) fail(400, 'Invalid reaction.');
  const r = clone(myDoc('reactions')); r.votes = r.votes || {};
  if (value === 0) delete r.votes[id]; else r.votes[id] = value;
  await setMine('reactions', r);
  return { post: serializePost(visiblePost(id)) };
});

on('POST', '/api/posts/:id/save', async ({ id }) => {
  requireProfile(); visiblePost(id);
  const s = clone(mySaves); s.posts = s.posts || {};
  const saved = !s.posts[id];
  if (saved) s.posts[id] = now(); else delete s.posts[id];
  mySaves = s;
  await write(`data/users/${uid}/saves`, () => db.doc(`data/users/${uid}/saves`).set(s));
  return { saved };
});

on('POST', '/api/posts/:id/view', async ({ id }) => {
  if (uid && !writeRefused && !isBanned(uid) && profiles().get(uid)) {
    const v = myDoc('views');
    if (!(v.seen && v.seen[id])) {
      const nv = clone(v); nv.seen = nv.seen || {}; nv.seen[id] = 1;
      setMine('views', nv).catch(() => {});
    }
  }
  return { views: counts().views.get(Number(id)) || 0 };
});

on('POST', '/api/posts/:id/report', async ({ id }, _q, body) => {
  requireProfile();
  const p = visiblePost(id);
  if (p.authorId === uid) fail(400, "You can't report your own post.");
  const r = clone(myDoc('reports')); r.posts = r.posts || {};
  r.posts[id] = REPORT_REASONS.includes(body.reason) ? body.reason : 'other';
  await setMine('reports', r);
  return { ok: true };
});

function serializeComment(c, C) {
  const a = userPublic(c.authorId);
  return {
    id: c.id, postId: c.postId, parentId: c.parentId || null, body: c.body, createdAt: c.createdAt,
    likes: C.clikes.get(c.id) || 0, liked: !!((myDoc('clikes').liked || {})[c.id]), hidden: commentHidden(c),
    author: { id: a.id, username: a.username, displayName: a.displayName, avatar: a.avatar },
  };
}
on('GET', '/api/posts/:id/comments', ({ id }, q) => {
  visiblePost(id);
  const C = counts();
  const list = [...allComments().values()].filter((c) => c.postId === Number(id) && (!commentHidden(c) || isOwner)).map((c) => serializeComment(c, C));
  if (q.get('sort') === 'new') list.sort((a, b) => b.createdAt - a.createdAt);
  else list.sort((a, b) => b.likes - a.likes || a.createdAt - b.createdAt);
  return { comments: list };
});
on('POST', '/api/posts/:id/comments', async ({ id }, _q, body) => {
  requireProfile(); visiblePost(id);
  const text = String(body.body || '').trim().slice(0, 1000);
  if (!text) fail(400, 'Comment cannot be empty.');
  if (!checkText(text)) fail(400, blockedMsg);
  let parentId = body.parentId ? Number(body.parentId) : null;
  if (parentId) {
    const parent = allComments().get(parentId);
    if (!parent || parent.postId !== Number(id)) fail(400, 'Replying to a comment that no longer exists.');
    parentId = parent.parentId || parent.id;
  }
  const cid = newId();
  const mine = clone(myDoc('comments')); mine.items = mine.items || {};
  mine.items[cid] = { postId: Number(id), parentId, body: text, createdAt: now() };
  await setMine('comments', mine);
  return { comment: serializeComment({ ...mine.items[cid], id: cid, authorId: uid }, counts()) };
});
on('DELETE', '/api/comments/:id', async ({ id }) => {
  requireMember();
  const mine = clone(myDoc('comments'));
  if (mine.items && mine.items[id]) { delete mine.items[id]; await setMine('comments', mine); return { ok: true }; }
  if (isOwner) { await setMod((m) => { (m.removedComments = m.removedComments || {})[id] = true; }); return { ok: true }; }
  fail(403, "Only moderators can remove other people's comments — use Report instead.");
});
on('POST', '/api/comments/:id/like', async ({ id }) => {
  requireProfile();
  if (!allComments().get(Number(id))) fail(404, 'Comment not found.');
  const l = clone(myDoc('clikes')); l.liked = l.liked || {};
  const liked = !l.liked[id];
  if (liked) l.liked[id] = 1; else delete l.liked[id];
  await setMine('clikes', l);
  return { liked, likes: counts().clikes.get(Number(id)) || 0 };
});
on('POST', '/api/comments/:id/report', async ({ id }, _q, body) => {
  requireProfile();
  const c = allComments().get(Number(id));
  if (!c) fail(404, 'Comment not found.');
  if (c.authorId === uid) fail(400, "You can't report your own comment.");
  const r = clone(myDoc('reports')); r.comments = r.comments || {};
  r.comments[id] = REPORT_REASONS.includes(body.reason) ? body.reason : 'other';
  await setMine('reports', r);
  return { ok: true };
});

const byUsername = (name) => {
  for (const [id, p] of profiles()) if (p.username === String(name).toLowerCase() && (!isBanned(id) || isOwner)) return id;
  return null;
};
on('GET', '/api/users/:username', ({ username }) => {
  const id = byUsername(decodeURIComponent(username));
  if (!id) fail(404, 'User not found.');
  const C = counts();
  const posts = [...allPosts().values()].filter((p) => p.authorId === id && postStatus(p).status === 'approved');
  let followers = 0;
  for (const [f, body] of raw.follows) if (!isBanned(f) && body && body.following && body.following[id]) followers++;
  const following = Object.keys((raw.follows.get(id) || {}).following || {}).length;
  const p = profiles().get(id);
  return { user: { ...userPublic(id), createdAt: p.createdAt, followers, following, posts: posts.length,
    likes: posts.reduce((n, x) => n + (C.likes.get(x.id) || 0), 0), isFollowing: uid ? isFollowing(uid, id) : false, isMe: id === uid } };
});
on('POST', '/api/users/:username/follow', async ({ username }) => {
  requireProfile();
  const id = byUsername(decodeURIComponent(username));
  if (!id) fail(404, 'User not found.');
  if (id === uid) fail(400, "You can't follow yourself.");
  const f = clone(myDoc('follows')); f.following = f.following || {};
  const isF = !f.following[id];
  if (isF) f.following[id] = now(); else delete f.following[id];
  await setMine('follows', f);
  let followers = 0;
  for (const [, body] of raw.follows) if (body && body.following && body.following[id]) followers++;
  return { isFollowing: isF, followers };
});
on('GET', '/api/users/:username/followers', ({ username }) => {
  const id = byUsername(decodeURIComponent(username));
  if (!id) fail(404, 'User not found.');
  const ids = [...raw.follows].filter(([f, b]) => !isBanned(f) && b && b.following && b.following[id] && profiles().get(f)).map(([f]) => f);
  return { users: ids.map(userPublic) };
});
on('GET', '/api/users/:username/following', ({ username }) => {
  const id = byUsername(decodeURIComponent(username));
  if (!id) fail(404, 'User not found.');
  return { users: Object.keys((raw.follows.get(id) || {}).following || {}).filter((x) => profiles().get(x) && !isBanned(x)).map(userPublic) };
});
on('GET', '/api/tags/popular', () => {
  const n = {};
  for (const p of allPosts().values()) if (postStatus(p).status === 'approved') for (const t of String(p.tags || '').split(',').filter(Boolean)) n[t] = (n[t] || 0) + 1;
  return { tags: Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t]) => t) };
});

// ---------- moderation (artifact owner) ----------
async function setMod(fn) {
  if (!isOwner) fail(403, 'Moderators only.');
  const m = clone(mod); fn(m); mod = m;
  await write('mod/state', () => db.doc('mod/state').set(m));
}
on('GET', '/api/mod/queue', () => {
  if (!isOwner) fail(403, 'Moderators only.');
  const C = counts();
  const reasonsList = (r) => Object.entries(r.reasons).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n);
  const posts = [...allPosts().values()].filter((p) => postStatus(p).status === 'pending' || reportsFor('posts', String(p.id)).n > ((mod.cleared || {})[p.id] || 0))
    .sort((a, b) => (postStatus(b).status === 'pending') - (postStatus(a).status === 'pending') || b.createdAt - a.createdAt)
    .map((p) => ({ ...serializePost(p, C), modReason: postStatus(p).reason, reports: reasonsList(reportsFor('posts', String(p.id))) }));
  const comments = [...allComments().values()].filter((c) => reportsFor('comments', String(c.id)).n > ((mod.keptComments || {})[c.id] || 0))
    .map((c) => ({ ...serializeComment(c, C), reports: reasonsList(reportsFor('comments', String(c.id))) }));
  return { posts, comments };
});
on('POST', '/api/mod/posts/:id', async ({ id }, _q, body) => {
  if (body.action === 'approve') await setMod((m) => { (m.approved = m.approved || {})[id] = true; (m.cleared = m.cleared || {})[id] = reportsFor('posts', id).n; });
  else if (body.action === 'remove') await setMod((m) => { (m.removed = m.removed || {})[id] = true; });
  else fail(400, 'Unknown action.');
  return { ok: true };
});
on('POST', '/api/mod/comments/:id', async ({ id }, _q, body) => {
  if (body.action === 'keep') await setMod((m) => { (m.keptComments = m.keptComments || {})[id] = reportsFor('comments', id).n; });
  else if (body.action === 'remove') await setMod((m) => { (m.removedComments = m.removedComments || {})[id] = true; });
  else fail(400, 'Unknown action.');
  return { ok: true };
});
on('POST', '/api/mod/users/:username', async ({ username }, _q, body) => {
  const id = byUsername(decodeURIComponent(username));
  if (!id) fail(404, 'User not found.');
  if (id === uid) fail(400, "You can't ban yourself.");
  if (body.action === 'ban') await setMod((m) => { (m.banned = m.banned || {})[id] = true; });
  else if (body.action === 'unban') await setMod((m) => { if (m.banned) delete m.banned[id]; });
  else fail(400, 'Unknown action.');
  return { ok: true };
});

// ---------- request entry point ----------
async function request(method, url, body, opts) {
  await ready;
  const u = new URL(url, 'http://x');
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = u.pathname.match(r.re);
    if (m) return r.fn(m.groups || {}, u.searchParams, body || {}, opts);
  }
  fail(404, 'Not found.');
}

// ---------- boot: connect to the runtime and load everything ----------
let status = 'loading';
const ready = (async () => {
  const use = (n) => (window.claude && window.claude.use ? window.claude.use(n).catch(() => null) : Promise.resolve(null));
  [db, user, assets] = await Promise.all([use('db'), use('user'), use('assets')]);
  if (!db) { status = 'nodb'; return; }
  if (user) {
    uid = await user.id();
    isOwner = await user.isOwner();
    canWrite = await user.can('data.write');
    if (canWrite === false) writeRefused = true;
  }
  const firstLoads = [];
  const sub = (ref, onData) => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    setTimeout(finish, 10000);
    ref.onSnapshot((snap) => { onData(snap); if (!snap.metadata.fromCache) finish(); listeners.forEach((f) => f()); }, () => finish());
  });
  for (const col of USER_COLLECTIONS) {
    firstLoads.push(sub(db.collection(col), (snap) => {
      const m = new Map();
      for (const d of snap.docs) m.set(d.id, d.data());
      // keep our own optimistic body while our write is pending
      if (uid && raw[col].has(uid) && snap.metadata.hasPendingWrites) m.set(uid, raw[col].get(uid));
      raw[col] = m;
    }));
  }
  firstLoads.push(sub(db.doc('mod/state'), (snap) => { mod = snap.exists ? clone(snap.data()) : {}; }));
  if (uid) firstLoads.push(sub(db.doc(`data/users/${uid}/saves`), (snap) => { mySaves = snap.exists ? clone(snap.data()) : {}; }));
  await Promise.all(firstLoads);
  status = 'ready';
})();

window.VBBackend = {
  request, ready, onChange: (f) => listeners.add(f), status: () => status,
  limits: { maxBytes: MAX_BYTES, accept: [...VIDEO_TYPES, ...IMAGE_TYPES].join(',') },
};
})();
