/* Inlines the app into one self-contained page (dist/artifact.html) for
   publishing or emailing around. Run: node scripts/build-artifact.mjs */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const html = read('index.html');
const css = read('assets/styles.css');
const data = read('assets/data.js');
const app = read('assets/app.js');

/* Take everything between <body> and </body> — the artifact host supplies the
   document skeleton, so we only ship the page content. */
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1]
  .replace(/\s*<script src="assets\/[^"]+"><\/script>/g, '')
  .trim();

const out = `<title>ResolveIQ Customer Care Console</title>
<style>
${css}
</style>

${body}

<script>
${data}
</script>
<script>
${app}
</script>
`;

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/artifact.html'), out);
console.log(`dist/artifact.html — ${(out.length / 1024).toFixed(1)} KB`);
