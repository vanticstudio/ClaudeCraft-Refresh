// Declares every audio file in public/theme-music/ as licensed, in one command:
//
//   npm run theme:clear -- --license "Epidemic Sound, subscription #12345"
//
// Writes public/theme-music/CLEARED.json, which the ship gate reads at build
// time (scripts/gen-theme-manifest.mjs). Without an entry per file the gate
// emits an empty manifest and the theme layer ships off.
//
// The --license text is a HUMAN ASSERTION of provenance. Tooling can check that
// a file is declared; it cannot check that the declaration is true. Only run
// this for audio you actually hold the rights to.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'public', 'theme-music');
const OUT = join(DIR, 'CLEARED.json');
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.oga', '.m4a', '.aac', '.wav', '.opus', '.flac', '.webm']);

const argv = process.argv.slice(2);
const li = argv.indexOf('--license');
const license = li >= 0 ? argv[li + 1] : null;

if (!license || license.startsWith('--')) {
  console.error(`
[theme:clear] A licence statement is required.

  npm run theme:clear -- --license "original — © Your Studio 2026"
  npm run theme:clear -- --license "Epidemic Sound, subscription #12345"
  npm run theme:clear -- --license "CC0 — Kevin MacLeod, incompetech.com"

This records WHO owns each track and under what terms. It is the one part of the
ship gate a machine cannot verify for you.
`);
  process.exit(1);
}

if (!existsSync(DIR)) {
  console.error(`[theme:clear] ${DIR} does not exist — nothing to declare.`);
  process.exit(1);
}

const files = (await readdir(DIR))
  .filter(f => AUDIO_EXT.has(extname(f).toLowerCase()))
  .sort();

if (!files.length) {
  console.log('[theme:clear] no audio files in public/theme-music/ — nothing to declare.');
  console.log('              Drop tracks in first, then re-run.');
  process.exit(0);
}

// Preserve any existing per-file licence text rather than flattening it.
let existing = new Map();
if (existsSync(OUT)) {
  try {
    const json = JSON.parse(await readFile(OUT, 'utf8'));
    existing = new Map((json?.tracks ?? []).filter(t => t?.file).map(t => [t.file, t.license]));
  } catch { /* unreadable → rewrite from scratch */ }
}

const tracks = files.map(file => ({ file, license: existing.get(file) ?? license }));
await writeFile(OUT, JSON.stringify({ tracks }, null, 2) + '\n');

const added = files.filter(f => !existing.has(f));
console.log(`[theme:clear] declared ${tracks.length} track(s) in public/theme-music/CLEARED.json`);
for (const t of tracks) {
  console.log(`  ${existing.has(t.file) ? ' kept ' : ' NEW  '} ${t.file}  —  ${t.license}`);
}
if (added.length) console.log(`\n  ${added.length} newly declared as: ${license}`);
console.log('\n  Next: npm run build   (the gate will now pass these through to dist/)');
