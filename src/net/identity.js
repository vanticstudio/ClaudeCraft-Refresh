// 14-MULTIPLAYER §2.1 — permanent per-browser identity + deterministic skin hue.
// playerId keys save records, skin hue and rejoin; playerName is display-only.
// Clients persist ONLY identity + settings in localStorage (never world data).

const ID_KEY = 'voxelcraft.playerId';
const NAME_KEY = 'voxelcraft.playerName';

function randomUUID() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch {}
  // deterministic-enough fallback for environments without crypto.randomUUID
  let s = '';
  for (let i = 0; i < 32; i++) s += ((Math.random() * 16) | 0).toString(16);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function getLocalPlayerId() {
  let id = null;
  try { id = localStorage.getItem(ID_KEY); } catch {}
  if (!id) {
    id = randomUUID();
    try { localStorage.setItem(ID_KEY, id); } catch {}
  }
  return id;
}

export function sanitizeName(name) {
  const clean = String(name ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  return clean.length ? clean : 'Player';
}

export function getLocalPlayerName() {
  let n = null;
  try { n = localStorage.getItem(NAME_KEY); } catch {}
  return n ? sanitizeName(n) : null;
}

export function setLocalPlayerName(name) {
  const clean = sanitizeName(name);
  try { localStorage.setItem(NAME_KEY, clean); } catch {}
  return clean;
}

// xmur3 string hash → deterministic 0..359 hue for the player's skin (§8.4).
export function hueFromId(id) {
  let h = 1779033703 ^ id.length;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) % 360;
}
