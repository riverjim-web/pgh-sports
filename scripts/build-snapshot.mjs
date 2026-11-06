// Fetch every feed and write data/snapshot.json. Runs in GitHub Actions on a
// schedule (see .github/workflows/deploy.yml) and locally with `npm run snapshot`.

import { mkdir, writeFile } from 'node:fs/promises';
import { buildAll } from '../assets/feeds.js';

const state = await buildAll({
  env: 'node',
  userAgent: 'pgh-sports-dashboard/1.0 (personal, non-commercial GitHub Pages project)',
});

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/snapshot.json', import.meta.url), JSON.stringify(state));

const failed = state.sources.filter((s) => !s.ok);
console.log(`snapshot ${state.generatedAt}: ${state.sources.length} requests, ${failed.length} failed`);
for (const s of failed) console.log(`  x ${s.id}: ${s.error} (${s.url})`);
for (const [key, t] of Object.entries(state.teams)) {
  console.log(`  ${key}: ${t.unavailable ? `UNAVAILABLE ${t.unavailable}` : `${t.record?.summary ?? '?'} · next ${t.next ? `${t.next.date} vs ${t.next.opp?.abbr}` : 'none'}`}`);
}
for (const c of state.checks) console.log(`  ${c.agree ? 'ok  ' : c.severity === 'info' ? 'info' : 'WARN'} ${c.label}: ${c.a.value} | ${c.b.value}`);

// One flaky feed should not take the site down; only fail when nothing loaded.
if (Object.values(state.teams).every((t) => t.unavailable)) process.exit(1);
