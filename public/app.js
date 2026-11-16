/* VBrowse (VibeBrowse) — client app (vanilla JS, hash router) */
(() => {
'use strict';

// ---------------- state ----------------
const state = {
  me: null,
  categories: [],
  filters: { sort: 'trending', kind: '', category: '', q: '', tag: '' },
  hosted: null, // set when running as a Claude-hosted page (see hosted/backend.js)
  limits: null, // what the server supports: { maxUploadMB, clientScan, accept }
  posts: new Map(), // id -> post (cache, used to sync UI everywhere)
};
const $app = document.getElementById('app');
const $modal = document.getElementById('modalRoot');
let cleanupView = () => {};
const scrollMemo = new Map(); // feed -> { y, count } so going back keeps your place

// ---------------- helpers ----------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K' : String(n);
function ago(t) {
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, sec] of units) if (s >= sec) { const n = Math.floor(s / sec); return `${n} ${u}${n > 1 ? 's' : ''} ago`; }
  return 'just now';
}
// Soft tints (defined per theme in styles.css) for avatars without a photo and for text posts
const TINTS = 6;
const hash = (str) => [...String(str)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const tintFor = (key) => `var(--tint-${(hash(key) % TINTS) + 1})`;

function avatar(u, size = '') {
  if (u.avatar) return `<img class="avatar ${size}" src="${esc(u.avatar)}" alt="">`;
  const name = u.displayName || u.username || '?';
  return `<span class="avatar ${size}" style="background:${tintFor(u.username)}" aria-hidden="true">${esc([...name][0])}</span>`;
}
// Escape, then link #tags and @mentions
function richText(s) {
  return esc(s)
    .replace(/(^|\s)#([a-zA-Z0-9_]{1,40})/g, '$1<a class="hashtag" href="#/tag/$2">#$2</a>')
    .replace(/(^|\s)@([a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,28}[a-zA-Z0-9])?)/g, '$1<a class="mention" href="#/u/$2">@$2</a>');
}
const titleOf = (p) => (p.caption || '').split('\n')[0] || (p.kind === 'video' ? 'Untitled video' : p.kind === 'image' ? 'Untitled photo' : 'Post');
const plural = (n, word, many = word + 's') => `${fmt(n)} ${n === 1 ? word : many}`;

// ---------------- icons ----------------
// VBrowse's own icon set: 24px grid, 1.8px rounded strokes. Filled variants mark "on" states.
const PATHS = {
  home: '<path d="M4 10.8 12 4.5l8 6.3V19a1.2 1.2 0 0 1-1.2 1.2H15v-5.4H9v5.4H5.2A1.2 1.2 0 0 1 4 19z"/>',
  scroll: '<rect x="6.5" y="3" width="11" height="18" rx="3"/><path d="M10.8 9.6v4.8l3.9-2.4z" fill="currentColor"/>',
  people: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.7-3.2 2.9-4.9 5.5-4.9s4.8 1.7 5.5 4.9"/><path d="M18.5 8v5.5M15.75 10.75h5.5"/>',
  bookmark: '<path d="M7.2 4h9.6c.66 0 1.2.54 1.2 1.2V20l-6-3.8L6 20V5.2C6 4.54 6.54 4 7.2 4z"/>',
  user: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.9-3.7 3.7-5.6 7-5.6s6.1 1.9 7 5.6"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  search: '<circle cx="10.8" cy="10.8" r="6"/><path d="m20 20-4.6-4.6"/>',
  upload: '<path d="M12 15.5V4.5M7.6 8.6 12 4.2l4.4 4.4M5 14.5v3.3A2.2 2.2 0 0 0 7.2 20h9.6a2.2 2.2 0 0 0 2.2-2.2v-3.3"/>',
  heart: '<path d="M12 19.6s-7.6-4.5-7.6-10A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.6 2.6c0 5.5-7.6 10-7.6 10z"/>',
  thumbUp: '<path d="M8.5 20.2h7a2 2 0 0 0 1.9-1.4l1.8-5.8a2 2 0 0 0-1.9-2.6H13.8l.6-3.3a1.9 1.9 0 0 0-1.9-2.3L8.5 10.6z"/><path d="M8.5 10.6H5.6a.9.9 0 0 0-.9.9v7.8c0 .5.4.9.9.9h2.9"/>',
  thumbDown: '<path d="M15.5 3.8h-7a2 2 0 0 0-1.9 1.4L4.8 11a2 2 0 0 0 1.9 2.6h3.5l-.6 3.3a1.9 1.9 0 0 0 1.9 2.3l4-5.8z"/><path d="M15.5 13.4h2.9c.5 0 .9-.4.9-.9V4.7a.9.9 0 0 0-.9-.9h-2.9"/>',
  comment: '<path d="M5 7a2.6 2.6 0 0 1 2.6-2.6h8.8A2.6 2.6 0 0 1 19 7v6.6a2.6 2.6 0 0 1-2.6 2.6h-5.2L7 19.6v-3.4A2.3 2.3 0 0 1 5 13.9z"/>',
  share: '<path d="M14.2 5.2 20 10.6l-5.8 5.4M19.6 10.6H12a7 7 0 0 0-7 7v.8"/>',
  dots: '<circle cx="12" cy="5.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.5" fill="currentColor" stroke="none"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  soundOn: '<path d="M4 9.6h3.2L12 5.6v12.8l-4.8-4H4z"/><path d="M15.6 9.2a4 4 0 0 1 0 5.6M18.2 6.6a7.6 7.6 0 0 1 0 10.8"/>',
  soundOff: '<path d="M4 9.6h3.2L12 5.6v12.8l-4.8-4H4z"/><path d="m16 9.6 4.8 4.8M20.8 9.6 16 14.4"/>',
  play: '<path d="M8.4 5.9v12.2a.8.8 0 0 0 1.2.7l9.6-6.1a.8.8 0 0 0 0-1.4L9.6 5.2a.8.8 0 0 0-1.2.7z"/>',
  flag: '<path d="M6 20.5V4.2M6 4.8h10.3l-2 3.9 2 3.9H6"/>',
  shield: '<path d="M12 3.6 18.6 6v5.6c0 4.1-2.8 7.4-6.6 8.8-3.8-1.4-6.6-4.7-6.6-8.8V6z"/><path d="m9.2 12 2 2 3.8-3.9"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.8V12l2.8 1.8"/>',
  eye: '<path d="M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.7"/>',
  check: '<path d="m5.5 12.6 4.2 4.2 8.8-9.4"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 3v1.8M12 19.2V21M3 12h1.8M19.2 12H21M5.6 5.6l1.3 1.3M17.1 17.1l1.3 1.3M5.6 18.4l1.3-1.3M17.1 6.9l1.3-1.3"/>',
  moon: '<path d="M19.4 14.6A7.6 7.6 0 0 1 9.4 4.6a7.6 7.6 0 1 0 10 10z"/>',
  monitor: '<rect x="3.2" y="4.6" width="17.6" height="11.8" rx="2"/><path d="M9 20h6M12 16.4V20"/>',
  trash: '<path d="M4.8 7h14.4M9.8 7V5.2h4.4V7M7 7l.9 11.7a1.6 1.6 0 0 0 1.6 1.5h5a1.6 1.6 0 0 0 1.6-1.5L17 7"/>',
  pencil: '<path d="m4.8 19.2.9-3.9 9.8-9.8a2.1 2.1 0 0 1 3 3l-9.8 9.8z"/><path d="m13.8 7.2 3 3"/>',
  logout: '<path d="M13.8 4.5h4a1.2 1.2 0 0 1 1.2 1.2v12.6a1.2 1.2 0 0 1-1.2 1.2h-4M10 8.2 6.2 12l3.8 3.8M6.4 12h8.8"/>',
  sliders: '<path d="M4.5 7.5h8M16.5 7.5h3M4.5 16.5h3M11.5 16.5h8"/><circle cx="14.5" cy="7.5" r="2"/><circle cx="9.5" cy="16.5" r="2"/>',
  video: '<rect x="3.5" y="6" width="12.5" height="12" rx="2.2"/><path d="m16 10.4 4.5-2.6v8.4L16 13.6"/>',
  image: '<rect x="3.8" y="4.8" width="16.4" height="14.4" rx="2.2"/><circle cx="9.2" cy="10" r="1.6"/><path d="m4.6 17.4 4.6-4.2 3.4 3 2.6-2.2 4.2 3.6"/>',
  text: '<path d="M5.5 7V5.2h13V7M12 5.2v13.6M9.4 18.8h5.2"/>',
  info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".6" fill="currentColor"/>',
  book: '<path d="M5.2 5.6A1.6 1.6 0 0 1 6.8 4H19v13.6H6.8a1.6 1.6 0 0 0-1.6 1.6z"/><path d="M5.2 19.2a1.6 1.6 0 0 0 1.6 1.6H19"/>',
  chevronDown: '<path d="m7 10 5 5 5-5"/>',
  chevronUp: '<path d="m7 14 5-5 5 5"/>',
  camera: '<path d="M4 8.6a1.8 1.8 0 0 1 1.8-1.8h2.1l1.4-2h5.4l1.4 2h2.1A1.8 1.8 0 0 1 20 8.6v8.6a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 17.2z"/><circle cx="12" cy="12.6" r="3.3"/>',
  key: '<circle cx="8" cy="15" r="3.6"/><path d="m10.6 12.4 7.6-7.6M15.6 7.4l2.4 2.4M13.6 9.4l1.6 1.6"/>',
  mail: '<rect x="3.6" y="5.6" width="16.8" height="12.8" rx="2"/><path d="m4.4 7 7.6 5.6L19.6 7"/>',
};
function icon(name, { fill = false, size = 0, cls = '' } = {}) {
  const dim = size ? ` width="${size}" height="${size}"` : '';
  return `<svg class="ic ${cls}" viewBox="0 0 24 24"${dim} fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name] || ''}</svg>`;
}
const ICON = {
  like: icon('heart', { fill: true }), likeOutline: icon('heart'),
  thumbUp: icon('thumbUp'), thumbUpOn: icon('thumbUp', { fill: true }),
  thumbDown: icon('thumbDown'), thumbDownOn: icon('thumbDown', { fill: true }),
  comment: icon('comment'), save: icon('bookmark'), saveOn: icon('bookmark', { fill: true }), share: icon('share'),
  close: icon('close', { size: 22 }), dots: icon('dots', { size: 20 }),
  muted: icon('soundOff', { size: 20 }), sound: icon('soundOn', { size: 20 }),
  play: icon('play', { fill: true, size: 34 }), upload: icon('upload'),
};
// Fill static <i data-ic="name"> placeholders (sidebar, logo) with real icons
function hydrateIcons(root = document) { root.querySelectorAll('i[data-ic]').forEach((el) => { el.outerHTML = icon(el.dataset.ic); }); }

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

const HOSTED = !!window.VBBackend;
async function api(path, opts = {}) {
  if (HOSTED) return window.VBBackend.request(opts.method || 'GET', path, opts.body, opts);
  const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, init);
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`);
    e.status = res.status; throw e;
  }
  return data;
}

function requireLogin(reason) {
  if (state.me) return true;
  if (HOSTED && !(state.hosted && state.hosted.canWrite)) {
    toast(state.hosted && state.hosted.signedIn ? "You can browse, but the owner hasn't given you permission to post or react yet." : 'Sign in to Claude to take part.', true);
    return false;
  }
  openAuth('signup', reason);
  return false;
}

// ---------------- post sync ----------------
// Every rendered post part carries data-pid; when a post changes we refresh those parts.
function cachePost(p) { state.posts.set(p.id, p); return p; }
function refreshPost(p) {
  cachePost(p);
  document.querySelectorAll(`[data-pid="${p.id}"][data-part]`).forEach((el) => {
    const part = el.dataset.part;
    if (part === 'rail') el.innerHTML = railInner(p);
    else if (part === 'pills') el.innerHTML = pillsInner(p);
    else if (part === 'stats') el.innerHTML = statsInner(p);
  });
}

async function react(id, value) {
  if (!requireLogin('Sign up to like and dislike posts.')) return;
  const p = state.posts.get(id);
  if (p) { // optimistic update
    const old = p.myReaction;
    const next = { ...p, myReaction: value };
    if (old === 1) next.likes--; if (old === -1) next.dislikes--;
    if (value === 1) next.likes++; if (value === -1) next.dislikes++;
    refreshPost(next);
  }
  try { const { post } = await api(`/api/posts/${id}/react`, { method: 'POST', body: { value } }); refreshPost(post); }
  catch (e) { toast(e.message, true); if (p) refreshPost(p); }
}
const toggleLike = (id) => react(id, state.posts.get(id)?.myReaction === 1 ? 0 : 1);
const toggleDislike = (id) => react(id, state.posts.get(id)?.myReaction === -1 ? 0 : -1);

async function toggleSave(id) {
  if (!requireLogin('Sign up to save posts.')) return;
  try {
    const { saved } = await api(`/api/posts/${id}/save`, { method: 'POST' });
    const p = state.posts.get(id); if (p) refreshPost({ ...p, saved });
    toast(saved ? 'Saved' : 'Removed from saved');
  } catch (e) { toast(e.message, true); }
}

async function toggleFollow(username, btn) {
  if (!requireLogin('Sign up to follow people.')) return null;
  try {
    const r = await api(`/api/users/${encodeURIComponent(username)}/follow`, { method: 'POST' });
    for (const p of state.posts.values()) if (p.author.username === username) refreshPost({ ...p, followingAuthor: r.isFollowing });
    document.querySelectorAll(`[data-follow="${CSS.escape(username)}"]`).forEach((b) => setFollowBtn(b, r.isFollowing));
    if (btn) setFollowBtn(btn, r.isFollowing);
    return r;
  } catch (e) { toast(e.message, true); return null; }
}
function setFollowBtn(b, on) {
  if (b.classList.contains('follow-pill')) { b.classList.toggle('done', on); b.innerHTML = on ? `${icon('check', { size: 12 })}Following` : 'Follow'; return; }
  b.classList.toggle('primary', !on); b.classList.toggle('following', on); b.textContent = on ? 'Following' : 'Follow';
}
function followBtn(author, cls = '') {
  if (state.me && state.me.id === author.id) return '';
  const on = author.isFollowing ?? false;
  return `<button class="btn small ${on ? 'following' : 'primary'} ${cls}" data-follow="${esc(author.username)}">${on ? 'Following' : 'Follow'}</button>`;
}

async function sharePost(id) {
  const url = `${location.origin}/#/p/${id}`;
  try {
    if (navigator.share) await navigator.share({ url, title: titleOf(state.posts.get(id) || {}) });
    else { await navigator.clipboard.writeText(url); toast('Link copied'); }
  } catch {}
}

const REPORT_REASONS = [
  ['nudity', 'Nudity or sexual content'], ['violence', 'Violence or gore'], ['hate', 'Hate speech or symbols'],
  ['harassment', 'Bullying or harassment'], ['spam', 'Spam or scam'], ['other', 'Something else'],
];
function openReport(type, id) {
  if (!requireLogin('Sign up to report content.')) return;
  const m = openModal(`
    <h2>Report ${type}</h2>
    <p class="lead">Why are you reporting this? Reports go to the moderators. Content that gets several reports is hidden until a moderator reviews it.</p>
    <form class="form" id="repForm">
      <div class="reasons">${REPORT_REASONS.map(([v, l], i) => `<label class="reason"><input type="radio" name="reason" value="${v}" ${i === 0 ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <p class="error" id="repErr"></p>
      <button class="btn primary" type="submit">Submit report</button>
    </form>`);
  m.querySelector('#repForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/${type === 'comment' ? 'comments' : 'posts'}/${id}/report`, { method: 'POST', body: { reason: new FormData(e.target).get('reason') } });
      closeModal(); toast('Thanks — a moderator will take a look.');
    } catch (er) { m.querySelector('#repErr').textContent = er.message; }
  };
}

// ---------------- preferences (stored only in this browser) ----------------
const prefs = {
  get(k, d) { try { const v = localStorage.getItem('vb.' + k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('vb.' + k, v); } catch {} },
};
let themeSetByUs = false;
const systemDark = () => window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
function effectiveTheme() {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : systemDark() ? 'dark' : 'light';
}
function applyTheme(pref) {
  const root = document.documentElement;
  if (pref === 'light' || pref === 'dark') { root.dataset.theme = pref; themeSetByUs = true; }
  else if (themeSetByUs || !HOSTED) { delete root.dataset.theme; themeSetByUs = false; }
  document.querySelectorAll('[data-action="theme-toggle"]').forEach((b) => { b.innerHTML = icon(effectiveTheme() === 'dark' ? 'sun' : 'moon'); b.title = effectiveTheme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'; });
}
function setTheme(pref) { prefs.set('theme', pref); applyTheme(pref); }

// ---------------- top bar ----------------
function renderTop() {
  const el = document.getElementById('topActions');
  const themeBtn = `<button class="icon-btn" data-action="theme-toggle" aria-label="Toggle light or dark mode"></button>`;
  if (!state.me) {
    if (HOSTED) {
      el.innerHTML = themeBtn + (state.hosted && state.hosted.banned ? '<span class="status-chip bad">Account suspended</span>'
        : state.hosted && state.hosted.canWrite ? `<button class="btn primary" data-action="signup">Join VBrowse</button>`
        : `<span class="status-chip" title="Ask the owner for access to post">${icon('eye', { size: 16 })}Viewing only</span>`);
    } else {
      el.innerHTML = `${themeBtn}<button class="btn sign-in" data-action="login">${icon('user', { size: 18 })}Sign in</button>`;
    }
    applyTheme(prefs.get('theme', 'system'));
    return;
  }
  el.innerHTML = `${themeBtn}
    <button class="btn create-btn" data-action="upload">${icon('plus', { size: 18 })}<span class="btn-upload-label">Create</span></button>
    <div class="menu">
      <button class="icon-btn avatar-btn" data-action="usermenu" aria-label="Account menu" aria-haspopup="menu">${avatar(state.me)}</button>
    </div>`;
  applyTheme(prefs.get('theme', 'system'));
}
function openUserMenu(anchor) {
  const wrap = anchor.closest('.menu');
  if (wrap.querySelector('.menu-pop')) { wrap.querySelector('.menu-pop').remove(); return; }
  const pop = document.createElement('div');
  pop.className = 'menu-pop account-menu';
  pop.setAttribute('role', 'menu');
  const item = (href, ic, label, extra = '') => `<a href="${href}" role="menuitem" ${extra}>${icon(ic, { size: 20 })}<span>${label}</span></a>`;
  pop.innerHTML = `
    <div class="me-line">${avatar(state.me, 'md')}<div><b>${esc(state.me.displayName)}</b><div class="sub">@${esc(state.me.username)}</div>
      <a class="link" href="#/u/${esc(state.me.username)}">View your channel</a></div></div>
    <div class="menu-group">
      ${item('#/settings/channel', 'pencil', 'Customize channel')}
      ${item('#/saved', 'bookmark', 'Saved')}
      ${state.me.isAdmin ? item('#/mod', 'shield', 'Moderation') : ''}
    </div>
    <div class="menu-group">
      ${item('#/settings/appearance', effectiveTheme() === 'dark' ? 'moon' : 'sun', `Appearance: ${({ system: 'Device theme', light: 'Light', dark: 'Dark' })[prefs.get('theme', 'system')]}`)}
      ${item('#/settings/account', 'sliders', 'Settings')}
      ${item('#/rules', 'book', 'Community rules')}
    </div>
    ${HOSTED ? '' : `<div class="menu-group"><button role="menuitem" data-action="logout">${icon('logout', { size: 20 })}<span>Sign out</span></button></div>`}`;
  wrap.appendChild(pop);
  pop.addEventListener('click', (e) => { if (e.target.closest('a')) pop.remove(); });
  setTimeout(() => document.addEventListener('click', function close(e) {
    if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('click', close); }
  }), 0);
}

// ---------------- modals ----------------
function openModal(html, cls = '') {
  $modal.innerHTML = `<div class="modal-back"><div class="modal ${cls}" role="dialog" aria-modal="true">
    <button class="icon-btn close" data-action="close-modal" aria-label="Close">${ICON.close}</button>${html}</div></div>`;
  const back = $modal.querySelector('.modal-back');
  back.addEventListener('mousedown', (e) => { if (e.target === back) closeModal(); });
  delete $modal.dataset.busy;
  setTimeout(() => $modal.querySelector('input, textarea')?.focus(), 30);
  return $modal.querySelector('.modal');
}
// While something is uploading, the modal can't be closed by a stray click or Escape
function closeModal(force = false) {
  if ($modal.dataset.busy && !force) { toast('Please wait until the upload finishes.'); return; }
  delete $modal.dataset.busy; $modal.innerHTML = '';
}
// In-page confirmation (browser confirm() dialogs are blocked in some places VBrowse runs)
function ask(message, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const prev = document.getElementById('askBox'); if (prev) prev.remove();
    const back = document.createElement('div');
    back.className = 'modal-back'; back.id = 'askBox'; back.style.zIndex = 150;
    back.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true" style="width:min(400px,100%)">
      <p style="margin:0 0 18px;font-size:16px;font-weight:600">${esc(message)}</p>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn ghost" data-no>Cancel</button><button class="btn primary danger-btn" data-yes>${esc(okLabel)}</button></div></div>`;
    const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-no]')) done(false); else if (e.target.closest('[data-yes]')) done(true); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    back.querySelector('[data-yes]').focus();
  });
}

// Password field with a show/hide toggle
const pwField = (name, label, auto, hint = '') => `<label class="field-label">${label}
  <span class="pw-wrap"><input name="${name}" type="password" required autocomplete="${auto}" maxlength="200"><button type="button" class="pw-toggle" data-pw-toggle aria-label="Show password">${icon('eye', { size: 18 })}</button></span>
  ${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
// Handle field with a live availability check
const handleField = (value = '') => `<label class="field-label">Handle
  <span class="prefix-wrap"><span class="prefix">@</span><input name="username" required maxlength="30" value="${esc(value)}" autocomplete="username" autocapitalize="none" spellcheck="false" data-handle-check></span>
  <span class="hint" data-handle-msg>3–30 characters. Letters, numbers, and single . _ or - between them.</span></label>`;
function wireFormHelpers(root) {
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-pw-toggle]'); if (!t) return;
    const input = t.previousElementSibling; const show = input.type === 'password';
    input.type = show ? 'text' : 'password'; t.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    t.classList.toggle('on', show);
  });
  const h = root.querySelector('[data-handle-check]');
  if (h) {
    const msg = root.querySelector('[data-handle-msg]');
    const original = h.value;
    let timer;
    h.addEventListener('input', () => {
      h.value = h.value.replace(/^@/, '').replace(/\s/g, '').toLowerCase();
      clearTimeout(timer);
      if (!h.value || h.value === original) { msg.className = 'hint'; msg.textContent = original && h.value === original ? 'This is your current handle.' : '3–30 characters. Letters, numbers, and single . _ or - between them.'; return; }
      const local = window.VBTextFilter && window.VBTextFilter.validateHandle(h.value);
      if (local) { msg.className = 'hint bad'; msg.textContent = local; return; }
      msg.className = 'hint'; msg.textContent = 'Checking…';
      timer = setTimeout(async () => {
        try {
          const r = await api(`/api/handle-check?h=${encodeURIComponent(h.value)}`);
          msg.className = r.ok ? 'hint good' : 'hint bad';
          msg.textContent = r.ok ? `@${h.value} is available` : r.error;
        } catch { msg.className = 'hint'; msg.textContent = ''; }
      }, 300);
    });
  }
}

function openAuth(mode = 'login', reason = '') {
  if (HOSTED) mode = 'signup';
  const signup = mode === 'signup';
  const title = HOSTED ? 'Set up your channel' : signup ? 'Create your VBrowse account' : 'Sign in';
  const lead = reason || (HOSTED ? 'Pick a name and a handle. You sign in with your Claude account, so there is no password.'
    : signup ? 'One account to post, follow creators and join the conversation.' : 'Use your email or @handle.');
  const m = openModal(`
    <div class="auth-head"><span class="brand-mark sm"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6.5 7 12 17.5 17.5 7" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><h2>${title}</h2><p class="lead">${esc(lead)}</p></div>
    <form class="form" id="authForm" novalidate>
      ${signup ? `<label class="field-label">Name<input name="displayName" maxlength="50" autocomplete="name" placeholder="How you want to appear"></label>` : ''}
      ${signup && !HOSTED ? `<label class="field-label">Email<input name="email" type="email" required maxlength="254" autocomplete="email" autocapitalize="none" spellcheck="false"></label>` : ''}
      ${signup ? handleField() : `<label class="field-label">Email or handle<input name="username" required maxlength="254" autocomplete="username" autocapitalize="none" spellcheck="false"></label>`}
      ${HOSTED ? '' : signup ? pwField('password', 'Password', 'new-password', 'At least 8 characters, with letters and numbers or symbols.') : pwField('password', 'Password', 'current-password')}
      <p class="error" id="authErr" role="alert"></p>
      ${signup ? '<p class="hint">By continuing you agree to the <a href="#/rules" data-action="close-modal-nav" class="link">community rules</a>: no nudity, sexual content, hate or harassment.</p>' : ''}
      <button class="btn primary block" type="submit">${HOSTED ? 'Create channel' : signup ? 'Create account' : 'Sign in'}</button>
      ${HOSTED ? '' : `<p class="switch">${signup ? 'Already have an account?' : 'New to VBrowse?'} <button type="button" class="link" data-action="${signup ? 'login' : 'signup'}">${signup ? 'Sign in' : 'Create an account'}</button></p>`}
    </form>`, 'auth');
  wireFormHelpers(m);
  m.querySelector('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('[type=submit]');
    const errEl = m.querySelector('#authErr');
    if (signup && window.VBTextFilter) { // catch obvious mistakes before the round trip
      const V = window.VBTextFilter;
      const err = V.validateName(fd.displayName) || (!HOSTED && V.validateEmail(fd.email)) || V.validateHandle(fd.username) || (!HOSTED && V.validatePassword(fd.password, fd.username, fd.email));
      if (err) { errEl.textContent = err; return; }
    }
    btn.disabled = true;
    try {
      const { user } = await api(signup ? '/api/signup' : '/api/login', { method: 'POST', body: fd });
      state.me = user; if (state.hosted) state.hosted.hasProfile = true; closeModal(true); renderTop();
      toast(signup ? `Welcome to VBrowse, ${user.displayName}` : `Signed in as @${user.username}`);
      state.posts.clear(); route();
    } catch (err) { errEl.textContent = err.message; btn.disabled = false; }
  });
}

const uploadLimitMB = () => (state.limits && state.limits.maxUploadMB) || (HOSTED ? 20 : 200);
// When the server can't run the nudity model (Cloudflare free plan), the browser scans the file first
const needsClientScan = () => !HOSTED && !!(state.limits && state.limits.clientScan) && !!window.VBScan;

function openUpload() {
  if (!requireLogin('Sign up to post videos and photos.')) return;
  const cats = state.categories.map((c) => `<option value="${c}">${c[0].toUpperCase() + c.slice(1)}</option>`).join('');
  const m = openModal(`
    <h2>Create a post</h2>
    <p class="lead">Share a video, a photo, or just your thoughts.</p>
    <form class="form" id="upForm">
      <div class="upload-grid">
        <div>
          <div class="dropzone" id="drop" tabindex="0" role="button" aria-label="Choose a file">
            ${ICON.upload}
            <b style="color:var(--text)">Drag a video or photo here</b>
            <span class="hint">${HOSTED ? 'MP4, WEBM' : 'MP4, WEBM, MOV'}, JPG, PNG, GIF, WEBP · up to ${uploadLimitMB()} MB</span>
            <span class="btn small primary">Choose a file</span>
            <span class="hint">or skip this for a text post</span>
          </div>
          <input type="file" id="fileIn" accept="${HOSTED ? 'video/mp4,video/webm,image/jpeg,image/png,image/gif,image/webp' : 'video/mp4,video/webm,video/quicktime,video/ogg,image/jpeg,image/png,image/gif,image/webp'}" hidden>
        </div>
        <div class="form">
          <label>Caption <span class="hint">Use #hashtags and @mentions</span>
            <textarea name="caption" id="capIn" maxlength="2200" rows="6" placeholder="What's this about?"></textarea>
            <span class="counter" id="capCount">0 / 2200</span>
          </label>
          <label>Category<select name="category">${cats}</select></label>
          <label>Tags <span class="hint">space or comma separated</span><input name="tags" placeholder="funny, cats, summer"></label>
          <p class="hint with-icon">${icon('shield', { size: 16 })}<span>Every upload is checked automatically. Nudity and sexual content are blocked. <a href="#/rules" data-action="close-modal-nav" class="link">Rules</a></span></p>
          <div class="progress hidden" id="prog"><div></div></div>
          <p class="error" id="upErr"></p>
          <button class="btn primary" type="submit" id="postBtn">Post</button>
        </div>
      </div>
    </form>`, 'wide');
  let file = null;
  const drop = m.querySelector('#drop'), fileIn = m.querySelector('#fileIn');
  const dropDefault = drop.innerHTML;
  const setFile = (f) => {
    if (!f) return;
    if (!/^(video|image)\//.test(f.type)) { m.querySelector('#upErr').textContent = 'That file type is not supported.'; return; }
    const maxMb = uploadLimitMB();
    if (f.size > maxMb * 1024 * 1024) { m.querySelector('#upErr').textContent = `File is too big (max ${maxMb} MB).`; return; }
    file = f; m.querySelector('#upErr').textContent = '';
    const url = URL.createObjectURL(f);
    drop.innerHTML = (f.type.startsWith('video') ? `<video src="${url}" muted autoplay loop playsinline></video>` : `<img src="${url}" alt="">`)
      + `<button type="button" class="icon-btn remove" aria-label="Remove file">${ICON.close}</button>`;
    drop.querySelector('.remove').onclick = (e) => { e.stopPropagation(); file = null; fileIn.value = ''; drop.innerHTML = dropDefault; };
  };
  drop.onclick = () => { if (!file) fileIn.click(); };
  drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!file) fileIn.click(); } };
  fileIn.onchange = () => setFile(fileIn.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
  drop.ondragleave = () => drop.classList.remove('drag');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drag'); setFile(e.dataTransfer.files[0]); };
  const cap = m.querySelector('#capIn');
  cap.oninput = () => { m.querySelector('#capCount').textContent = `${cap.value.length} / 2200`; };

  if (needsClientScan()) window.VBScan.preload(); // start loading the safety model while they type
  m.querySelector('#upForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!file && !String(fd.get('caption')).trim()) { m.querySelector('#upErr').textContent = 'Add a video or photo, or write something.'; return; }
    if (file) fd.append('media', file);
    const btn = m.querySelector('#postBtn'), prog = m.querySelector('#prog');
    btn.disabled = true; btn.textContent = 'Posting…'; prog.classList.remove('hidden');
    $modal.dataset.busy = '1';
    const unbusy = () => { delete $modal.dataset.busy; };
    const done = (post) => {
      closeModal(true);
      toast(post.status === 'pending' ? 'Uploaded! It will appear publicly once a moderator approves it.' : 'Posted!');
      location.hash = `#/p/${post.id}`;
    };
    if (HOSTED) {
      prog.firstElementChild.style.width = '30%';
      api('/api/posts', { method: 'POST', body: fd, onStage: (t) => { btn.textContent = t; prog.firstElementChild.style.width = t.startsWith('Upload') ? '70%' : '45%'; } })
        .then(({ post }) => done(post))
        .catch((er) => { unbusy(); m.querySelector('#upErr').textContent = er.message; btn.disabled = false; btn.textContent = 'Post'; prog.classList.add('hidden'); });
      return;
    }
    if (file && needsClientScan()) {
      btn.textContent = 'Running safety check…'; prog.firstElementChild.style.width = '10%';
      const verdict = await window.VBScan.scanFile(file);
      if (verdict === 'reject') {
        unbusy(); btn.disabled = false; btn.textContent = 'Post'; prog.classList.add('hidden');
        m.querySelector('#upErr').textContent = 'This upload was blocked: our safety check detected nudity or sexual content, which is not allowed on VBrowse.';
        return;
      }
      fd.append('scan', verdict);
      btn.textContent = 'Uploading…';
    }
    // XHR so we can show upload progress
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/posts');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) prog.firstElementChild.style.width = `${(ev.loaded / ev.total) * 100}%`;
      if (ev.loaded === ev.total && file) btn.textContent = 'Running safety check…';
    };
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) {
        done(data.post);
      } else {
        unbusy(); m.querySelector('#upErr').textContent = data.error || 'Upload failed.'; btn.disabled = false; btn.textContent = 'Post'; prog.classList.add('hidden');
      }
    };
    xhr.onerror = () => { unbusy(); m.querySelector('#upErr').textContent = 'Network error. Check your connection and try again.'; btn.disabled = false; btn.textContent = 'Post'; prog.classList.add('hidden'); };
    xhr.send(fd);
  });
}

function openEditProfile() { location.hash = '#/settings/channel'; }

function openUserList(username, list) {
  const m = openModal(`<h2>${list === 'followers' ? 'Followers' : 'Following'}</h2><div id="ulist" class="user-list"><div class="loader"><div class="spinner"></div></div></div>`);
  api(`/api/users/${encodeURIComponent(username)}/${list}`).then(({ users }) => {
    m.querySelector('#ulist').innerHTML = users.length ? users.map((u) => `
      <a class="user-row" href="#/u/${esc(u.username)}" data-action="close-modal-nav">
        ${avatar(u, 'md')}<div class="grow"><b>${esc(u.displayName)}</b><div class="sub">@${esc(u.username)}</div></div>
      </a>`).join('') : `<p class="sub">${list === 'followers' ? 'No followers yet.' : 'Not following anyone yet.'}</p>`;
  });
}

// ---------------- cards / grid ----------------
function thumbHTML(p) {
  if (p.kind === 'video') return `<div class="thumb"><video src="${esc(p.media)}#t=0.5" muted preload="metadata" playsinline loop></video>
      <span class="badge kind-badge">${icon('play', { fill: true, size: 12 })}</span><span class="badge" data-dur></span></div>`;
  if (p.kind === 'image') return `<div class="thumb"><img src="${esc(p.media)}" alt="" loading="lazy"></div>`;
  return `<div class="thumb text-thumb" style="background:${tintFor(p.id)}"><span>${esc(p.caption)}</span></div>`;
}
function statsInner(p) {
  return `<span class="${p.myReaction === 1 ? 'liked' : ''}" title="Likes">${icon('heart', { size: 15, fill: p.myReaction === 1 })}${fmt(p.likes)}</span>
    <span class="${p.myReaction === -1 ? 'disliked' : ''}" title="Dislikes">${icon('thumbDown', { size: 15, fill: p.myReaction === -1 })}${fmt(p.dislikes)}</span>
    <span title="Comments">${icon('comment', { size: 15 })}${fmt(p.comments)}</span>`;
}
const reviewBadge = (p) => p.status === 'pending' ? `<span class="review-badge" title="${esc(p.modReason || '')}">${icon('clock', { size: 13 })}Under review</span>` : '';
const catLabel = (c) => esc(c.charAt(0).toUpperCase() + c.slice(1));
function cardHTML(p) {
  cachePost(p);
  return `<article class="card" data-open="${p.id}">
    <div style="position:relative">${thumbHTML(p)}${reviewBadge(p)}</div>
    <div class="card-meta">
      <a href="#/u/${esc(p.author.username)}" data-stop>${avatar(p.author)}</a>
      <div class="info">
        <h3 class="card-title">${esc(titleOf(p))}</h3>
        <div class="sub"><a href="#/u/${esc(p.author.username)}" data-stop>${esc(p.author.displayName)}</a></div>
        <div class="sub">${plural(p.views, 'view')} · ${ago(p.createdAt)} · ${catLabel(p.category)}</div>
        <div class="card-stats" data-pid="${p.id}" data-part="stats">${statsInner(p)}</div>
      </div>
    </div>
  </article>`;
}
function wireCards(root) {
  root.querySelectorAll('.card:not([data-wired])').forEach((card) => {
    card.dataset.wired = 1;
    const v = card.querySelector('video');
    if (v) {
      v.addEventListener('loadedmetadata', () => {
        const d = Math.round(v.duration || 0);
        const b = card.querySelector('[data-dur]'); if (b && d) b.textContent = `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`;
      });
      card.addEventListener('mouseenter', () => { v.currentTime = 0; v.play().catch(() => {}); });
      card.addEventListener('mouseleave', () => { v.pause(); });
    }
  });
}

// Infinite-scrolling list of posts
function infiniteList(container, buildUrl, render = cardHTML, onEmpty, { firstLimit = 12, onFirst } = {}) {
  let offset = 0, loading = false, done = false, first = true;
  const sentinel = document.createElement('div');
  sentinel.className = 'loader';
  sentinel.innerHTML = '<div class="spinner"></div>';
  container.after(sentinel);
  async function more() {
    if (loading || done) return;
    loading = true;
    try {
      const { posts, nextOffset } = await api(buildUrl(offset, first ? firstLimit : 12));
      if (!posts.length && offset === 0) onEmpty?.();
      container.insertAdjacentHTML('beforeend', posts.map(render).join(''));
      wireCards(container);
      if (first) { first = false; onFirst?.(); }
      if (nextOffset == null) { done = true; sentinel.remove(); } else offset = nextOffset;
    } catch (e) {
      done = true; sentinel.innerHTML = `<p class="sub">${esc(e.message)}</p>`;
      if (e.status === 401) onEmpty?.(e);
    }
    loading = false;
    if (!done && sentinel.getBoundingClientRect().top < innerHeight + 600) more();
  }
  const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) more(); }, { rootMargin: '600px' });
  io.observe(sentinel);
  more();
  return () => io.disconnect();
}

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== '' && v != null) p.set(k, v);
  return p.toString();
}

// ---------------- views ----------------
const SORTS = [['trending', 'Trending'], ['latest', 'Latest'], ['top', 'Top rated'], ['views', 'Most viewed'], ['discussed', 'Most discussed'], ['oldest', 'Oldest']];
const KINDS = [['', 'All'], ['video', 'Videos'], ['image', 'Photos'], ['text', 'Posts']];

async function viewHome({ mode = 'home', tag = '' } = {}) {
  const f = state.filters;
  if (tag) f.tag = tag;
  const titles = { home: f.q ? `Results for “${f.q}”` : 'Home', following: 'Following', saved: 'Saved', tag: `#${tag}` };
  const popular = await api('/api/tags/popular').then((r) => r.tags).catch(() => []);
  $app.innerHTML = `
    <section class="filters">
      <div class="filter-head">
        <h1>${esc(titles[mode])}</h1>
        ${mode === 'home' || mode === 'tag' ? `<select class="select" id="sortSel" aria-label="Sort">${SORTS.map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
        <div class="seg" id="kindSeg">${KINDS.map(([v, l]) => `<button data-kind="${v}" class="${f.kind === v ? 'active' : ''}">${l}</button>`).join('')}</div>
      </div>
      ${f.q && mode === 'home' ? `<div class="active-filter">Searching “${esc(f.q)}” <button data-action="clear-search">Clear</button></div>` : ''}
      <div class="chip-row" id="catRow">
        <button class="chip ${!f.category ? 'active' : ''}" data-cat="">All</button>
        ${state.categories.map((c) => `<button class="chip ${f.category === c ? 'active' : ''}" data-cat="${c}">${catLabel(c)}</button>`).join('')}
      </div>
      ${mode === 'home' && popular.length ? `<div class="chip-row">${popular.map((t) => `<a class="chip tag" href="#/tag/${esc(t)}">#${esc(t)}</a>`).join('')}</div>` : ''}
    </section>
    <section class="grid" id="grid"></section>`;

  const grid = $app.querySelector('#grid');
  const params = () => ({
    sort: mode === 'following' ? 'following' : mode === 'saved' ? 'latest' : f.sort,
    kind: f.kind, category: f.category,
    q: mode === 'home' ? f.q : '', tag: mode === 'tag' ? tag : '', saved: mode === 'saved' ? 1 : '',
  });
  const emptyMsg = (err) => {
    const msgs = {
      following: ['Nobody to show yet', 'Follow creators and their newest posts show up here.', state.me ? '<a class="btn primary" href="#/">Discover creators</a>' : '<button class="btn primary" data-action="login">Sign in</button>'],
      saved: ['No saved posts', 'Tap the bookmark on any post to keep it here for later.', state.me ? '' : '<button class="btn primary" data-action="login">Sign in</button>'],
    };
    const filtered = f.q || f.category || f.kind || mode === 'tag';
    const [h, p, b] = msgs[mode] || (filtered ? ['No matches', 'Nothing fits these filters yet. Try clearing one.', ''] : ['Nothing here yet', 'Be the first to post something.', '<button class="btn primary" data-action="upload">Create a post</button>']);
    grid.outerHTML = `<div class="empty">${icon(mode === 'saved' ? 'bookmark' : mode === 'following' ? 'people' : 'video', { size: 40, cls: 'empty-ic' })}<h2>${h}</h2><p>${err?.status === 401 ? 'Sign in to see this.' : p}</p>${b}</div>`;
  };
  // Coming back to a feed restores how far you had scrolled
  const memoKey = location.hash + JSON.stringify(params());
  const memo = scrollMemo.get(memoKey);
  let stop = infiniteList(grid, (offset, limit) => `/api/posts?${qs({ ...params(), offset, limit })}`, cardHTML, emptyMsg,
    memo ? { firstLimit: Math.min(50, Math.max(12, memo.count)), onFirst: () => requestAnimationFrame(() => window.scrollTo(0, memo.y)) } : {});
  document.getElementById('searchInput').value = mode === 'home' ? f.q : '';

  const reload = () => { stop(); scrollMemo.delete(memoKey); viewHome({ mode, tag }); };
  $app.querySelector('#sortSel')?.addEventListener('change', (e) => { f.sort = e.target.value; reload(); });
  $app.querySelector('#kindSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-kind]'); if (b) { f.kind = b.dataset.kind; reload(); } });
  $app.querySelector('#catRow').addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (b) { f.category = b.dataset.cat; reload(); } });
  cleanupView = () => { stop(); const g = $app.querySelector('#grid'); if (g) scrollMemo.set(memoKey, { y: window.scrollY, count: g.children.length }); };
}

// --- TikTok-style vertical scroll ---
function railInner(p) {
  const isMe = state.me && state.me.id === p.author.id;
  return `
    <a class="rail-avatar" href="#/u/${esc(p.author.username)}">${avatar(p.author, 'md')}
      ${isMe ? '' : `<button class="follow-pill ${p.followingAuthor ? 'done' : ''}" data-follow="${esc(p.author.username)}" aria-label="${p.followingAuthor ? 'Unfollow' : 'Follow'}">${p.followingAuthor ? `${icon('check', { size: 12 })}Following` : 'Follow'}</button>`}</a>
    <button class="rail-btn ${p.myReaction === 1 ? 'on-like' : ''}" data-like="${p.id}" aria-label="Like" aria-pressed="${p.myReaction === 1}"><span class="circle">${p.myReaction === 1 ? ICON.like : ICON.likeOutline}</span>${fmt(p.likes)}</button>
    <button class="rail-btn ${p.myReaction === -1 ? 'on-dislike' : ''}" data-dislike="${p.id}" aria-label="Dislike" aria-pressed="${p.myReaction === -1}"><span class="circle">${p.myReaction === -1 ? ICON.thumbDownOn : ICON.thumbDown}</span>${fmt(p.dislikes)}</button>
    <button class="rail-btn" data-comments="${p.id}" aria-label="Comments"><span class="circle">${ICON.comment}</span>${fmt(p.comments)}</button>
    <button class="rail-btn ${p.saved ? 'on-save' : ''}" data-save="${p.id}" aria-label="Save" aria-pressed="${p.saved}"><span class="circle">${p.saved ? ICON.saveOn : ICON.save}</span>${p.saved ? 'Saved' : 'Save'}</button>
    <button class="rail-btn" data-share="${p.id}" aria-label="Share"><span class="circle">${ICON.share}</span>Share</button>`;
}
function reelHTML(p) {
  cachePost(p);
  let stage;
  if (p.kind === 'video') stage = `<div class="reel-stage" data-stage="${p.id}"><video src="${esc(p.media)}" loop playsinline preload="metadata"></video>
      <button class="icon-btn reel-mute" data-mute aria-label="Toggle sound">${reelMuted ? ICON.muted : ICON.sound}</button>
      <div class="paused-icon">${ICON.play}</div><div class="reel-progress"><div></div></div>`;
  else if (p.kind === 'image') stage = `<div class="reel-stage" data-stage="${p.id}"><img src="${esc(p.media)}" alt="">`;
  else stage = `<div class="reel-stage text-stage" data-stage="${p.id}" style="background:${tintFor(p.id)}"><p>${esc(p.caption)}</p>`;
  return `<section class="reel" data-reel="${p.id}">
    ${stage}
      <div class="reel-overlay">
        <a class="reel-author" href="#/u/${esc(p.author.username)}">@${esc(p.author.username)}<span class="sub">· ${ago(p.createdAt)}</span></a>
        ${p.kind !== 'text' && p.caption ? `<div class="reel-caption">${richText(p.caption)}</div>${p.caption.length > 120 ? '<button class="reel-more" data-more>more</button>' : ''}` : ''}
        <div class="reel-meta">${plural(p.views, 'view')} · ${catLabel(p.category)} · <a href="#/p/${p.id}">Open post</a>${state.me && state.me.id === p.author.id ? '' : ` · <button class="reel-report" data-report-post="${p.id}">${icon('flag', { size: 13 })}Report</button>`}</div>
      </div>
    </div>
    <div class="rail" data-pid="${p.id}" data-part="rail">${railInner(p)}</div>
  </section>`;
}
let reelMuted = prefs.get('sound', 'off') !== 'on';

function viewScroll() {
  const scrollFilter = { feed: 'foryou', category: '', ...state.scrollFilter };
  state.scrollFilter = scrollFilter;
  $app.classList.add('fullbleed');
  $app.innerHTML = `<div class="reel-wrap">
    <div class="reel-top">
      <div class="seg" id="feedSeg">
        <button data-feed="foryou" class="${scrollFilter.feed === 'foryou' ? 'active' : ''}">For You</button>
        <button data-feed="following" class="${scrollFilter.feed === 'following' ? 'active' : ''}">Following</button>
        <button data-feed="latest" class="${scrollFilter.feed === 'latest' ? 'active' : ''}">Latest</button>
      </div>
      <select class="select" id="reelCat" aria-label="Category"><option value="">All topics</option>${state.categories.map((c) => `<option value="${c}" ${scrollFilter.category === c ? 'selected' : ''}>${catLabel(c)}</option>`).join('')}</select>
    </div>
    <div class="reel-feed" id="feed"></div>
  </div>`;
  const feed = $app.querySelector('#feed');
  const sortFor = { foryou: 'trending', following: 'following', latest: 'latest' };
  let stopList = infiniteListReels();

  function infiniteListReels() {
    let offset = 0, loading = false, done = false;
    const sentinel = document.createElement('div');
    sentinel.style.cssText = 'height:1px';
    feed.appendChild(sentinel);
    async function more() {
      if (loading || done) return; loading = true;
      try {
        const { posts, nextOffset } = await api(`/api/posts?${qs({ sort: sortFor[scrollFilter.feed], category: scrollFilter.category || '', offset, limit: 6 })}`);
        if (!posts.length && offset === 0) {
          feed.innerHTML = `<div class="empty" style="padding-top:140px">${icon('scroll', { size: 40, cls: 'empty-ic' })}<h2>Nothing to scroll yet</h2><p>${scrollFilter.feed === 'following' ? 'Follow some creators first.' : scrollFilter.category ? 'Nothing in this topic yet.' : 'Be the first to post something.'}</p><button class="btn primary" data-action="upload">Create a post</button></div>`;
          done = true; loading = false; return;
        }
        sentinel.insertAdjacentHTML('beforebegin', posts.map(reelHTML).join(''));
        posts.forEach((p) => observe(feed.querySelector(`[data-reel="${p.id}"]`)));
        if (nextOffset == null) done = true; else offset = nextOffset;
      } catch (e) {
        done = true;
        feed.innerHTML = `<div class="empty" style="padding-top:140px"><h2>${e.status === 401 ? 'Sign in to see your Following feed' : "Couldn't load posts"}</h2><p>${esc(e.message)}</p>${e.status === 401 ? '<button class="btn primary" data-action="login">Sign in</button>' : ''}</div>`;
      }
      loading = false;
    }
    const sio = new IntersectionObserver((es) => { if (es[0].isIntersecting) more(); }, { root: feed, rootMargin: '200%' });
    sio.observe(sentinel);
    more();
    return () => sio.disconnect();
  }

  // Autoplay the reel in view, pause others, count views
  const viewed = new Set();
  const playIO = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const v = en.target.querySelector('video');
      const id = Number(en.target.dataset.reel);
      if (en.isIntersecting && en.intersectionRatio > 0.6) {
        if (v) { v.muted = reelMuted; v.play().then(() => en.target.querySelector('.reel-stage').classList.remove('paused')).catch(() => { v.muted = true; reelMuted = true; v.play().catch(() => {}); }); }
        if (!viewed.has(id)) {
          viewed.add(id);
          setTimeout(() => { if (document.contains(en.target)) api(`/api/posts/${id}/view`, { method: 'POST' }).catch(() => {}); }, 1500);
        }
      } else if (v) v.pause();
    }
  }, { root: feed, threshold: [0, 0.6, 1] });
  function observe(el) {
    if (!el) return;
    playIO.observe(el);
    const v = el.querySelector('video');
    if (v) v.addEventListener('timeupdate', () => { const bar = el.querySelector('.reel-progress div'); if (bar && v.duration) bar.style.width = `${(v.currentTime / v.duration) * 100}%`; });
  }

  // Tap = pause/play, double-tap = like (with heart)
  let lastTap = 0, tapTimer;
  feed.addEventListener('click', (e) => {
    const stage = e.target.closest('.reel-stage');
    if (!stage || e.target.closest('a, button')) return;
    const id = Number(stage.dataset.stage);
    const now = Date.now();
    if (now - lastTap < 300) {
      clearTimeout(tapTimer); lastTap = 0;
      const rect = stage.getBoundingClientRect();
      const heart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      heart.setAttribute('viewBox', '0 0 24 24'); heart.classList.add('big-heart');
      heart.innerHTML = '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z"/>';
      heart.style.left = `${e.clientX - rect.left}px`; heart.style.top = `${e.clientY - rect.top}px`;
      stage.appendChild(heart); setTimeout(() => heart.remove(), 850);
      if (state.posts.get(id)?.myReaction !== 1) react(id, 1);
      return;
    }
    lastTap = now;
    tapTimer = setTimeout(() => {
      const v = stage.querySelector('video');
      if (!v) return;
      if (v.paused) { v.play(); stage.classList.remove('paused'); } else { v.pause(); stage.classList.add('paused'); }
    }, 280);
  });
  feed.addEventListener('click', (e) => {
    const mute = e.target.closest('[data-mute]');
    if (mute) {
      reelMuted = !reelMuted; prefs.set('sound', reelMuted ? 'off' : 'on');
      feed.querySelectorAll('video').forEach((v) => { v.muted = reelMuted; });
      feed.querySelectorAll('[data-mute]').forEach((b) => { b.innerHTML = reelMuted ? ICON.muted : ICON.sound; });
    }
    const more = e.target.closest('[data-more]');
    if (more) { const c = more.previousElementSibling; c.classList.toggle('open'); more.textContent = c.classList.contains('open') ? 'less' : 'more'; }
  });

  // Keyboard: up/down to move, L to like, M to mute
  const onKey = (e) => {
    if (e.target.matches('input, textarea, select') || $modal.innerHTML || document.querySelector('.drawer')) return;
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); feed.scrollBy({ top: feed.clientHeight, behavior: 'smooth' }); }
    if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); feed.scrollBy({ top: -feed.clientHeight, behavior: 'smooth' }); }
    if (e.key === 'm') feed.querySelector('[data-mute]')?.click();
    if (e.key === 'l') {
      const idx = Math.round(feed.scrollTop / feed.clientHeight);
      const el = feed.querySelectorAll('[data-reel]')[idx];
      if (el) toggleLike(Number(el.dataset.reel));
    }
  };
  document.addEventListener('keydown', onKey);

  $app.querySelector('#feedSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-feed]'); if (!b) return;
    scrollFilter.feed = b.dataset.feed; cleanupView(); viewScroll();
  });
  $app.querySelector('#reelCat').addEventListener('change', (e) => { scrollFilter.category = e.target.value; cleanupView(); viewScroll(); });

  cleanupView = () => {
    stopList(); playIO.disconnect(); document.removeEventListener('keydown', onKey);
    feed.querySelectorAll('video').forEach((v) => v.pause());
    $app.classList.remove('fullbleed');
  };
}

// --- Comments (shared by watch page + drawer) ---
function commentHTML(c, post) {
  // Authors and moderators can delete; post owners can too on the self-hosted server
  const mine = state.me && (state.me.id === c.author.id || (!HOSTED && state.me.id === post.author.id));
  return `<div class="comment" data-cid="${c.id}">
    <a href="#/u/${esc(c.author.username)}">${avatar(c.author, c.parentId ? 'sm' : '')}</a>
    <div class="body">
      <div class="who"><a href="#/u/${esc(c.author.username)}">@${esc(c.author.username)}</a>${c.author.id === post.author.id ? '<span class="op">Creator</span>' : ''}<span class="sub">${ago(c.createdAt)}</span></div>
      <p class="text">${richText(c.body)}</p>
      <div class="tools">
        <button data-clike="${c.id}" class="${c.liked ? 'liked' : ''}">${c.liked ? ICON.like : ICON.likeOutline}<span>${c.likes || ''}</span></button>
        <button data-reply="${c.id}" data-reply-to="${esc(c.author.username)}">Reply</button>
        ${mine || state.me?.isAdmin ? `<button data-cdel="${c.id}">Delete</button>` : ''}
        ${state.me && state.me.id !== c.author.id ? `<button data-report-comment="${c.id}">Report</button>` : ''}
        ${c.hidden ? '<span class="review-inline">Hidden after reports</span>' : ''}
      </div>
    </div>
  </div>`;
}
function commentFormHTML(placeholder = 'Add a comment…', parentId = '') {
  return `<form class="comment-form" data-parent="${parentId}">
    ${state.me ? avatar(state.me, parentId ? 'sm' : '') : `<span class="avatar ghost-avatar">${icon('user', { size: 18 })}</span>`}
    <div class="field">
      <textarea rows="1" maxlength="1000" placeholder="${esc(placeholder)}" name="body"></textarea>
      <div class="actions hidden"><button type="button" class="btn small ghost" data-cancel>Cancel</button><button class="btn small primary" type="submit">${parentId ? 'Reply' : 'Comment'}</button></div>
    </div>
  </form>`;
}

function mountComments(root, post, { onCount } = {}) {
  let comments = [], sort = 'top';
  const openThreads = new Set();
  const listEl = root.querySelector('[data-clist]');
  const countEl = root.querySelector('[data-ccount]');

  async function load() {
    listEl.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
    const r = await api(`/api/posts/${post.id}/comments?sort=${sort === 'new' ? 'new' : 'top'}`);
    comments = r.comments; render();
  }
  function render() {
    const tops = comments.filter((c) => !c.parentId);
    if (countEl) countEl.textContent = `${comments.length} comment${comments.length === 1 ? '' : 's'}`;
    onCount?.(comments.length);
    if (!tops.length) { listEl.innerHTML = '<p class="sub" style="padding:20px 0;text-align:center">No comments yet. Say something nice.</p>'; return; }
    listEl.innerHTML = tops.map((c) => {
      const reps = comments.filter((r) => r.parentId === c.id).sort((a, b) => a.createdAt - b.createdAt);
      const open = openThreads.has(c.id);
      return `<div class="thread" data-thread="${c.id}">${commentHTML(c, post)}
        ${reps.length ? `<button class="replies-toggle" data-toggle="${c.id}">${icon(open ? 'chevronUp' : 'chevronDown', { size: 16 })}${open ? 'Hide' : ''} ${reps.length} repl${reps.length === 1 ? 'y' : 'ies'}</button>` : ''}
        <div class="replies ${open ? '' : 'hidden'}" data-replies="${c.id}">${reps.map((r) => commentHTML(r, post)).join('')}</div>
      </div>`;
    }).join('');
  }
  async function submit(form) {
    if (!requireLogin('Sign up to comment.')) return;
    const ta = form.querySelector('textarea');
    const body = ta.value.trim(); if (!body) return;
    const parentId = form.dataset.parent || null;
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try {
      const { comment } = await api(`/api/posts/${post.id}/comments`, { method: 'POST', body: { body, parentId } });
      comments.push(comment);
      if (comment.parentId) openThreads.add(comment.parentId);
      else if (sort === 'new') comments.sort((a, b) => b.createdAt - a.createdAt);
      ta.value = ''; ta.style.height = '';
      if (parentId) form.remove(); else form.querySelector('.actions').classList.add('hidden');
      render();
      const p = state.posts.get(post.id); if (p) refreshPost({ ...p, comments: comments.length });
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
  }

  root.addEventListener('focusin', (e) => {
    if (e.target.matches('.comment-form textarea')) {
      if (!state.me) { e.target.blur(); requireLogin('Sign up to comment.'); return; }
      e.target.closest('form').querySelector('.actions').classList.remove('hidden');
    }
  });
  root.addEventListener('input', (e) => {
    if (e.target.matches('.comment-form textarea')) { e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }
  });
  root.addEventListener('keydown', (e) => {
    if (e.target.matches('.comment-form textarea') && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(e.target.closest('form')); }
  });
  root.addEventListener('submit', (e) => { if (e.target.matches('.comment-form')) { e.preventDefault(); submit(e.target); } });
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.matches('[data-cancel]')) {
      const form = t.closest('form');
      if (form.dataset.parent) form.remove(); else { form.querySelector('textarea').value = ''; form.querySelector('.actions').classList.add('hidden'); }
    } else if (t.dataset.toggle) {
      const id = Number(t.dataset.toggle); openThreads.has(id) ? openThreads.delete(id) : openThreads.add(id); render();
    } else if (t.dataset.sort) {
      sort = t.dataset.sort; root.querySelectorAll('[data-sort]').forEach((b) => b.classList.toggle('active', b === t)); load();
    } else if (t.dataset.clike) {
      if (!requireLogin('Sign up to like comments.')) return;
      const id = Number(t.dataset.clike);
      const r = await api(`/api/comments/${id}/like`, { method: 'POST' }).catch((er) => toast(er.message, true));
      if (r) { const c = comments.find((x) => x.id === id); c.liked = r.liked; c.likes = r.likes; render(); }
    } else if (t.dataset.reply) {
      if (!requireLogin('Sign up to reply.')) return;
      const id = Number(t.dataset.reply);
      const host = t.closest('.comment');
      if (host.nextElementSibling?.matches('.comment-form')) { host.nextElementSibling.querySelector('textarea').focus(); return; }
      host.insertAdjacentHTML('afterend', commentFormHTML(`Reply to @${t.dataset.replyTo}…`, id));
      const ta = host.nextElementSibling.querySelector('textarea');
      ta.value = `@${t.dataset.replyTo} `; ta.focus();
      host.nextElementSibling.style.marginLeft = '46px';
    } else if (t.dataset.cdel) {
      if (!await ask('Delete this comment?')) return;
      const id = Number(t.dataset.cdel);
      try {
        await api(`/api/comments/${id}`, { method: 'DELETE' });
        comments = comments.filter((c) => c.id !== id && c.parentId !== id); render();
        const p = state.posts.get(post.id); if (p) refreshPost({ ...p, comments: comments.length });
      } catch (er) { toast(er.message, true); }
    }
  });
  load();
}

function commentsBlockHTML() {
  return `<div class="comments-head"><h3 data-ccount>Comments</h3>
      <div class="seg"><button data-sort="top" class="active">Top</button><button data-sort="new">Newest</button></div></div>
    ${commentFormHTML()}
    <div data-clist></div>`;
}

function openCommentsDrawer(id) {
  const post = state.posts.get(id);
  if (!post) return;
  const back = document.createElement('div'); back.className = 'drawer-back';
  const d = document.createElement('aside'); d.className = 'drawer';
  d.innerHTML = `<div class="drawer-head"><h3 data-ccount>Comments</h3>
      <div style="display:flex;gap:6px;align-items:center"><div class="seg"><button data-sort="top" class="active">Top</button><button data-sort="new">Newest</button></div>
      <button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div></div>
    <div class="drawer-body"><div data-clist></div></div>
    <div class="drawer-foot">${commentFormHTML()}</div>`;
  document.body.append(back, d);
  const close = () => { back.remove(); d.remove(); document.removeEventListener('keydown', esc_); };
  const esc_ = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc_);
  back.onclick = close; d.querySelector('[data-close]').onclick = close;
  mountComments(d, post);
}

// --- Watch page (YouTube-style) ---
function pillsInner(p) {
  const total = p.likes + p.dislikes;
  return `<div>
    <div class="pill-group">
      <button data-like="${p.id}" class="${p.myReaction === 1 ? 'on-like' : ''}" aria-label="Like" aria-pressed="${p.myReaction === 1}">${p.myReaction === 1 ? ICON.thumbUpOn : ICON.thumbUp} ${fmt(p.likes)}</button>
      <button data-dislike="${p.id}" class="${p.myReaction === -1 ? 'on-dislike' : ''}" aria-label="Dislike" aria-pressed="${p.myReaction === -1}">${p.myReaction === -1 ? ICON.thumbDownOn : ICON.thumbDown} ${fmt(p.dislikes)}</button>
    </div>
    <div class="ratio" title="${total ? Math.round((p.likes / total) * 100) + '% liked' : 'No ratings yet'}"><div style="width:${total ? (p.likes / total) * 100 : 50}%"></div></div>
  </div>
  <div class="pill-group"><button data-save="${p.id}" class="${p.saved ? 'on-save' : ''}" aria-pressed="${p.saved}">${p.saved ? ICON.saveOn : ICON.save} ${p.saved ? 'Saved' : 'Save'}</button></div>
  <div class="pill-group"><button data-share="${p.id}">${ICON.share} Share</button></div>`;
}

async function viewPost(id) {
  $app.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  let post;
  try { post = cachePost((await api(`/api/posts/${id}`)).post); }
  catch (e) { $app.innerHTML = `<div class="empty">${icon('info', { size: 40, cls: 'empty-ic' })}<h2>This post isn't available</h2><p>It may have been deleted or is waiting for review.</p><a class="btn primary" href="#/">Go home</a></div>`; return; }
  const author = (await api(`/api/users/${encodeURIComponent(post.author.username)}`)).user;
  const isMine = state.me && state.me.id === post.author.id;
  const canManage = isMine || state.me?.isAdmin;
  let player;
  if (post.kind === 'video') player = `<div class="player"><video src="${esc(post.media)}" controls autoplay playsinline></video></div>`;
  else if (post.kind === 'image') player = `<div class="player"><img src="${esc(post.media)}" alt=""></div>`;
  else player = `<div class="player text-player" style="background:${tintFor(post.id)}">${esc(post.caption)}</div>`;

  $app.innerHTML = `<div class="watch">
    <div>
      ${post.status === 'pending' ? `<div class="review-banner">${icon('clock', { size: 18 })}<div><b>Under review.</b> ${isMine ? 'Only you can see this post until a moderator approves it.' : 'This post is hidden from the public.'} <span class="sub">${esc(post.modReason || '')}</span></div></div>` : ''}
      ${player}
      ${post.kind === 'text' ? '<div style="height:14px"></div>' : `<h1>${esc(titleOf(post))}</h1>`}
      <div class="watch-row">
        <div class="grow author-line">
          <a href="#/u/${esc(author.username)}">${avatar(author, 'md')}</a>
          <div><a class="name" href="#/u/${esc(author.username)}">${esc(author.displayName)}</a><div class="sub" data-fcount>${plural(author.followers, 'follower')}</div></div>
          ${followBtn(author)}
        </div>
        <div class="watch-row" data-pid="${post.id}" data-part="pills">${pillsInner(post)}</div>
        <div class="menu"><button class="icon-btn" data-action="post-menu" aria-label="More">${ICON.dots}</button></div>
      </div>
      <div class="desc-box">
        <div class="sub"><span data-views>${plural(post.views, 'view')}</span> · ${ago(post.createdAt)} · <a href="#/" data-cat-link="${esc(post.category)}">${catLabel(post.category)}</a></div>
        ${post.caption && post.kind !== 'text' ? `<div class="desc-text">${richText(post.caption)}</div>` : ''}
        ${post.tags.length ? `<div style="margin-top:8px">${post.tags.map((t) => `<a class="hashtag" href="#/tag/${esc(t)}">#${esc(t)}</a>`).join(' ')}</div>` : ''}
      </div>
      <section class="comments" id="comments">${commentsBlockHTML()}</section>
    </div>
    <aside><h3 style="margin:0 0 12px;font-size:16px">More like this</h3><div class="side-list" id="related"></div></aside>
  </div>`;

  api(`/api/posts/${id}/view`, { method: 'POST' }).then((r) => { const v = $app.querySelector('[data-views]'); if (v) v.textContent = plural(r.views, 'view'); }).catch(() => {});
  mountComments($app.querySelector('#comments'), post);

  // related: same category first, then trending
  const rel = $app.querySelector('#related');
  Promise.all([
    api(`/api/posts?${qs({ category: post.category, sort: 'trending', limit: 8 })}`),
    api(`/api/posts?${qs({ sort: 'trending', limit: 12 })}`),
  ]).then(([a, b]) => {
    const seen = new Set([post.id]);
    const list = [...a.posts, ...b.posts].filter((p) => !seen.has(p.id) && seen.add(p.id)).slice(0, 12);
    rel.innerHTML = list.map((p) => { cachePost(p); return `<div class="mini" data-open="${p.id}">${thumbHTML(p)}
      <div style="min-width:0"><div class="card-title">${esc(titleOf(p))}</div><div class="sub">${esc(p.author.displayName)}</div><div class="sub">${plural(p.views, 'view')} · ${ago(p.createdAt)}</div></div></div>`; }).join('')
      || '<p class="sub">Nothing else yet.</p>';
  });

  $app.querySelector('[data-cat-link]')?.addEventListener('click', (e) => { e.preventDefault(); state.filters.category = post.category; location.hash = '#/'; });
  $app.querySelector('[data-action="post-menu"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const wrap = e.currentTarget.closest('.menu');
    if (wrap.querySelector('.menu-pop')) return wrap.querySelector('.menu-pop').remove();
    wrap.insertAdjacentHTML('beforeend', `<div class="menu-pop">
      ${isMine ? `<button data-edit>${icon('pencil', { size: 18 })}<span>Edit caption</span></button>` : ''}
      ${!isMine ? `<button data-rep>${icon('flag', { size: 18 })}<span>Report post</span></button>` : ''}
      ${canManage ? `<button class="danger" data-del>${icon('trash', { size: 18 })}<span>Delete post</span></button>` : ''}</div>`);
    wrap.querySelector('[data-rep]')?.addEventListener('click', () => { wrap.querySelector('.menu-pop').remove(); openReport('post', post.id); });
    if (!canManage) return;
    wrap.querySelector('[data-del]').onclick = async () => {
      if (!await ask('Delete this post? This can\'t be undone.', 'Delete')) return;
      try { await api(`/api/posts/${post.id}`, { method: 'DELETE' }); toast('Post deleted'); location.hash = isMine ? `#/u/${post.author.username}` : '#/'; }
      catch (er) { toast(er.message, true); }
    };
    if (wrap.querySelector('[data-edit]')) wrap.querySelector('[data-edit]').onclick = () => {
      const m = openModal(`<h2>Edit post</h2><form class="form" id="editForm"><label>Caption<textarea name="caption" maxlength="2200" rows="6">${esc(post.caption)}</textarea></label>
        <label>Category<select name="category">${state.categories.map((c) => `<option value="${c}" ${c === post.category ? 'selected' : ''}>${catLabel(c)}</option>`).join('')}</select></label>
        <button class="btn primary">Save</button></form>`);
      m.querySelector('#editForm').onsubmit = async (ev) => {
        ev.preventDefault();
        try { await api(`/api/posts/${post.id}`, { method: 'PATCH', body: Object.fromEntries(new FormData(ev.target)) }); closeModal(); toast('Saved'); route(); }
        catch (er) { toast(er.message, true); }
      };
    };
  });
  cleanupView = () => $app.querySelectorAll('video').forEach((v) => v.pause());
}

// --- Channel (profile) page, YouTube-style ---
async function viewProfile(username) {
  $app.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  let u;
  try { u = (await api(`/api/users/${encodeURIComponent(username)}`)).user; }
  catch { $app.innerHTML = `<div class="empty">${icon('user', { size: 40, cls: 'empty-ic' })}<h2>This channel doesn't exist</h2><p>The handle may have changed or the account was deleted.</p><a class="btn primary" href="#/">Go home</a></div>`; return; }
  let tab = 'posts', kind = '';
  const joined = new Date(u.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  $app.innerHTML = `
    <div class="channel">
      <div class="banner" style="${u.banner ? `background-image:url('${esc(u.banner)}')` : `background:${tintFor(u.username)}`}"></div>
      <section class="channel-head">
        ${avatar(u, 'xl')}
        <div class="info">
          <h1>${esc(u.displayName)}</h1>
          <div class="channel-meta"><b>@${esc(u.username)}</b><span>·</span>
            <button class="link-btn" data-list="followers"><span data-fcount>${plural(u.followers, 'follower')}</span></button><span>·</span>
            <span>${plural(u.posts, 'post')}</span></div>
          ${u.bio ? `<div class="profile-bio clamp" id="bio">${richText(u.bio)}</div>` : u.isMe ? '<div class="profile-bio sub">Add a description so people know what your channel is about.</div>' : ''}
          <div class="channel-meta sub"><span>Joined ${joined}</span><span>·</span><button class="link-btn" data-list="following">${plural(u.following, 'following', 'following')}</button><span>·</span><span>${plural(u.likes, 'like')}</span></div>
          <div class="channel-actions">
            ${u.isMe ? `<a class="btn" href="#/settings/channel">${icon('pencil', { size: 18 })}Customize channel</a><button class="btn primary" data-action="upload">${icon('plus', { size: 18 })}Create</button>`
              : `<button class="btn ${u.isFollowing ? 'following' : 'primary'}" data-follow="${esc(u.username)}" data-profile-follow>${u.isFollowing ? 'Following' : 'Follow'}</button>`}
          </div>
        </div>
      </section>
    </div>
    <div class="tabs" role="tablist">
      <button data-tab="posts" class="active" role="tab">Posts</button>
      <button data-tab="top" role="tab">Popular</button>
      ${u.isMe ? '<button data-tab="saved" role="tab">Saved</button>' : ''}
      <div style="margin-left:auto;align-self:center" class="seg" id="pkind">${KINDS.map(([v, l]) => `<button data-kind="${v}" class="${v === '' ? 'active' : ''}">${l}</button>`).join('')}</div>
    </div>
    <div id="pgrid-wrap"></div>`;
  const bio = $app.querySelector('#bio');
  if (bio) requestAnimationFrame(() => { if (bio.scrollHeight > bio.clientHeight + 2) { bio.insertAdjacentHTML('afterend', '<button class="link-btn more-btn" id="bioMore">more</button>'); $app.querySelector('#bioMore').onclick = (e) => { bio.classList.toggle('clamp'); e.target.textContent = bio.classList.contains('clamp') ? 'more' : 'less'; }; } });
  let stop = () => {};
  const load = () => {
    stop();
    const wrap = $app.querySelector('#pgrid-wrap');
    wrap.innerHTML = '<section class="grid" id="pgrid"></section>';
    const grid = wrap.querySelector('#pgrid');
    const params = tab === 'saved' ? { saved: 1, sort: 'latest' } : { user: u.username, sort: tab === 'top' ? 'top' : 'latest' };
    stop = infiniteList(grid, (offset, limit) => `/api/posts?${qs({ ...params, kind, offset, limit })}`, cardHTML, () => {
      grid.outerHTML = `<div class="empty compact"><h2>${tab === 'saved' ? 'No saved posts' : kind ? 'Nothing of this type yet' : 'No posts yet'}</h2>${u.isMe && tab !== 'saved' && !kind ? '<p>Share your first video or photo.</p><button class="btn primary" data-action="upload">Create a post</button>' : ''}</div>`;
    });
  };
  $app.querySelector('.tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]'); const k = e.target.closest('[data-kind]');
    if (t) { tab = t.dataset.tab; $app.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === t)); load(); }
    if (k) { kind = k.dataset.kind; $app.querySelectorAll('#pkind [data-kind]').forEach((b) => b.classList.toggle('active', b === k)); load(); }
  });
  $app.querySelectorAll('[data-list]').forEach((b) => b.onclick = () => openUserList(u.username, b.dataset.list));
  load();
  cleanupView = () => stop();
}

// --- Moderation dashboard (admins) ---
const REASON_LABEL = Object.fromEntries(REPORT_REASONS);
async function viewMod() {
  if (!state.me?.isAdmin) { $app.innerHTML = `<div class="empty"><h2>Moderators only</h2><a class="btn primary" href="#/">Go home</a></div>`; return; }
  $app.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  let q;
  try { q = await api('/api/mod/queue'); } catch (e) { $app.innerHTML = `<div class="empty"><h2>${esc(e.message)}</h2></div>`; return; }
  const reportsLine = (r) => r.length ? r.map((x) => `${esc(REASON_LABEL[x.reason] || x.reason)} ×${x.n}`).join(' · ') : '';
  const media = (p) => p.kind === 'video' ? `<video src="${esc(p.media)}" controls muted preload="metadata"></video>`
    : p.kind === 'image' ? `<img src="${esc(p.media)}" alt="">` : `<div class="mod-text" style="background:${tintFor(p.id)}">${esc(p.caption)}</div>`;
  $app.innerHTML = `
    <div class="filter-head" style="margin-bottom:6px"><h1 class="with-icon">${icon('shield', { size: 26 })}Moderation</h1></div>
    <p class="sub" style="margin-top:0">Posts flagged by the automatic safety check or reported by people. Pending posts are hidden from everyone except their creator until you approve them.</p>
    <h3>Posts <span class="sub">(${q.posts.length})</span></h3>
    ${q.posts.length ? `<div class="mod-grid">${q.posts.map((p) => `
      <div class="mod-item" data-mpost="${p.id}">
        <div class="mod-media">${media(p)}</div>
        <div class="mod-body">
          <div><span class="status-pill ${p.status}">${p.status === 'pending' ? 'Hidden · pending' : 'Live · reported'}</span></div>
          <div class="card-title" style="margin-top:6px">${esc(titleOf(p))}</div>
          <div class="sub">by <a href="#/u/${esc(p.author.username)}">@${esc(p.author.username)}</a> · ${ago(p.createdAt)}</div>
          ${p.modReason ? `<div class="sub with-icon">${icon('info', { size: 14 })}${esc(p.modReason)}</div>` : ''}
          ${p.reports.length ? `<div class="sub with-icon">${icon('flag', { size: 14 })}${reportsLine(p.reports)}</div>` : ''}
          <div class="mod-actions">
            <button class="btn small" data-mod="approve">${icon('check', { size: 16 })}Approve</button>
            <button class="btn small danger-btn" data-mod="remove">Remove</button>
            <button class="btn small ghost" data-ban="${esc(p.author.username)}">Ban user</button>
          </div>
        </div>
      </div>`).join('')}</div>` : '<p class="sub">Nothing to review right now.</p>'}
    <h3 style="margin-top:28px">Comments <span class="sub">(${q.comments.length})</span></h3>
    ${q.comments.length ? q.comments.map((c) => `
      <div class="mod-comment" data-mcomment="${c.id}">
        <div style="flex:1;min-width:0">
          <div class="sub"><a href="#/u/${esc(c.author.username)}">@${esc(c.author.username)}</a> on <a href="#/p/${c.postId}">post</a> · ${c.hidden ? 'hidden' : 'visible'} · ${reportsLine(c.reports)}</div>
          <div style="white-space:pre-wrap;word-break:break-word">${esc(c.body)}</div>
        </div>
        <div class="mod-actions" style="margin:0">
          <button class="btn small" data-cmod="keep">Keep</button>
          <button class="btn small danger-btn" data-cmod="remove">Remove</button>
          <button class="btn small ghost" data-ban="${esc(c.author.username)}">Ban</button>
        </div>
      </div>`).join('') : '<p class="sub">No reported comments.</p>'}`;
  $app.onclick = async (e) => {
    const b = e.target.closest('[data-mod],[data-cmod],[data-ban]'); if (!b || !$app.contains(b)) return;
    try {
      if (b.dataset.mod) {
        if (b.dataset.mod === 'remove' && !await ask('Remove this post permanently?', 'Remove')) return;
        await api(`/api/mod/posts/${b.closest('[data-mpost]').dataset.mpost}`, { method: 'POST', body: { action: b.dataset.mod } });
        b.closest('[data-mpost]').remove(); toast(b.dataset.mod === 'approve' ? 'Approved' : 'Removed');
      } else if (b.dataset.cmod) {
        await api(`/api/mod/comments/${b.closest('[data-mcomment]').dataset.mcomment}`, { method: 'POST', body: { action: b.dataset.cmod } });
        b.closest('[data-mcomment]').remove(); toast(b.dataset.cmod === 'keep' ? 'Kept' : 'Removed');
      } else if (b.dataset.ban) {
        if (!await ask(`Ban @${b.dataset.ban}? Their account is suspended and all their posts and comments are taken down.`)) return;
        await api(`/api/mod/users/${encodeURIComponent(b.dataset.ban)}`, { method: 'POST', body: { action: 'ban' } });
        toast(`@${b.dataset.ban} banned`); viewMod();
      }
    } catch (er) { toast(er.message, true); }
  };
  cleanupView = () => { $app.onclick = null; };
}

function viewRules() {
  const rule = (ic, title, text) => `<li>${icon(ic, { size: 22 })}<div><b>${title}</b><p>${text}</p></div></li>`;
  $app.innerHTML = `<div class="rules">
    <h1>Community rules</h1>
    <p class="sub">VBrowse is for everyone. Breaking these rules gets content removed and accounts banned.</p>
    <ol class="rule-list">
      ${rule('eye', 'No nudity or sexual content', 'This includes explicit images, videos, links and sexual comments. Uploads are scanned and blocked if they contain nudity.')}
      ${rule('people', 'No hate or harassment', 'No slurs, threats, bullying, or attacks on people for who they are.')}
      ${rule('shield', 'No violence or gore', 'And nothing that encourages self-harm or dangerous acts.')}
      ${rule('mail', 'No spam or scams', 'No fake giveaways, phishing, or repetitive self-promotion.')}
      ${rule('book', 'Only post what you have the right to share', 'Your own videos and photos, or ones you have permission to use.')}
    </ol>
    <h3>How moderation works</h3>
    <ul class="plain-list">
      <li>Every photo and video is checked by an automatic nudity detector before it goes live. Clear violations are rejected; borderline ones wait for a moderator.</li>
      <li>Captions, comments, names, handles and descriptions are filtered for explicit words and slurs.</li>
      <li>Anyone can report a post or comment. After a few reports it is hidden until a moderator reviews it.</li>
      <li>Moderators can approve or remove content and ban accounts.</li>
    </ul>
  </div>`;
}

// --- Settings (Channel / Account / Appearance) ---
function viewSettings(section) {
  const sections = [
    ...(state.me ? [['channel', 'Channel', 'pencil'], ['account', 'Account', 'user']] : []),
    ['appearance', 'Appearance', 'sun'],
  ];
  if (!sections.some(([k]) => k === section)) section = sections[0][0];
  $app.innerHTML = `<div class="settings">
    <h1>Settings</h1>
    <div class="settings-layout">
      <nav class="settings-nav">${sections.map(([k, l, ic]) => `<a href="#/settings/${k}" class="${k === section ? 'active' : ''}">${icon(ic, { size: 20 })}${l}</a>`).join('')}</nav>
      <div class="settings-body" id="setBody"></div>
    </div></div>`;
  const body = $app.querySelector('#setBody');
  ({ channel: settingsChannel, account: settingsAccount, appearance: settingsAppearance })[section](body);
}

function settingsChannel(body) {
  const me = state.me;
  body.innerHTML = `
    <section class="panel">
      <h2>Customize channel</h2>
      <p class="sub">This is how your channel appears to everyone on VBrowse.</p>
      <form class="form" id="chanForm" novalidate>
        <div class="field-label">Banner image
          <div class="banner-edit" id="bannerPrev" style="${me.banner ? `background-image:url('${esc(me.banner)}')` : `background:${tintFor(me.username)}`}"></div>
          <div class="row-actions"><label class="btn small">${icon('image', { size: 16 })}Upload<input type="file" name="banner" accept="image/jpeg,image/png,image/gif,image/webp" hidden id="bannerIn"></label>
            ${me.banner ? '<button type="button" class="btn small ghost" id="bannerRm">Remove</button>' : ''}<span class="hint">Wide images work best, about 2048 × 400.</span></div>
        </div>
        <div class="field-label">Picture
          <div class="avatar-edit"><span id="avPrev">${avatar(me, 'xl')}</span>
            <div class="row-actions"><label class="btn small">${icon('camera', { size: 16 })}Change<input type="file" name="avatar" accept="image/jpeg,image/png,image/gif,image/webp" hidden id="avIn"></label>
              ${me.avatar ? '<button type="button" class="btn small ghost" id="avRm">Remove</button>' : ''}</div></div>
        </div>
        <label class="field-label">Name<input name="displayName" maxlength="50" value="${esc(me.displayName)}" autocomplete="name">
          <span class="hint">Your name can include spaces, letters from any language and numbers.</span></label>
        ${handleField(me.username)}
        <label class="field-label">Description<textarea name="bio" maxlength="1000" rows="5" placeholder="Tell viewers about your channel">${esc(me.bio || '')}</textarea><span class="counter" id="bioCount">${(me.bio || '').length} / 1000</span></label>
        <p class="error" id="chanErr" role="alert"></p>
        <div class="row-actions end"><a class="btn ghost" href="#/u/${esc(me.username)}">View channel</a><button class="btn primary" type="submit">Save changes</button></div>
      </form>
    </section>`;
  wireFormHelpers(body);
  const form = body.querySelector('#chanForm');
  let rmAvatar = false, rmBanner = false;
  body.querySelector('#avIn').onchange = (e) => { const f = e.target.files[0]; if (f) { rmAvatar = false; body.querySelector('#avPrev').innerHTML = `<img class="avatar xl" src="${URL.createObjectURL(f)}" alt="">`; } };
  body.querySelector('#bannerIn').onchange = (e) => { const f = e.target.files[0]; if (f) { rmBanner = false; body.querySelector('#bannerPrev').style.cssText = `background-image:url('${URL.createObjectURL(f)}')`; } };
  body.querySelector('#avRm')?.addEventListener('click', (e) => { rmAvatar = true; body.querySelector('#avIn').value = ''; body.querySelector('#avPrev').innerHTML = avatar({ ...me, avatar: null }, 'xl'); e.target.remove(); });
  body.querySelector('#bannerRm')?.addEventListener('click', (e) => { rmBanner = true; body.querySelector('#bannerIn').value = ''; body.querySelector('#bannerPrev').style.cssText = `background:${tintFor(me.username)}`; e.target.remove(); });
  const bio = form.querySelector('[name=bio]'); bio.oninput = () => { body.querySelector('#bioCount').textContent = `${bio.value.length} / 1000`; };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const err = window.VBTextFilter && (window.VBTextFilter.validateName(fd.get('displayName')) || (fd.get('username') !== me.username && window.VBTextFilter.validateHandle(fd.get('username'))));
    if (err) { body.querySelector('#chanErr').textContent = err; return; }
    if (needsClientScan()) {
      for (const [field, flag] of [['avatar', 'scanAvatar'], ['banner', 'scanBanner']]) {
        const f = fd.get(field);
        if (!f?.size) continue;
        const verdict = await window.VBScan.scanFile(f);
        if (verdict !== 'ok') { body.querySelector('#chanErr').textContent = 'That image was blocked by our safety check. Please choose a different one.'; return; }
        fd.set(flag, 'ok');
      }
    }
    if (!fd.get('avatar')?.size) fd.delete('avatar');
    if (!fd.get('banner')?.size) fd.delete('banner');
    if (rmAvatar) fd.set('removeAvatar', '1');
    if (rmBanner) fd.set('removeBanner', '1');
    const btn = form.querySelector('[type=submit]'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const { user } = await api('/api/me', { method: 'PATCH', body: fd });
      state.me = { ...state.me, ...user }; state.posts.clear(); renderTop(); toast('Channel updated'); viewSettings('channel');
    } catch (er) { body.querySelector('#chanErr').textContent = er.message; btn.disabled = false; btn.textContent = 'Save changes'; }
  });
}

function settingsAccount(body) {
  const me = state.me;
  const deleteBlock = `<section class="panel danger-zone">
      <h2>Delete ${HOSTED ? 'your channel' : 'account'}</h2>
      <p class="sub">This permanently removes your channel, posts, comments and likes. It can't be undone.</p>
      <form class="form" id="delForm" novalidate>
        ${HOSTED ? '' : pwField('password', 'Enter your password to confirm', 'current-password')}
        <p class="error" id="delErr" role="alert"></p>
        <div class="row-actions"><button class="btn danger-btn" type="submit">${icon('trash', { size: 16 })}Delete ${HOSTED ? 'channel' : 'account'}</button></div>
      </form></section>`;
  if (HOSTED) {
    body.innerHTML = `<section class="panel"><h2>Account</h2><p class="sub">You're signed in with your Claude account. Your email and password are managed there, not on VBrowse.</p>
      <div class="kv"><span>Handle</span><b>@${esc(me.username)}</b></div></section>${deleteBlock}`;
  } else {
    body.innerHTML = `
      <section class="panel">
        <h2>Email</h2>
        <p class="sub">Used to sign in. It's never shown on your channel.</p>
        <form class="form" id="emailForm" novalidate>
          <label class="field-label">Email<input name="email" type="email" value="${esc(me.email || '')}" autocomplete="email" autocapitalize="none" spellcheck="false"></label>
          ${pwField('currentPassword', 'Current password', 'current-password')}
          <p class="error" id="emailErr" role="alert"></p>
          <div class="row-actions end"><button class="btn primary" type="submit">Update email</button></div>
        </form>
      </section>
      <section class="panel">
        <h2>Password</h2>
        <p class="sub">Changing your password signs you out on your other devices.</p>
        <form class="form" id="pwForm" novalidate>
          ${pwField('currentPassword', 'Current password', 'current-password')}
          ${pwField('newPassword', 'New password', 'new-password', 'At least 8 characters, with letters and numbers or symbols.')}
          ${pwField('confirm', 'Confirm new password', 'new-password')}
          <p class="error" id="pwErr" role="alert"></p>
          <div class="row-actions end"><button class="btn primary" type="submit">Change password</button></div>
        </form>
      </section>${deleteBlock}`;
    wireFormHelpers(body);
    body.querySelector('#emailForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target)); const errEl = body.querySelector('#emailErr');
      const err = window.VBTextFilter.validateEmail(fd.email) || (!fd.currentPassword && 'Enter your current password.');
      if (err) { errEl.textContent = err; return; }
      try { const { user } = await api('/api/account', { method: 'PATCH', body: { email: fd.email, currentPassword: fd.currentPassword } }); state.me = user; toast('Email updated'); viewSettings('account'); }
      catch (er) { errEl.textContent = er.message; }
    });
    body.querySelector('#pwForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target)); const errEl = body.querySelector('#pwErr');
      const err = (!fd.currentPassword && 'Enter your current password.') || window.VBTextFilter.validatePassword(fd.newPassword, me.username, me.email) || (fd.newPassword !== fd.confirm && "The new passwords don't match.");
      if (err) { errEl.textContent = err; return; }
      try { await api('/api/account', { method: 'PATCH', body: { currentPassword: fd.currentPassword, newPassword: fd.newPassword } }); toast('Password changed'); e.target.reset(); errEl.textContent = ''; }
      catch (er) { errEl.textContent = er.message; }
    });
  }
  wireFormHelpers(body.querySelector('.danger-zone'));
  body.querySelector('#delForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (!HOSTED && !fd.password) { body.querySelector('#delErr').textContent = 'Enter your password to confirm.'; return; }
    if (!await ask(`Delete @${me.username} and everything it posted? This can't be undone.`, 'Delete forever')) return;
    try {
      await api('/api/account', { method: 'DELETE', body: { password: fd.password } });
      state.me = null; if (state.hosted) state.hosted.hasProfile = false; state.posts.clear(); scrollMemo.clear();
      renderTop(); toast('Your account was deleted'); location.hash = '#/';
    } catch (er) { body.querySelector('#delErr').textContent = er.message; }
  });
}

function settingsAppearance(body) {
  const cur = prefs.get('theme', 'system');
  const opt = (v, label, ic, desc) => `<label class="choice ${cur === v ? 'on' : ''}"><input type="radio" name="theme" value="${v}" ${cur === v ? 'checked' : ''}>
    <span class="choice-ic">${icon(ic, { size: 22 })}</span><span><b>${label}</b><span class="sub">${desc}</span></span></label>`;
  body.innerHTML = `
    <section class="panel">
      <h2>Theme</h2>
      <p class="sub">Saved in this browser.</p>
      <div class="choices" id="themeChoices">
        ${opt('system', 'Use device theme', 'monitor', 'Follows your phone or computer')}
        ${opt('light', 'Light', 'sun', 'Bright background')}
        ${opt('dark', 'Dark', 'moon', 'Easier on the eyes at night')}
      </div>
    </section>
    <section class="panel">
      <h2>Playback</h2>
      <label class="switch-row"><span><b>Play sound in Scroll</b><span class="sub">Videos start with sound on instead of muted.</span></span>
        <input type="checkbox" class="toggle" id="soundPref" ${prefs.get('sound', 'off') === 'on' ? 'checked' : ''}></label>
    </section>`;
  body.querySelector('#themeChoices').addEventListener('change', (e) => {
    setTheme(e.target.value);
    body.querySelectorAll('.choice').forEach((c) => c.classList.toggle('on', c.querySelector('input').checked));
  });
  body.querySelector('#soundPref').addEventListener('change', (e) => { prefs.set('sound', e.target.checked ? 'on' : 'off'); reelMuted = !e.target.checked; toast(e.target.checked ? 'Videos will play with sound' : 'Videos will start muted'); });
}

// ---------------- router ----------------
function setNav(name) {
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
}
function route() {
  cleanupView(); cleanupView = () => {};
  document.querySelectorAll('.drawer, .drawer-back').forEach((x) => x.remove());
  $app.classList.remove('fullbleed');
  const h = location.hash.replace(/^#/, '') || '/';
  const parts = h.split('/').filter(Boolean).map(decodeURIComponent);
  window.scrollTo(0, 0);
  if (!parts.length) { setNav('home'); return viewHome({ mode: 'home' }); }
  switch (parts[0]) {
    case 'scroll': setNav('scroll'); return viewScroll();
    case 'following': setNav('following'); return viewHome({ mode: 'following' });
    case 'saved': setNav('saved'); return viewHome({ mode: 'saved' });
    case 'tag': setNav(''); return viewHome({ mode: 'tag', tag: parts[1] || '' });
    case 'p': setNav(''); return viewPost(Number(parts[1]));
    case 'mod': setNav(''); return viewMod();
    case 'settings': setNav(''); return viewSettings(parts[1] || 'channel');
    case 'rules': setNav(''); return viewRules();
    case 'u': setNav(state.me && (parts[1] || '').toLowerCase() === state.me.username ? 'me' : ''); return viewProfile(parts[1]);
    case 'me':
      if (!state.me) { setNav('me'); $app.innerHTML = `<div class="empty">${icon('user', { size: 40, cls: 'empty-ic' })}<h2>Your channel</h2><p>${HOSTED ? 'Set up a channel to post and follow creators.' : 'Sign in to post, follow creators and build your channel.'}</p>${HOSTED ? (state.hosted && state.hosted.canWrite ? '<button class="btn primary" data-action="signup">Set up channel</button>' : '') : '<button class="btn primary" data-action="login">Sign in</button> <button class="btn" data-action="signup">Create account</button>'}</div>`; return; }
      location.replace(`#/u/${state.me.username}`); return;
    default: setNav(''); $app.innerHTML = `<div class="empty">${icon('info', { size: 40, cls: 'empty-ic' })}<h2>Page not found</h2><a class="btn primary" href="#/">Go home</a></div>`;
  }
}

// ---------------- global events ----------------
document.addEventListener('click', (e) => {
  // Clicking a link to the page you're already on refreshes it (like tapping Home again)
  const link = e.target.closest('a[href^="#"]');
  if (link && !e.defaultPrevented && link.getAttribute('href') === (location.hash || '#/') && !link.closest('[data-follow]')) {
    e.preventDefault(); scrollMemo.clear(); route(); return;
  }
  const a = e.target.closest('[data-action]');
  if (a) {
    const act = a.dataset.action;
    if (act === 'login') { e.preventDefault(); return openAuth('login'); }
    if (act === 'signup') { e.preventDefault(); return openAuth('signup'); }
    if (act === 'upload') { e.preventDefault(); return openUpload(); }
    if (act === 'close-modal') return closeModal();
    if (act === 'close-modal-nav') return closeModal();
    if (act === 'theme-toggle') { setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'); toast(effectiveTheme() === 'dark' ? 'Dark mode' : 'Light mode'); return; }
    if (act === 'usermenu') { e.stopPropagation(); return openUserMenu(a); }
    if (act === 'edit-profile') { document.querySelector('.menu-pop')?.remove(); return openEditProfile(); }
    if (act === 'clear-search') { state.filters.q = ''; document.getElementById('searchInput').value = ''; return route(); }
    if (act === 'logout') {
      api('/api/logout', { method: 'POST' }).then(() => { state.me = null; state.posts.clear(); scrollMemo.clear(); renderTop(); toast('Signed out'); location.hash = '#/'; route(); });
      return;
    }
  }
  const t = e.target.closest('[data-like],[data-dislike],[data-save],[data-share],[data-comments],[data-follow]');
  if (t) {
    e.preventDefault(); e.stopPropagation();
    if (t.dataset.like) return toggleLike(Number(t.dataset.like));
    if (t.dataset.dislike) return toggleDislike(Number(t.dataset.dislike));
    if (t.dataset.save) return toggleSave(Number(t.dataset.save));
    if (t.dataset.share) return sharePost(Number(t.dataset.share));
    if (t.dataset.comments) return openCommentsDrawer(Number(t.dataset.comments));
    if (t.dataset.follow) {
      return toggleFollow(t.dataset.follow).then((r) => {
        if (!r) return;
        document.querySelectorAll('[data-fcount]').forEach((el) => {
          el.textContent = el.tagName === 'B' ? fmt(r.followers) : plural(r.followers, 'follower');
        });
        toast(r.isFollowing ? `Following @${t.dataset.follow}` : `Unfollowed @${t.dataset.follow}`);
      });
    }
  }
  const rp = e.target.closest('[data-report-post],[data-report-comment]');
  if (rp) {
    e.preventDefault(); e.stopPropagation();
    return rp.dataset.reportPost ? openReport('post', Number(rp.dataset.reportPost)) : openReport('comment', Number(rp.dataset.reportComment));
  }
  if (e.target.closest('[data-stop]')) return;
  const open = e.target.closest('[data-open]');
  if (open) location.hash = `#/p/${open.dataset.open}`;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $modal.innerHTML) closeModal(); });

document.getElementById('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  let q = document.getElementById('searchInput').value.trim();
  if (q.startsWith('#') && /^#[\w]+$/.test(q)) { location.hash = `#/tag/${q.slice(1).toLowerCase()}`; return; }
  if (q.startsWith('@') && /^@[\w.-]+$/.test(q)) { location.hash = `#/u/${q.slice(1).toLowerCase()}`; return; }
  state.filters.q = q;
  if (location.hash === '#/' || location.hash === '') route(); else location.hash = '#/';
});

window.addEventListener('hashchange', route);

// ---------------- boot ----------------
hydrateIcons();
applyTheme(prefs.get('theme', 'system'));
if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(prefs.get('theme', 'system')));
(async () => {
  try { const r = await api('/api/me'); state.me = r.user; state.categories = r.categories; state.hosted = r.hosted || null; state.limits = r.limits || null; } catch {}
  if (HOSTED) document.body.classList.add('hosted');
  renderTop();
  if (HOSTED && !state.me && state.hosted && state.hosted.canWrite && !state.hosted.hasProfile) setTimeout(() => openAuth('signup'), 400);
  route();
})();
})();
