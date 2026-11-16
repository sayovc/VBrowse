/* Shared word filter for VBrowse — used by the Node server and the hosted (browser) build. */
(function (root) {
// Explicit sexual terms and slurs. Matching ignores case, common l33t substitutions,
// and separators like "p.o.r.n" or "p o r n".
const BLOCKED = [
  'porn', 'porno', 'pornhub', 'xvideos', 'xhamster', 'onlyfans', 'nudes', 'nude pics', 'send nudes', 'hentai', 'xxx',
  'blowjob', 'handjob', 'rimjob', 'cumshot', 'creampie', 'gangbang', 'bukkake', 'deepthroat', 'milf', 'dildo', 'vibrator',
  'pussy', 'cock', 'dick pic', 'tits', 'titties', 'boobs', 'cum', 'jizz', 'anal', 'orgasm', 'masturbat', 'jerk off', 'jack off',
  'fingering', 'horny', 'nsfw', 'sex tape', 'sexting', 'camgirl', 'escort', 'stripper', 'nipple', 'erotic', 'fetish', 'bdsm',
  'rape', 'molest', 'pedo', 'paedo', 'loli', 'cp ', 'child porn',
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'tranny', 'chink', 'spic', 'kike', 'wetback', 'coon',
];
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '+': 't' };
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[013457@$!+]/g, (c) => LEET[c]);
}
const words = [...new Set(BLOCKED.map((w) => w.trim()))];
// Short words must match exactly (so "cocktail", "analysis", "scum" are fine); longer ones match at a word start
// (so "masturbat" catches "masturbating" but "grapes" is not "rape").
const SHORT_EXACT = new Set(['cock', 'cum', 'anal', 'fag', 'tits', 'coon', 'spic', 'xxx', 'cp', 'milf', 'jizz', 'loli', 'rape', 'pedo', 'boobs']);
const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = words.map((w) => new RegExp(SHORT_EXACT.has(w)
  ? `(^|[^a-z])${escapeRe(w)}(s|d|ing)?($|[^a-z])`
  : `(^|[^a-z])${escapeRe(w)}`));
function checkText(s) {
  const n = normalize(s);
  // join spaced-out letters: "p o r n" / "p.o.r.n" / "p-o-r-n" -> "porn"
  const joined = n.replace(/(?<=(?:^|[^a-z])[a-z])[\s.\-_*]+(?=[a-z](?:$|[^a-z]))/g, '');
  for (const [i, re] of patterns.entries()) if (re.test(n) || re.test(joined)) return { ok: false, word: words[i] };
  return { ok: true };
}


  // ---------- handles (like YouTube @handles) ----------
  const RESERVED = new Set(['admin', 'administrator', 'mod', 'moderator', 'moderation', 'support', 'help', 'staff', 'official',
    'vbrowse', 'vibebrowse', 'api', 'uploads', 'settings', 'account', 'login', 'logout', 'signup', 'register', 'me', 'root',
    'system', 'null', 'undefined', 'everyone', 'here', 'anonymous', 'deleted', 'unknown', 'owner', 'rules', 'home', 'scroll',
    'following', 'saved', 'search', 'tag', 'tags']);
  // Returns an error message, or '' when the handle is fine. Handles are stored lowercase.
  function validateHandle(raw) {
    const h = String(raw || '').trim().replace(/^@/, '').toLowerCase();
    if (h.length < 3) return 'Your handle needs at least 3 characters.';
    if (h.length > 30) return 'Your handle can be at most 30 characters.';
    if (!/^[a-z0-9._-]+$/.test(h)) return 'Use only letters, numbers, periods (.), underscores (_) and hyphens (-). No spaces.';
    if (!/^[a-z0-9]/.test(h)) return 'Your handle has to start with a letter or number.';
    if (!/[a-z0-9]$/.test(h)) return 'Your handle has to end with a letter or number.';
    if (/[._-]{2,}/.test(h)) return "Symbols can't be next to each other (like .. or __ or ._).";
    if (!/[a-z]/.test(h)) return 'Your handle needs at least one letter.';
    if (RESERVED.has(h)) return 'That handle is reserved. Try another one.';
    if (!checkText(h)) return "That handle isn't allowed on VBrowse.";
    return '';
  }
  // Display names: trimmed, single spaces, no invisible/control characters, must contain a letter or number.
  function cleanName(raw) {
    return String(raw || '').normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
      .replace(/\s+/g, ' ').trim();
  }
  function validateName(raw) {
    const n = cleanName(raw);
    if (!n) return 'Enter a name.';
    if (n.length > 50) return 'Your name can be at most 50 characters.';
    if (!/[\p{L}\p{N}]/u.test(n)) return 'Your name needs at least one letter or number.';
    if (!checkText(n)) return "That name isn't allowed on VBrowse.";
    return '';
  }
  function validatePassword(pw, handle, email) {
    pw = String(pw || '');
    if (pw.length < 8) return 'Use 8 or more characters for your password.';
    if (pw.length > 200) return 'That password is too long.';
    if (!/[a-zA-Z]/.test(pw) || !/[0-9\W_]/.test(pw)) return 'Use a mix of letters and numbers or symbols.';
    const low = pw.toLowerCase();
    if ((handle && low.includes(String(handle).toLowerCase())) || (email && low === String(email).toLowerCase())) return "Your password can't contain your handle or email.";
    return '';
  }
  const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
  function validateEmail(e) {
    e = String(e || '').trim();
    if (!e) return 'Enter your email address.';
    if (e.length > 254 || !EMAIL_RE.test(e)) return 'Enter a valid email address, like name@example.com.';
    return '';
  }

  const api = { checkText, BLOCKED, validateHandle, validateName, cleanName, validatePassword, validateEmail };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.VBTextFilter = api;
})(typeof self !== 'undefined' ? self : this);
