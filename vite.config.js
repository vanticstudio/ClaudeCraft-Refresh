import { rm, readdir, readFile } from 'node:fs/promises';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { join, basename, resolve, extname } from 'node:path';
import pkg from './package.json' with { type: 'json' };
import { generateThemeManifest, AUDIO_EXT } from './scripts/gen-theme-manifest.mjs';

const MIME = {
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.wav': 'audio/wav', '.opus': 'audio/opus', '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

// DEV ONLY: serve the C418 placeholders (16-AUDIO §4A.1) from CC-assets/CC-sounds
// at /theme-music/*. They deliberately live OUTSIDE publicDir: Vite dereferences
// symlinks and copies publicDir wholesale at renderStart, so anything in there
// lands in dist/ on every build. Keeping them out means a placeholder leak is
// structurally impossible instead of something the ship gate has to race.
// The shipped set goes in public/theme-music/ and is copied normally.
function themeMusicDevServe() {
  return {
    name: 'theme-music-dev-serve',
    apply: 'serve',
    configureServer(server) {
      const dir = join(server.config.root, 'CC-assets', 'CC-sounds');
      if (!existsSync(dir)) return;
      server.middlewares.use('/theme-music', (req, res, next) => {
        let name;
        try {
          // basename() strips any ../ traversal; decodeURIComponent throws
          // URIError on malformed escapes (e.g. /theme-music/%E0%A4%A)
          name = basename(decodeURIComponent((req.url || '').split('?')[0]));
        } catch { return next(); }
        const file = join(dir, name);
        const dot = name.lastIndexOf('.');
        const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
        if (!MIME[ext] || !existsSync(file) || !statSync(file).isFile()) return next();
        const { size } = statSync(file);
        const range = req.headers.range;
        res.setHeader('Content-Type', MIME[ext]);
        res.setHeader('Accept-Ranges', 'bytes');
        if (range) {                                  // <audio> streaming needs 206
          const [s, e] = range.replace(/bytes=/, '').split('-');
          const start = parseInt(s, 10) || 0;
          const end = e ? parseInt(e, 10) : size - 1;
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
          res.setHeader('Content-Length', end - start + 1);
          createReadStream(file, { start, end }).pipe(res);
        } else {
          res.setHeader('Content-Length', size);
          createReadStream(file).pipe(res);
        }
      });
      server.config.logger.info(
        '\x1b[33m  ➜  theme-music: serving C418 dev placeholders from CC-assets/CC-sounds ' +
        '(local only — never bundled)\x1b[0m');
    },
  };
}

// Audio copyright ship-gate backstop (16-AUDIO §4A, 17-SHIP §3.5, 19-MAIN-MENU §0).
// Nothing should reach dist/theme-music unless someone put cleared tracks in
// public/theme-music/. This verifies that and deletes anything undeclared —
// covering the case where placeholders get copied into publicDir by hand.
// closeBundle also runs when a build throws (vite wraps bundle.close() in a
// finally), so a failed build cannot leave tracks behind either.
function themeMusicShipGate() {
  let outDir = 'dist';
  return {
    name: 'theme-music-ship-gate',
    apply: 'build',
    // build.outDir stays RELATIVE ('dist') after resolveConfig — joining it bare
    // would resolve against process.cwd(), so a build launched from any other
    // directory would check the wrong path and wave the tracks through.
    configResolved(cfg) { outDir = resolve(cfg.root, cfg.build.outDir); },
    // Regenerate the manifest with build semantics HERE, not only from the npm
    // `prebuild` hook: `npx vite build` bypasses pre* scripts, and a manifest
    // left over from `npm run dev` would otherwise bake the 14 placeholder
    // track names into the shipped bundle (no audio, but the site would fetch
    // them, and the theme layer would not be off). Verified: without this,
    // dist/assets/index.js contained the full C418 playlist.
    async buildStart() {
      const { count, uncleared } = await generateThemeManifest({ build: true, quiet: true });
      if (uncleared.length) {
        this.warn(`[ship-gate] ${uncleared.length} undeclared track(s) in public/theme-music/ ` +
          'withheld from the manifest — theme layer ships off (17-SHIP §3.5).');
      }
      this.info?.(`[ship-gate] theme manifest: ${count} cleared track(s).`);
    },
    // closeBundle runs after the publicDir → outDir copy has completed.
    async closeBundle() {
      const shipped = join(outDir, 'theme-music');
      if (!existsSync(shipped)) return;

      const cleared = new Set();
      try {
        const json = JSON.parse(await readFile(join(shipped, 'CLEARED.json'), 'utf8'));
        for (const t of json?.tracks ?? []) if (t?.file && t?.license) cleared.add(t.file);
      } catch { /* absent or unreadable → nothing is cleared */ }

      const entries = await readdir(shipped, { withFileTypes: true });

      // Companions (README.md, CLEARED.json) are documentation and the licence
      // record — not tracks, and not wanted on a public URL. Strip them from the
      // build rather than counting them as undeclared audio: doing the latter
      // deleted the whole folder while the manifest still referenced the tracks,
      // shipping a bundle whose every theme URL 404s.
      const isAudio = n => AUDIO_EXT.has(extname(n).toLowerCase());
      for (const e of entries) {
        if (e.isFile() && !isAudio(e.name)) await rm(join(shipped, e.name), { force: true });
      }

      // Only AUDIO is policed against CLEARED.json. A directory is never
      // "cleared" — a folder named in CLEARED.json would ship its whole subtree
      // unchecked — and a non-audio file has already been removed above, so it
      // cannot smuggle a renamed track onto the deploy either.
      const audio = entries.filter(e => e.isFile() && isAudio(e.name)).map(e => e.name);
      const dirs = entries.filter(e => !e.isFile()).map(e => e.name);
      const uncleared = [...audio.filter(n => !cleared.has(n)), ...dirs];

      if (audio.length && !uncleared.length) {
        this.warn(`[ship-gate] ${audio.length} theme track(s) shipped — all declared cleared.`);
        return;
      }
      await rm(shipped, { recursive: true, force: true });
      if (uncleared.length) {
        this.warn(
          `[ship-gate] REMOVED ${outDir}/theme-music from the build: ${uncleared.length} ` +
          `track(s) are not declared in CLEARED.json (${uncleared.slice(0, 2).join(', ')}` +
          `${uncleared.length > 2 ? ', …' : ''}). Shipping with the theme layer off ` +
          `(17-SHIP §3.5). Declare original/licensed tracks in CLEARED.json to ship them.`);
      }
    },
  };
}

export default {
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { target: 'es2022' },
  worker: { format: 'es' },   // terrain worker uses ES module imports
  plugins: [themeMusicDevServe(), themeMusicShipGate()],
};
