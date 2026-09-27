// B11 — generates the service worker's precache list by scanning dist/ AFTER a
// build. Deliberately NOT wired into vite: other agents run concurrent builds
// and dist/ races, so this runs manually post-build:
//
//   npx vite build && node scripts/gen-pwa-manifest.mjs
//
// Outputs (mirrors the gen-theme-manifest.mjs pattern):
//   dist/sw-manifest.json       — authoritative; public/sw.js fetches it at
//                                 install time from the deployed root.
//   public/sw-manifest.json     — checked-in mirror, so a fresh checkout's SW
//                                 still has a sane list before the next build.
//
// The list is relative URLs ('./', './assets/index-*.js', …) resolved against
// the SW's own location (the site root — vite base is './').
import { readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT_DIST = join(DIST, 'sw-manifest.json');
const OUT_PUBLIC = join(ROOT, 'public', 'sw-manifest.json');

// Ship types only — what a cold offline load can actually request.
const INCLUDE_EXT = new Set([
  '.html', '.js', '.css', '.json', '.webmanifest', '.png', '.jpg', '.jpeg',
  '.webp', '.svg', '.ico', '.wasm', '.ttf', '.woff', '.woff2',
]);
// Never precache: the manifest itself (it would cache the list out from under
// future runs) and theme-music (17-SHIP §3 — never bundled/served from builds).
const SKIP = new Set(['sw-manifest.json']);

async function walk(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'theme-music') continue;
      await walk(full, base, out);
    } else if (INCLUDE_EXT.has(extname(entry.name).toLowerCase()) && !SKIP.has(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export async function generatePwaManifest({ quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  if (!existsSync(DIST)) {
    throw new Error('dist/ not found — run `npx vite build` first, then this script');
  }
  const files = (await walk(DIST)).map(f => {
    // URL-encode so spaces/#/? in filenames survive cache.put(); keep '/' real.
    const rel = relative(DIST, f).split('\\').join('/');
    return './' + (rel === 'index.html' ? '' : rel.split('/').map(encodeURIComponent).join('/'));
  });
  const list = { generated: new Date().toISOString(), files: ['./', ...new Set(files.filter(f => f !== './'))] };

  const body = JSON.stringify(list, null, 2) + '\n';
  await writeFile(OUT_DIST, body);
  await writeFile(OUT_PUBLIC, body);   // checked-in mirror (see header)
  log(`[pwa-manifest] ${list.files.length} file(s) → dist/sw-manifest.json (+ public mirror)`);
  return list;
}

// CLI: regenerate + sanity-check that the webmanifest's icon actually shipped.
// argv[1] can be relative (`node scripts/gen-pwa-manifest.mjs`) — resolve it to
// a file:// URL before comparing with import.meta.url, or the guard silently
// no-ops with exit 0.
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
if (process.argv[1] &&
    import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  generatePwaManifest()
    .then(list => {
      // manifest.webmanifest references menu/logo-primary.png for both sizes
      const icon = 'menu/logo-primary.png';
      const ok = list.files.includes('./' + icon) && existsSync(join(DIST, icon));
      console.log(`[pwa-manifest] icon ${icon} ${ok ? 'present in dist' : 'MISSING from dist'}`);
      if (!ok) process.exitCode = 1;
    })
    .catch(err => { console.error('[pwa-manifest]', err.message); process.exit(1); });
}