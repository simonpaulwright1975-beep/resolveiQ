/* Inlines the app into one self-contained page (dist/artifact.html) for
   publishing or emailing around. Run: node scripts/build-artifact.mjs */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const html = read('index.html');
const css = read('assets/styles.css');
const sample = read('assets/sample-data.js');
const loader = read('assets/data.js');
const app = read('assets/app.js');
const api = read('assets/api.js');

/* Take everything between <body> and </body> — the artifact host supplies the
   document skeleton, so we only ship the page content.

   The pattern must tolerate attributes in any order and any position: an
   earlier version matched only `<script src="assets/...">` exactly, so
   `<script type="module" src="assets/new-case.mjs">` survived into the
   artifact, pointing at a file that is not there. The button it powers was
   shipped looking usable and did nothing. */
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1]
  .replace(/\s*<script\b[^>]*\bsrc="assets\/[^"]*"[^>]*><\/script>/g, '')
  .trim();

/* Nothing here can reach a server, so raising a case is impossible. Say so on
   the button rather than letting it open a dialog that fails on first search. */
const disableNewCase = `
/* Static artifact: there is no server, so a case cannot be raised. */
(function () {
  var btn = document.getElementById('new-case-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.title = 'Raising a case needs the ResolveIQ server — this is a static preview.';
  btn.style.opacity = '0.5';
  btn.style.cursor = 'not-allowed';
})();
`;

const out = `<title>ResolveIQ Customer Care Console</title>
<style>
${css}
</style>

${body}

<script>
${api}
</script>
<script>
${sample}
</script>
<script>
${loader}
</script>
<script>
${app}
</script>
<script>
${disableNewCase}
</script>
`;

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/artifact.html'), out);
console.log(`dist/artifact.html — ${(out.length / 1024).toFixed(1)} KB`);
