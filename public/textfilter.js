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


  const api = { checkText, BLOCKED };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.VBTextFilter = api;
})(typeof self !== 'undefined' ? self : this);
