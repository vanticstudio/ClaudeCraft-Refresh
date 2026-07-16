# 17-SHIP.md — Final Pass, Cleanup & Deploy (run once, after all phases pass)

This is the last file you execute. Everything in CLAUDE.md's phase tables is built and gated. Your job now: one correction sweep, clean the repo, and make it live — GitHub push + Vercel hosting, playable in a browser. The repo is **already `git init`'d — do not re-init.**

## 1. Correction sweep

1. Run **every acceptance checklist** (base 01–06 + expansions 07–16) end-to-end in the browser. Fix every failure before proceeding — no known-broken items ship.
2. Review `DEVIATIONS.md`: fix anything cheap to fix now; everything that stays becomes a documented "Known deviations" section appended to that file. Zero undocumented drift.
3. Console must be clean: no errors, no warning spam, no leftover `console.log` debugging (keep an intentional startup banner + F3 overlay; F3 stays, off by default).
4. Delete dead code, unused modules, commented-out blocks, TODO stubs. Verify no `TODO`/`FIXME`/`HACK` remains unresolved (`grep -rn "TODO\|FIXME\|HACK" src/`).
5. Perf verification against budgets (CLAUDE.md §6): 60 fps at render distance 8 with mobs + a redstone clock + audio running; no unbounded memory growth over 10 minutes (watch heap in devtools).
6. Save integrity: fresh world → play → reload → identical; old-save load doesn't crash after all expansion schema changes (if pre-expansion saves are incompatible, detect version and offer "new world" gracefully — never a crash).
7. Cross-browser sanity: Chrome is the target; do a 5-minute smoke test in Firefox and Safari — fix cheap breakages, document the rest in README.

## 2. The one server — relay cleanup (critical for Vercel)

Vercel hosts **static files and serverless functions only — it cannot run the persistent WebSocket relay (`server/relay.js`).** Restructure so the game is 100% static and the relay is optional:

1. `server/` is **excluded from the web build** (it's plain Node, run separately via `npm run relay`).
2. Single-player must work with the relay completely absent — no connection attempts, no console errors, NetHost dormant (14's requirement; verify it).
3. Multiplayer UI: relay URL becomes a text field on the Host/Join screen (default empty ⇒ multiplayer buttons show "relay required" hint + link to README section). Persist last-used URL in localStorage.
4. HTTPS rule: a page served over https (Vercel) can only open **`wss://`** sockets — enforce/auto-upgrade the scheme and surface a clear error for `ws://` attempts (mixed content is silently blocked otherwise).
5. Document the two supported relay options in README: (a) run locally + tunnel (`npm run relay` + cloudflared/ngrok, paste the wss URL), (b) deploy `server/relay.js` to a free persistent-Node host (Render/Railway/Fly — include a 5-line deploy note; it's a single file with one `ws` dependency).

## 3. Production build correctness

1. Workers must use Vite-bundleable syntax: `new Worker(new URL('./xxx.worker.js', import.meta.url), { type: 'module' })` — dev-only worker paths are the classic works-in-dev-breaks-in-prod bug. Verify every worker.
2. `npm run build` succeeds with zero warnings that matter; then `npx vite preview` and play — worldgen, saves, audio (requires the click-to-start gesture — verify it still fires), pointer lock all work identically to dev.
3. No dynamic asset fetches exist beyond the optional theme-music tracks (16-AUDIO §4A) — everything else is procedural; confirm the network tab shows only bundled JS/CSS plus, if the theme-music layer is enabled, the served `public/theme-music/` tracks (which must be original/cleared — see item 5).
4. IndexedDB + pointer lock + AudioContext all work on the deployed https origin (they do; just verify once live).
5. **Audio copyright gate (16-AUDIO §4A):** verify `public/theme-music/` contains **zero** copyrighted / C418 / Minecraft-soundtrack tracks — every shipped theme track is original or properly licensed. The C418 dev placeholders (`CC-assets/CC-sounds/`) must be gitignored and absent from `dist/`. If no cleared tracks are provided, ship with the theme layer `off` (synth generative music only). No copyrighted audio goes live — this is a hard gate.

## 4. Repo hygiene → GitHub

1. `.gitignore`: `node_modules/`, `dist/`, `.vercel/`, `.DS_Store`, editor junk.
2. `package.json`: proper `name`, `description`, `scripts` (`dev`, `build`, `preview`, `relay`), pinned deps.
3. Secrets check: there should be none — verify (`grep -rn "key\|secret\|token" --include="*.js" src/ server/` and eyeball).
4. Write `README.md`: what it is (browser voxel survival game, built from spec by AI), live URL placeholder, controls table (from 03 §3), quick start (`npm i && npm run dev`), build/deploy notes, multiplayer relay section (per §2.5), browser support, and a clear disclaimer: *fan-made original-asset project; not affiliated with or endorsed by Mojang/Microsoft; contains no Minecraft assets, code, or audio.* The product name is **ClaudeCraft** everywhere user-facing (repo, README title, window/tab title, title screen) — no "Minecraft" and no legacy "VoxelCraft" in the shipped name or branding.
5. Clean-clone test: `git clone` to a temp dir → `npm ci` → `npm run build` → preview plays. If this fails, the repo isn't done.
6. Commit everything with a sensible message; push to the GitHub remote (add remote if not configured — ask the operator for the repo URL if unknown; do not create repos unprompted).

## 5. Vercel deploy

1. Vercel auto-detects Vite: framework `vite`, build `npm run build`, output `dist/`. Only add a `vercel.json` if something needs overriding (SPA rewrites are NOT needed — single page, no client routing).
2. Import the GitHub repo in Vercel (or `npx vercel` CLI if operating that way), deploy, and open the production URL.
3. Live smoke test on the deployed URL: new world generates, pointer lock engages, audio starts after first click, save persists across a page reload, F3 shows 60 fps, and — if a relay is deployed — a second browser joins via join code over `wss://`.
4. Paste the live URL into README, commit, push (Vercel redeploys automatically).

## Done means

Clean clone builds; every checklist passes; repo is on GitHub with README + disclaimer; the game is live on a Vercel URL where a stranger with a browser can play it — and a mate with the relay URL can join them.
