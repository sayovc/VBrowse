/* VBrowse (VibeBrowse) — client app (vanilla JS, hash router) */
(() => {
'use strict';

// ---------------- state ----------------
const state = {
  me: null,
  categories: [],
  filters: { sort: 'trending', kind: '', category: '', q: '', tag: '' },
  hosted: null, // set when running as a Claude-hosted page (see hosted/backend.js)
  posts: new Map(), // id -> post (cache, used to sync UI everywhere)
};
const $app = document.getElementById('app');
const $modal = document.getElementById('modalRoot');
let cleanupView = () => {};

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
const COLORS = ['#ff3d6e', '#7c5cff', '#22b8cf', '#f59f00', '#12b886', '#e64980', '#4c6ef5', '#fd7e14'];
const colorFor = (s) => COLORS[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const GRADS = [['#ff3d6e', '#7c5cff'], ['#0ea5e9', '#22c55e'], ['#f59e0b', '#ef4444'], ['#8b5cf6', '#ec4899'], ['#14b8a6', '#6366f1'], ['#f97316', '#eab308']];
const gradFor = (id) => { const [a, b] = GRADS[id % GRADS.length]; return `linear-gradient(135deg, ${a}, ${b})`; };

function avatar(u, size = '') {
  if (u.avatar) return `<img class="avatar ${size}" src="${esc(u.avatar)}" alt="">`;
  const name = u.displayName || u.username || '?';
  return `<span class="avatar ${size}" style="background:${colorFor(u.username)}">${esc(name[0])}</span>`;
}
// Escape, then link #tags and @mentions
function richText(s) {
  return esc(s)
    .replace(/(^|\s)#([a-zA-Z0-9_]{1,40})/g, '$1<a class="hashtag" href="#/tag/$2">#$2</a>')
    .replace(/(^|\s)@([a-zA-Z0-9_.]{3,20})/g, '$1<a class="mention" href="#/u/$2">@$2</a>');
}
const titleOf = (p) => (p.caption || '').split('\n')[0] || (p.kind === 'video' ? 'Untitled video' : p.kind === 'image' ? 'Untitled photo' : 'Post');

const ICON = {
  like: '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z"/></svg>',
  likeOutline: '<svg viewBox="0 0 24 24"><path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/></svg>',
  thumbUp: '<svg viewBox="0 0 24 24"><path d="M2 21h4V9H2v12zm20-11a2 2 0 00-2-2h-6.3l1-4.6v-.3c0-.4-.2-.8-.4-1.1L13.2 1 6.6 7.6C6.2 7.9 6 8.4 6 9v10a2 2 0 002 2h9c.8 0 1.5-.5 1.8-1.2l3-7.1c.1-.2.2-.5.2-.7v-2z"/></svg>',
  thumbDown: '<svg viewBox="0 0 24 24"><path d="M15 3H6c-.8 0-1.5.5-1.8 1.2l-3 7.1c-.1.2-.2.5-.2.7v2a2 2 0 002 2h6.3l-1 4.6v.3c0 .4.2.8.4 1.1L9.8 23l6.6-6.6c.4-.4.6-.9.6-1.4V5a2 2 0 00-2-2zm4 0v12h4V3h-4z"/></svg>',
  comment: '<svg viewBox="0 0 24 24"><path d="M21 6h-2v9H6v2a1 1 0 001 1h11l4 4V7a1 1 0 00-1-1zm-4 6V3a1 1 0 00-1-1H3a1 1 0 00-1 1v14l4-4h10a1 1 0 001-1z"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M6 2h12a1 1 0 011 1v19l-7-4-7 4V3a1 1 0 011-1z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  dots: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 8a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4z"/></svg>',
  muted: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M16.5 12A4.5 4.5 0 0014 8v2.2l2.45 2.45c.03-.2.05-.42.05-.65zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0021 12c0-4.28-3-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a9 9 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>',
  sound: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 8v8a4.47 4.47 0 002.5-4zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="38" height="38"><path fill="#fff" d="M8 5v14l11-7z"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>',
};

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
  if (b.classList.contains('follow-pill')) { b.classList.toggle('done', on); b.textContent = on ? '✓ Following' : 'Follow'; return; }
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

// ---------------- top bar ----------------
function renderTop() {
  const el = document.getElementById('topActions');
  if (!state.me) {
    if (HOSTED) {
      el.innerHTML = state.hosted && state.hosted.banned ? '<span class="chip tag" style="color:#ff7a8e">Account suspended</span>'
        : state.hosted && state.hosted.canWrite
        ? `<button class="btn primary" data-action="signup">Join VBrowse</button>`
        : `<span class="chip tag" title="Ask the owner for access to post">👀 Viewing only</span>`;
      return;
    }
    el.innerHTML = `<button class="btn ghost" data-action="login">Log in</button><button class="btn primary" data-action="signup">Sign up</button>`;
    return;
  }
  el.innerHTML = `
    <button class="btn" data-action="upload">${ICON.upload.replace('<svg', '<svg width="18" height="18" fill="currentColor"')}<span class="btn-upload-label">Upload</span></button>
    <div class="menu">
      <button class="icon-btn" data-action="usermenu" aria-label="Account menu">${avatar(state.me)}</button>
    </div>`;
}
function openUserMenu(anchor) {
  const wrap = anchor.closest('.menu');
  if (wrap.querySelector('.menu-pop')) { wrap.querySelector('.menu-pop').remove(); return; }
  const pop = document.createElement('div');
  pop.className = 'menu-pop';
  pop.innerHTML = `
    <div class="me-line"><b>${esc(state.me.displayName)}</b><div class="sub">@${esc(state.me.username)}</div></div>
    <a href="#/u/${esc(state.me.username)}">Your profile</a>
    <button data-action="edit-profile">Edit profile</button>
    <a href="#/saved">Saved posts</a>
    ${state.me.isAdmin ? '<a href="#/mod">🛡️ Moderation</a>' : ''}
    <a href="#/rules">Community rules</a>
    ${HOSTED ? '' : '<button class="danger" data-action="logout">Log out</button>'}`;
  wrap.appendChild(pop);
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
  setTimeout(() => $modal.querySelector('input, textarea')?.focus(), 30);
  return $modal.querySelector('.modal');
}
function closeModal() { $modal.innerHTML = ''; }
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

function openAuth(mode = 'login', reason = '') {
  if (HOSTED) mode = 'signup';
  const signup = mode === 'signup';
  const m = openModal(`
    <h2>${HOSTED ? 'Create your VBrowse profile' : signup ? 'Create your account' : 'Welcome back'}</h2>
    <p class="lead">${esc(reason || (signup ? 'Post videos and photos, follow creators, and join the conversation.' : 'Log in to keep scrolling.'))}</p>
    <form class="form" id="authForm" novalidate>
      ${signup ? `<label>Display name<input name="displayName" maxlength="40" placeholder="Your name" autocomplete="name"></label>` : ''}
      <label>Username<input name="username" required maxlength="20" placeholder="${signup ? 'letters, numbers, _ or .' : 'username'}" autocomplete="username" autocapitalize="none"></label>
      ${HOSTED ? '<p class="hint">No password needed: you sign in with your Claude account.</p>' : `<label>Password<input name="password" type="password" required minlength="6" placeholder="${signup ? 'At least 6 characters' : 'Password'}" autocomplete="${signup ? 'new-password' : 'current-password'}"></label>`}
      <p class="error" id="authErr"></p>
      ${signup ? '<p class="hint">By signing up you agree to the <a href="#/rules" data-action="close-modal-nav" style="color:var(--text);text-decoration:underline">community rules</a>: no nudity, sexual content, hate or harassment.</p>' : ''}
      <button class="btn primary" type="submit">${signup ? 'Sign up' : 'Log in'}</button>
      ${HOSTED ? '' : `<p class="switch">${signup ? 'Already have an account?' : "Don't have an account?"} <button type="button" data-action="${signup ? 'login' : 'signup'}">${signup ? 'Log in' : 'Sign up'}</button></p>`}
    </form>`);
  m.querySelector('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const { user } = await api(signup ? '/api/signup' : '/api/login', { method: 'POST', body: fd });
      state.me = user; if (state.hosted) state.hosted.hasProfile = true; closeModal(); renderTop();
      toast(signup ? `Welcome to VBrowse, ${user.displayName}!` : `Welcome back, ${user.displayName}`);
      state.posts.clear(); route();
    } catch (err) { m.querySelector('#authErr').textContent = err.message; btn.disabled = false; }
  });
}

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
            <span class="hint">${HOSTED ? 'MP4, WEBM, JPG, PNG, GIF, WEBP · up to 20 MB' : 'MP4, WEBM, MOV, JPG, PNG, GIF, WEBP · up to 200 MB'}</span>
            <span class="btn small primary">Choose file</span>
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
          <p class="hint">🛡️ Every upload is automatically checked. Nudity and sexual content are blocked. <a href="#/rules" data-action="close-modal-nav" style="color:var(--text);text-decoration:underline">Rules</a></p>
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
    const maxMb = HOSTED ? 20 : 200;
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

  m.querySelector('#upForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!file && !String(fd.get('caption')).trim()) { m.querySelector('#upErr').textContent = 'Add a video or photo, or write something.'; return; }
    if (file) fd.append('media', file);
    const btn = m.querySelector('#postBtn'), prog = m.querySelector('#prog');
    btn.disabled = true; btn.textContent = 'Posting…'; prog.classList.remove('hidden');
    const done = (post) => {
      closeModal();
      toast(post.status === 'pending' ? 'Uploaded! It will appear publicly once a moderator approves it.' : 'Posted!');
      location.hash = `#/p/${post.id}`;
    };
    if (HOSTED) {
      prog.firstElementChild.style.width = '30%';
      api('/api/posts', { method: 'POST', body: fd, onStage: (t) => { btn.textContent = t; prog.firstElementChild.style.width = t.startsWith('Upload') ? '70%' : '45%'; } })
        .then(({ post }) => done(post))
        .catch((er) => { m.querySelector('#upErr').textContent = er.message; btn.disabled = false; btn.textContent = 'Post'; prog.classList.add('hidden'); });
      return;
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
        m.querySelector('#upErr').textContent = data.error || 'Upload failed.'; btn.disabled = false; btn.textContent = 'Post'; prog.classList.add('hidden');
      }
    };
    xhr.onerror = () => { m.querySelector('#upErr').textContent = 'Network error, try again.'; btn.disabled = false; btn.textContent = 'Post'; };
    xhr.send(fd);
  });
}

function openEditProfile() {
  if (!state.me) return;
  const m = openModal(`
    <h2>Edit profile</h2>
    <p class="lead">This is how people see you on VBrowse.</p>
    <form class="form" id="profForm">
      <div style="display:flex;align-items:center;gap:16px">
        <span id="avPrev">${avatar(state.me, 'lg')}</span>
        <label class="btn small" style="flex-direction:row;color:var(--text)">Change photo<input type="file" name="avatar" accept="image/*" hidden id="avIn"></label>
      </div>
      <label>Display name<input name="displayName" maxlength="40" value="${esc(state.me.displayName)}"></label>
      <label>Bio<textarea name="bio" maxlength="300" placeholder="Tell people about yourself">${esc(state.me.bio || '')}</textarea></label>
      <p class="error" id="profErr"></p>
      <button class="btn primary" type="submit">Save</button>
    </form>`);
  m.querySelector('#avIn').onchange = (e) => {
    const f = e.target.files[0]; if (f) m.querySelector('#avPrev').innerHTML = `<img class="avatar lg" src="${URL.createObjectURL(f)}" alt="">`;
  };
  m.querySelector('#profForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!fd.get('avatar')?.size) fd.delete('avatar');
    try {
      const { user } = await api('/api/me', { method: 'PATCH', body: fd });
      state.me = user; if (state.hosted) state.hosted.hasProfile = true; closeModal(); renderTop(); toast('Profile updated'); route();
    } catch (err) { m.querySelector('#profErr').textContent = err.message; }
  });
}

function openUserList(username, list) {
  const m = openModal(`<h2 style="text-transform:capitalize">${list}</h2><div id="ulist"><div class="loader"><div class="spinner"></div></div></div>`);
  api(`/api/users/${encodeURIComponent(username)}/${list}`).then(({ users }) => {
    m.querySelector('#ulist').innerHTML = users.length ? users.map((u) => `
      <a class="user-row" href="#/u/${esc(u.username)}" data-action="close-modal-nav">
        ${avatar(u, 'md')}<div class="grow"><b>${esc(u.displayName)}</b><div class="sub">@${esc(u.username)}</div></div>
      </a>`).join('') : `<p class="sub">Nobody yet.</p>`;
  });
}

// ---------------- cards / grid ----------------
function thumbHTML(p) {
  if (p.kind === 'video') return `<div class="thumb"><video src="${esc(p.media)}#t=0.5" muted preload="metadata" playsinline loop></video>
      <span class="badge kind-badge">▶ Video</span><span class="badge" data-dur></span></div>`;
  if (p.kind === 'image') return `<div class="thumb"><img src="${esc(p.media)}" alt="" loading="lazy"></div>`;
  return `<div class="thumb text-thumb" style="background:${gradFor(p.id)}"><span>${esc(p.caption)}</span></div>`;
}
function statsInner(p) {
  return `<span class="${p.myReaction === 1 ? 'liked' : ''}">♥ ${fmt(p.likes)}</span>
    <span class="${p.myReaction === -1 ? 'disliked' : ''}">👎 ${fmt(p.dislikes)}</span>
    <span>💬 ${fmt(p.comments)}</span>`;
}
const reviewBadge = (p) => p.status === 'pending' ? `<span class="review-badge" title="${esc(p.modReason || '')}">⏳ Under review</span>` : '';
function cardHTML(p) {
  cachePost(p);
  return `<article class="card" data-open="${p.id}">
    <div style="position:relative">${thumbHTML(p)}${reviewBadge(p)}</div>
    <div class="card-meta">
      <a href="#/u/${esc(p.author.username)}" data-stop>${avatar(p.author)}</a>
      <div class="info">
        <h3 class="card-title">${esc(titleOf(p))}</h3>
        <div class="sub"><a href="#/u/${esc(p.author.username)}" data-stop>${esc(p.author.displayName)}</a> · <span style="text-transform:capitalize">${esc(p.category)}</span></div>
        <div class="sub">${fmt(p.views)} views · ${ago(p.createdAt)}</div>
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
function infiniteList(container, buildUrl, render = cardHTML, onEmpty) {
  let offset = 0, loading = false, done = false;
  const sentinel = document.createElement('div');
  sentinel.className = 'loader';
  sentinel.innerHTML = '<div class="spinner"></div>';
  container.after(sentinel);
  async function more() {
    if (loading || done) return;
    loading = true;
    try {
      const { posts, nextOffset } = await api(buildUrl(offset));
      if (!posts.length && offset === 0) onEmpty?.();
      container.insertAdjacentHTML('beforeend', posts.map(render).join(''));
      wireCards(container);
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
        ${state.categories.map((c) => `<button class="chip ${f.category === c ? 'active' : ''}" data-cat="${c}">${c}</button>`).join('')}
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
      following: ['Nobody to show yet', 'Follow creators and their posts will show up here.', state.me ? '<a class="btn primary" href="#/">Discover creators</a>' : '<button class="btn primary" data-action="signup">Sign up</button>'],
      saved: ['No saved posts', 'Tap the bookmark on any post to save it for later.', state.me ? '' : '<button class="btn primary" data-action="signup">Sign up</button>'],
    };
    const [h, p, b] = msgs[mode] || ['Nothing here yet', f.q || f.category || f.kind ? 'Try different filters.' : 'Be the first to post something!', '<button class="btn primary" data-action="upload">Create a post</button>'];
    grid.outerHTML = `<div class="empty"><h2>${h}</h2><p>${err?.status === 401 ? 'Log in to see this.' : p}</p>${b}</div>`;
  };
  let stop = infiniteList(grid, (offset) => `/api/posts?${qs({ ...params(), offset, limit: 12 })}`, cardHTML, emptyMsg);

  const reload = () => { stop(); viewHome({ mode, tag }); };
  $app.querySelector('#sortSel')?.addEventListener('change', (e) => { f.sort = e.target.value; reload(); });
  $app.querySelector('#kindSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-kind]'); if (b) { f.kind = b.dataset.kind; reload(); } });
  $app.querySelector('#catRow').addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (b) { f.category = b.dataset.cat; reload(); } });
  cleanupView = () => stop();
}

// --- TikTok-style vertical scroll ---
function railInner(p) {
  const isMe = state.me && state.me.id === p.author.id;
  return `
    <a class="rail-avatar" href="#/u/${esc(p.author.username)}">${avatar(p.author, 'md')}
      ${isMe ? '' : `<button class="follow-pill ${p.followingAuthor ? 'done' : ''}" data-follow="${esc(p.author.username)}" aria-label="${p.followingAuthor ? 'Unfollow' : 'Follow'}">${p.followingAuthor ? '✓ Following' : 'Follow'}</button>`}</a>
    <button class="rail-btn ${p.myReaction === 1 ? 'on-like' : ''}" data-like="${p.id}" aria-label="Like"><span class="circle">${ICON.like}</span>${fmt(p.likes)}</button>
    <button class="rail-btn ${p.myReaction === -1 ? 'on-dislike' : ''}" data-dislike="${p.id}" aria-label="Dislike"><span class="circle">${ICON.thumbDown}</span>${fmt(p.dislikes)}</button>
    <button class="rail-btn" data-comments="${p.id}" aria-label="Comments"><span class="circle">${ICON.comment}</span>${fmt(p.comments)}</button>
    <button class="rail-btn ${p.saved ? 'on-save' : ''}" data-save="${p.id}" aria-label="Save"><span class="circle">${ICON.save}</span>${p.saved ? 'Saved' : 'Save'}</button>
    <button class="rail-btn" data-share="${p.id}" aria-label="Share"><span class="circle">${ICON.share}</span>Share</button>`;
}
function reelHTML(p) {
  cachePost(p);
  let stage;
  if (p.kind === 'video') stage = `<div class="reel-stage" data-stage="${p.id}"><video src="${esc(p.media)}" loop playsinline preload="metadata"></video>
      <button class="icon-btn reel-mute" data-mute aria-label="Toggle sound">${reelMuted ? ICON.muted : ICON.sound}</button>
      <div class="paused-icon">${ICON.play}</div><div class="reel-progress"><div></div></div>`;
  else if (p.kind === 'image') stage = `<div class="reel-stage" data-stage="${p.id}"><img src="${esc(p.media)}" alt="">`;
  else stage = `<div class="reel-stage text-stage" data-stage="${p.id}" style="background:${gradFor(p.id)}"><p>${esc(p.caption)}</p>`;
  return `<section class="reel" data-reel="${p.id}">
    ${stage}
      <div class="reel-overlay">
        <a class="reel-author" href="#/u/${esc(p.author.username)}">@${esc(p.author.username)}<span class="sub">· ${ago(p.createdAt)}</span></a>
        ${p.kind !== 'text' && p.caption ? `<div class="reel-caption">${richText(p.caption)}</div>${p.caption.length > 120 ? '<button class="reel-more" data-more>more</button>' : ''}` : ''}
        <div class="sub" style="margin-top:4px">${fmt(p.views)} views · <span style="text-transform:capitalize">${esc(p.category)}</span>${state.me && state.me.id === p.author.id ? '' : ` · <button class="reel-report" data-report-post="${p.id}">⚑ Report</button>`}</div>
      </div>
    </div>
    <div class="rail" data-pid="${p.id}" data-part="rail">${railInner(p)}</div>
  </section>`;
}
let reelMuted = true;

function viewScroll() {
  const f = state.filters;
  const scrollFilter = { feed: 'foryou', ...state.scrollFilter };
  state.scrollFilter = scrollFilter;
  $app.classList.add('fullbleed');
  $app.innerHTML = `<div class="reel-wrap">
    <div class="reel-top">
      <div class="seg" id="feedSeg">
        <button data-feed="foryou" class="${scrollFilter.feed === 'foryou' ? 'active' : ''}">For You</button>
        <button data-feed="following" class="${scrollFilter.feed === 'following' ? 'active' : ''}">Following</button>
        <button data-feed="latest" class="${scrollFilter.feed === 'latest' ? 'active' : ''}">Latest</button>
      </div>
      <select class="select" id="reelCat" aria-label="Category"><option value="">All</option>${state.categories.map((c) => `<option value="${c}" ${f.category === c ? 'selected' : ''}>${c[0].toUpperCase() + c.slice(1)}</option>`).join('')}</select>
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
        const { posts, nextOffset } = await api(`/api/posts?${qs({ sort: sortFor[scrollFilter.feed], category: f.category, offset, limit: 6 })}`);
        if (!posts.length && offset === 0) {
          feed.innerHTML = `<div class="empty" style="padding-top:140px"><h2>Nothing to scroll yet</h2><p>${scrollFilter.feed === 'following' ? 'Follow some creators first.' : 'Try another category, or post something!'}</p><button class="btn primary" data-action="upload">Create a post</button></div>`;
          done = true; loading = false; return;
        }
        sentinel.insertAdjacentHTML('beforebegin', posts.map(reelHTML).join(''));
        posts.forEach((p) => observe(feed.querySelector(`[data-reel="${p.id}"]`)));
        if (nextOffset == null) done = true; else offset = nextOffset;
      } catch (e) {
        done = true;
        feed.innerHTML = `<div class="empty" style="padding-top:140px"><h2>${e.status === 401 ? 'Log in to see your Following feed' : 'Could not load'}</h2><p>${esc(e.message)}</p>${e.status === 401 ? '<button class="btn primary" data-action="signup">Sign up</button>' : ''}</div>`;
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
      reelMuted = !reelMuted;
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
  $app.querySelector('#reelCat').addEventListener('change', (e) => { f.category = e.target.value; cleanupView(); viewScroll(); });

  cleanupView = () => {
    stopList(); playIO.disconnect(); document.removeEventListener('keydown', onKey);
    feed.querySelectorAll('video').forEach((v) => v.pause());
    $app.classList.remove('fullbleed');
  };
}

// --- Comments (shared by watch page + drawer) ---
function commentHTML(c, post) {
  const mine = state.me && (state.me.id === c.author.id || state.me.id === post.author.id);
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
        ${c.hidden ? '<span class="review-inline">hidden after reports</span>' : ''}
      </div>
    </div>
  </div>`;
}
function commentFormHTML(placeholder = 'Add a comment…', parentId = '') {
  return `<form class="comment-form" data-parent="${parentId}">
    ${state.me ? avatar(state.me, parentId ? 'sm' : '') : '<span class="avatar" style="background:var(--bg-3)">?</span>'}
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
    if (!tops.length) { listEl.innerHTML = '<p class="sub" style="padding:20px 0;text-align:center">No comments yet. Start the conversation!</p>'; return; }
    listEl.innerHTML = tops.map((c) => {
      const reps = comments.filter((r) => r.parentId === c.id).sort((a, b) => a.createdAt - b.createdAt);
      const open = openThreads.has(c.id);
      return `<div class="thread" data-thread="${c.id}">${commentHTML(c, post)}
        ${reps.length ? `<button class="replies-toggle" data-toggle="${c.id}">${open ? '▲ Hide' : '▼ View'} ${reps.length} repl${reps.length === 1 ? 'y' : 'ies'}</button>` : ''}
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
      <button data-like="${p.id}" class="${p.myReaction === 1 ? 'on-like' : ''}" aria-label="Like">${ICON.thumbUp} ${fmt(p.likes)}</button>
      <button data-dislike="${p.id}" class="${p.myReaction === -1 ? 'on-dislike' : ''}" aria-label="Dislike">${ICON.thumbDown} ${fmt(p.dislikes)}</button>
    </div>
    <div class="ratio" title="${total ? Math.round((p.likes / total) * 100) + '% liked' : 'No ratings yet'}"><div style="width:${total ? (p.likes / total) * 100 : 50}%"></div></div>
  </div>
  <div class="pill-group"><button data-save="${p.id}" style="${p.saved ? 'color:#ffc93c' : ''}">${ICON.save} ${p.saved ? 'Saved' : 'Save'}</button></div>
  <div class="pill-group"><button data-share="${p.id}">${ICON.share} Share</button></div>`;
}

async function viewPost(id) {
  $app.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  let post;
  try { post = cachePost((await api(`/api/posts/${id}`)).post); }
  catch (e) { $app.innerHTML = `<div class="empty"><h2>Post not found</h2><p>It may have been deleted.</p><a class="btn primary" href="#/">Go home</a></div>`; return; }
  const author = (await api(`/api/users/${encodeURIComponent(post.author.username)}`)).user;
  const isMine = state.me && state.me.id === post.author.id;
  const canManage = isMine || state.me?.isAdmin;
  let player;
  if (post.kind === 'video') player = `<div class="player"><video src="${esc(post.media)}" controls autoplay playsinline></video></div>`;
  else if (post.kind === 'image') player = `<div class="player"><img src="${esc(post.media)}" alt=""></div>`;
  else player = `<div class="player text-player" style="background:${gradFor(post.id)}">${esc(post.caption)}</div>`;

  $app.innerHTML = `<div class="watch">
    <div>
      ${post.status === 'pending' ? `<div class="review-banner">⏳ <b>Under review.</b> ${isMine ? 'Only you can see this post until a moderator approves it.' : 'This post is hidden from the public.'} ${esc(post.modReason || '')}</div>` : ''}
      ${player}
      <h1>${esc(titleOf(post))}</h1>
      <div class="watch-row">
        <div class="grow author-line">
          <a href="#/u/${esc(author.username)}">${avatar(author, 'md')}</a>
          <div><a class="name" href="#/u/${esc(author.username)}">${esc(author.displayName)}</a><div class="sub" data-fcount>${fmt(author.followers)} follower${author.followers === 1 ? '' : 's'}</div></div>
          ${followBtn(author)}
        </div>
        <div class="watch-row" data-pid="${post.id}" data-part="pills">${pillsInner(post)}</div>
        <div class="menu"><button class="icon-btn" data-action="post-menu" aria-label="More">${ICON.dots}</button></div>
      </div>
      <div class="desc-box">
        <div class="sub"><span data-views>${fmt(post.views)}</span> views · ${ago(post.createdAt)} · <a href="#/" data-cat-link="${esc(post.category)}" style="text-transform:capitalize">${esc(post.category)}</a></div>
        ${post.caption ? `<div class="desc-text">${richText(post.caption)}</div>` : ''}
        ${post.tags.length ? `<div style="margin-top:8px">${post.tags.map((t) => `<a class="hashtag" href="#/tag/${esc(t)}">#${esc(t)}</a>`).join(' ')}</div>` : ''}
      </div>
      <section class="comments" id="comments">${commentsBlockHTML()}</section>
    </div>
    <aside><h3 style="margin:0 0 12px;font-size:16px">More like this</h3><div class="side-list" id="related"></div></aside>
  </div>`;

  api(`/api/posts/${id}/view`, { method: 'POST' }).then((r) => { const v = $app.querySelector('[data-views]'); if (v) v.textContent = fmt(r.views); }).catch(() => {});
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
      <div style="min-width:0"><div class="card-title">${esc(titleOf(p))}</div><div class="sub">${esc(p.author.displayName)}</div><div class="sub">${fmt(p.views)} views · ${ago(p.createdAt)}</div></div></div>`; }).join('')
      || '<p class="sub">Nothing else yet.</p>';
  });

  $app.querySelector('[data-cat-link]')?.addEventListener('click', (e) => { e.preventDefault(); state.filters.category = post.category; location.hash = '#/'; });
  $app.querySelector('[data-action="post-menu"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const wrap = e.currentTarget.closest('.menu');
    if (wrap.querySelector('.menu-pop')) return wrap.querySelector('.menu-pop').remove();
    wrap.insertAdjacentHTML('beforeend', `<div class="menu-pop">
      ${isMine ? '<button data-edit>Edit caption</button>' : ''}
      ${!isMine ? '<button data-rep>⚑ Report post</button>' : ''}
      ${canManage ? '<button class="danger" data-del>Delete post</button>' : ''}</div>`);
    wrap.querySelector('[data-rep]')?.addEventListener('click', () => { wrap.querySelector('.menu-pop').remove(); openReport('post', post.id); });
    if (!canManage) return;
    wrap.querySelector('[data-del]').onclick = async () => {
      if (!await ask('Delete this post forever?')) return;
      try { await api(`/api/posts/${post.id}`, { method: 'DELETE' }); toast('Post deleted'); location.hash = isMine ? `#/u/${post.author.username}` : '#/'; }
      catch (er) { toast(er.message, true); }
    };
    if (wrap.querySelector('[data-edit]')) wrap.querySelector('[data-edit]').onclick = () => {
      const m = openModal(`<h2>Edit post</h2><form class="form" id="editForm"><label>Caption<textarea name="caption" maxlength="2200" rows="6">${esc(post.caption)}</textarea></label>
        <label>Category<select name="category">${state.categories.map((c) => `<option ${c === post.category ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
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

// --- Profile ---
async function viewProfile(username) {
  $app.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  let u;
  try { u = (await api(`/api/users/${encodeURIComponent(username)}`)).user; }
  catch { $app.innerHTML = `<div class="empty"><h2>User not found</h2><a class="btn primary" href="#/">Go home</a></div>`; return; }
  let tab = 'posts', kind = '';
  $app.innerHTML = `
    <section class="profile-head">
      ${avatar(u, 'lg')}
      <div class="info">
        <h1>${esc(u.displayName)}</h1>
        <div class="handle">@${esc(u.username)} · joined ${new Date(u.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</div>
        <div class="profile-stats">
          <div><b>${fmt(u.posts)}</b>posts</div>
          <button data-list="followers"><b data-fcount>${fmt(u.followers)}</b>followers</button>
          <button data-list="following"><b>${fmt(u.following)}</b>following</button>
          <div><b>${fmt(u.likes)}</b>likes</div>
        </div>
        ${u.bio ? `<div class="profile-bio">${richText(u.bio)}</div>` : ''}
        ${u.isMe ? `<button class="btn" data-action="edit-profile">Edit profile</button> <button class="btn primary" data-action="upload">Create post</button>`
          : `<button class="btn ${u.isFollowing ? 'following' : 'primary'}" data-follow="${esc(u.username)}" data-profile-follow>${u.isFollowing ? 'Following' : 'Follow'}</button>`}
      </div>
    </section>
    <div class="tabs">
      <button data-tab="posts" class="active">Posts</button>
      <button data-tab="top">Most liked</button>
      ${u.isMe ? '<button data-tab="saved">Saved</button>' : ''}
      <div style="margin-left:auto;align-self:center" class="seg" id="pkind">${KINDS.map(([v, l]) => `<button data-kind="${v}" class="${v === '' ? 'active' : ''}">${l}</button>`).join('')}</div>
    </div>
    <div id="pgrid-wrap"></div>`;
  let stop = () => {};
  const load = () => {
    stop();
    const wrap = $app.querySelector('#pgrid-wrap');
    wrap.innerHTML = '<section class="grid" id="pgrid"></section>';
    const grid = wrap.querySelector('#pgrid');
    const params = tab === 'saved' ? { saved: 1, sort: 'latest' } : { user: u.username, sort: tab === 'top' ? 'top' : 'latest' };
    stop = infiniteList(grid, (offset) => `/api/posts?${qs({ ...params, kind, offset, limit: 12 })}`, cardHTML, () => {
      grid.outerHTML = `<div class="empty"><h2>${tab === 'saved' ? 'No saved posts' : 'No posts yet'}</h2>${u.isMe && tab !== 'saved' ? '<p>Share your first video or photo.</p><button class="btn primary" data-action="upload">Create a post</button>' : ''}</div>`;
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
    : p.kind === 'image' ? `<img src="${esc(p.media)}" alt="">` : `<div class="mod-text" style="background:${gradFor(p.id)}">${esc(p.caption)}</div>`;
  $app.innerHTML = `
    <div class="filter-head" style="margin-bottom:6px"><h1>🛡️ Moderation</h1></div>
    <p class="sub" style="margin-top:0">Posts flagged by the automatic safety check or reported by people. Pending posts are hidden from everyone except their creator until you approve them.</p>
    <h3>Posts <span class="sub">(${q.posts.length})</span></h3>
    ${q.posts.length ? `<div class="mod-grid">${q.posts.map((p) => `
      <div class="mod-item" data-mpost="${p.id}">
        <div class="mod-media">${media(p)}</div>
        <div class="mod-body">
          <div><span class="status-pill ${p.status}">${p.status === 'pending' ? 'Hidden · pending' : 'Live · reported'}</span></div>
          <div class="card-title" style="margin-top:6px">${esc(titleOf(p))}</div>
          <div class="sub">by <a href="#/u/${esc(p.author.username)}">@${esc(p.author.username)}</a> · ${ago(p.createdAt)}</div>
          ${p.modReason ? `<div class="sub">ℹ️ ${esc(p.modReason)}</div>` : ''}
          ${p.reports.length ? `<div class="sub">⚑ ${reportsLine(p.reports)}</div>` : ''}
          <div class="mod-actions">
            <button class="btn small" data-mod="approve">✓ Approve</button>
            <button class="btn small danger-btn" data-mod="remove">Remove</button>
            <button class="btn small ghost" data-ban="${esc(p.author.username)}">Ban user</button>
          </div>
        </div>
      </div>`).join('')}</div>` : '<p class="sub">Nothing to review. 🎉</p>'}
    <h3 style="margin-top:28px">Comments <span class="sub">(${q.comments.length})</span></h3>
    ${q.comments.length ? q.comments.map((c) => `
      <div class="mod-comment" data-mcomment="${c.id}">
        <div style="flex:1;min-width:0">
          <div class="sub"><a href="#/u/${esc(c.author.username)}">@${esc(c.author.username)}</a> on <a href="#/p/${c.postId}">post</a> · ${c.hidden ? 'hidden' : 'visible'} · ⚑ ${reportsLine(c.reports)}</div>
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
  $app.innerHTML = `<div class="rules">
    <h1>Community rules</h1>
    <p class="sub">VBrowse is for everyone. Breaking these rules gets content removed and accounts banned.</p>
    <ol>
      <li><b>No nudity or sexual content.</b> This includes explicit images, videos, links and sexual comments. Uploads are scanned automatically and blocked if they contain nudity.</li>
      <li><b>No hate or harassment.</b> No slurs, threats, bullying, or attacks on people for who they are.</li>
      <li><b>No violence or gore</b>, and nothing that encourages self-harm or dangerous acts.</li>
      <li><b>No spam or scams.</b> No fake giveaways, phishing, or repetitive self-promotion.</li>
      <li><b>Only post what you have the right to share.</b></li>
    </ol>
    <h3>How moderation works</h3>
    <ul>
      <li>🤖 Every photo and video is checked by an automatic nudity detector before it goes live. Clear violations are rejected; borderline ones are held for a human moderator.</li>
      <li>🚫 Captions, comments, names and bios are filtered for explicit words and slurs.</li>
      <li>⚑ Anyone can report a post or comment. After a few reports it is hidden until a moderator reviews it.</li>
      <li>🛡️ Moderators can approve, remove, and ban accounts.</li>
    </ul>
  </div>`;
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
    case 'rules': setNav(''); return viewRules();
    case 'u': setNav(state.me && parts[1] === state.me.username ? 'me' : ''); return viewProfile(parts[1]);
    case 'me':
      if (!state.me) { setNav('me'); $app.innerHTML = `<div class="empty"><h2>Your profile</h2><p>Sign up to post, follow creators and build your page.</p><button class="btn primary" data-action="signup">Sign up</button> <button class="btn" data-action="login">Log in</button></div>`; return; }
      location.replace(`#/u/${state.me.username}`); return;
    default: setNav(''); $app.innerHTML = `<div class="empty"><h2>Page not found</h2><a class="btn primary" href="#/">Go home</a></div>`;
  }
}

// ---------------- global events ----------------
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (a) {
    const act = a.dataset.action;
    if (act === 'login') { e.preventDefault(); return openAuth('login'); }
    if (act === 'signup') { e.preventDefault(); return openAuth('signup'); }
    if (act === 'upload') { e.preventDefault(); return openUpload(); }
    if (act === 'close-modal') return closeModal();
    if (act === 'close-modal-nav') return closeModal();
    if (act === 'usermenu') { e.stopPropagation(); return openUserMenu(a); }
    if (act === 'edit-profile') { document.querySelector('.menu-pop')?.remove(); return openEditProfile(); }
    if (act === 'clear-search') { state.filters.q = ''; document.getElementById('searchInput').value = ''; return route(); }
    if (act === 'logout') {
      api('/api/logout', { method: 'POST' }).then(() => { state.me = null; state.posts.clear(); renderTop(); toast('Logged out'); location.hash = '#/'; route(); });
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
          el.textContent = el.tagName === 'B' ? fmt(r.followers) : `${fmt(r.followers)} follower${r.followers === 1 ? '' : 's'}`;
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
  if (q.startsWith('@') && /^@[\w.]+$/.test(q)) { location.hash = `#/u/${q.slice(1).toLowerCase()}`; return; }
  state.filters.q = q;
  if (location.hash === '#/' || location.hash === '') route(); else location.hash = '#/';
});

window.addEventListener('hashchange', route);

// ---------------- boot ----------------
(async () => {
  try { const r = await api('/api/me'); state.me = r.user; state.categories = r.categories; state.hosted = r.hosted || null; } catch {}
  if (HOSTED) document.body.classList.add('hosted');
  renderTop();
  if (HOSTED && !state.me && state.hosted && state.hosted.canWrite && !state.hosted.hasProfile) setTimeout(() => openAuth('signup', 'Pick a username so people can find you.'), 400);
  route();
})();
})();
