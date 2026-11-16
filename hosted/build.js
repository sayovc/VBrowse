// Bundles the shared frontend + hosted backend into one self-contained page for the Claude Artifact.
// Usage: node hosted/build.js   ->  hosted/dist/vbrowse.html
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const noCloseTag = (js, name) => { if (/<\/script/i.test(js)) throw new Error(`${name} contains </script>`); return js; };

const index = read('public/index.html');
const body = index.slice(index.indexOf('<body>') + 6, index.indexOf('<script src="/app.js">')).trim();

const html = `<title>VBrowse</title>
<meta name="description" content="VBrowse (VibeBrowse): scroll, post, like, dislike, comment and follow.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
${read('public/styles.css')}
html, body { background: var(--bg); }
</style>
${body}
<script>
${noCloseTag(read('public/textfilter.js'), 'textfilter.js')}
</script>
<script>
${noCloseTag(read('hosted/backend.js'), 'backend.js')}
</script>
<script>
${noCloseTag(read('public/app.js'), 'app.js')}
</script>
`;
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'vbrowse.html'), html);
console.log(`Built hosted/dist/vbrowse.html (${(html.length / 1024).toFixed(0)} KB)`);
