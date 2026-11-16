// Content moderation:
//  1. Images/videos are scanned by an on-server NSFW classifier (nsfwjs + TensorFlow.js WASM).
//     Videos are scanned frame by frame using ffmpeg.
//  2. Captions, comments, bios and names go through a word filter.
// Uploads that are clearly explicit are rejected outright; borderline ones are held for review.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Thresholds (0..1). "explicit" = Porn + Hentai probability.
const REJECT_EXPLICIT = Number(process.env.NSFW_REJECT || 0.5);
const REVIEW_EXPLICIT = Number(process.env.NSFW_REVIEW || 0.2);
const REVIEW_SEXY = Number(process.env.NSFW_REVIEW_SEXY || 0.7);
const VIDEO_FRAMES = 8;

let modelPromise = null;
let tf, sharp;
function loadModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      tf = require('@tensorflow/tfjs');
      require('@tensorflow/tfjs-backend-wasm');
      sharp = require('sharp');
      const nsfw = require('nsfwjs');
      // silence the tfjs "use tfjs-node" banner
      const log = console.log; console.log = () => {};
      try {
        await tf.setBackend('wasm'); await tf.ready();
        tf.enableProdMode();
        return await nsfw.load('MobileNetV2Mid');
      } finally { console.log = log; }
    })().catch((e) => { modelPromise = null; throw e; });
  }
  return modelPromise;
}

async function classifyImage(file) {
  const model = await loadModel();
  const { data, info } = await sharp(file, { animated: false })
    .resize(224, 224, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);
  try {
    const preds = await model.classify(img);
    return Object.fromEntries(preds.map((p) => [p.className, p.probability]));
  } finally { img.dispose(); }
}

const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: 120000, maxBuffer: 1 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));

async function videoFrames(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-frames-'));
  let duration = 0;
  try { duration = parseFloat(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])) || 0; } catch {}
  const times = duration > 0
    ? Array.from({ length: VIDEO_FRAMES }, (_, i) => (duration * (i + 0.5)) / VIDEO_FRAMES)
    : [0];
  const frames = [];
  for (const [i, t] of times.entries()) {
    const out = path.join(dir, `f${i}.jpg`);
    try {
      await run('ffmpeg', ['-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', '-y', out]);
      if (fs.existsSync(out)) frames.push(out);
    } catch {}
  }
  return { dir, frames };
}

function decide(scores) {
  const explicit = (scores.Porn || 0) + (scores.Hentai || 0);
  const sexy = scores.Sexy || 0;
  if (explicit >= REJECT_EXPLICIT) return { verdict: 'reject', explicit, sexy };
  if (explicit >= REVIEW_EXPLICIT || sexy >= REVIEW_SEXY) return { verdict: 'review', explicit, sexy };
  return { verdict: 'ok', explicit, sexy };
}

// Returns { verdict: 'ok' | 'review' | 'reject', reason, score }
async function scanMedia(file, kind) {
  try {
    let worst = { verdict: 'ok', explicit: 0, sexy: 0 };
    const rank = { ok: 0, review: 1, reject: 2 };
    const consider = (d) => { if (rank[d.verdict] > rank[worst.verdict] || (d.verdict === worst.verdict && d.explicit > worst.explicit)) worst = d; };
    if (kind === 'video') {
      const { dir, frames } = await videoFrames(file);
      try {
        if (!frames.length) return { verdict: 'review', reason: 'Could not read video frames for safety check' };
        for (const f of frames) { consider(decide(await classifyImage(f))); if (worst.verdict === 'reject') break; }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    } else {
      consider(decide(await classifyImage(file)));
    }
    const reason = worst.verdict === 'reject' ? 'Nudity or sexual content detected'
      : worst.verdict === 'review' ? 'Possibly sensitive content (auto-flagged)' : '';
    return { verdict: worst.verdict, reason, score: Math.round(Math.max(worst.explicit, worst.sexy) * 100) / 100 };
  } catch (e) {
    console.error('Moderation scan failed:', e.message);
    // Fail safe: if the scanner breaks, hold the post for a human instead of publishing it.
    return { verdict: 'review', reason: 'Automatic safety check unavailable' };
  }
}

// ---------- text filter (shared with the hosted build) ----------
const { checkText } = require('./public/textfilter.js');

module.exports = { loadModel, scanMedia, checkText, decide };
