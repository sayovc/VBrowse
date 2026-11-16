/* VBrowse browser-side NSFW scan (nsfwjs + TensorFlow.js, loaded on first use from jsDelivr).
   Used when the server can't run the model itself (Cloudflare Workers free plan).
   Returns 'ok' | 'review' | 'reject' | 'unavailable' for an image or video File. */
(function () {
'use strict';
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

window.VBScan = { scanFile, preload: () => loadModel().catch(() => {}) };
})();
