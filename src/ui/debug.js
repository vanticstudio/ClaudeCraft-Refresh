// F3 debug overlay (01 §15.3): fps, pos, chunks, light, draw calls. 4 Hz.
import { BIOME_NAMES } from '../world/gen/biomes.js';

const DIM_NAMES = { 0: 'overworld', 1: 'nether', 2: 'the_end' };   // 11-END — F3 dim label
import { GameMode } from '../constants.js';
// CLAUDE.md §6 — the overlay must carry the redstone power under the crosshair
// and the active effect list alongside dim and the audio voice count.
import { strongPower, weakPower, wirePower } from '../redstone/power.js';
import { EFFECT_META } from '../status/effects.js';
import { B } from '../registry/blocks.js';

export class DebugOverlay {
  constructor(game, overlayEl) {
    this.game = game;
    this.el = document.createElement('div');
    this.el.id = 'debug-overlay';
    overlayEl.appendChild(this.el);
    this.visible = false;
    this.lastUpdate = 0;
  }

  toggle() {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }

  update() {
    if (!this.visible) return;
    const now = performance.now();
    if (now - this.lastUpdate < 250) return;
    this.lastUpdate = now;
    const g = this.game;
    const p = g.player;
    if (!p || !g.world) return;
    const x = Math.floor(p.pos.x), y = Math.floor(p.pos.y), z = Math.floor(p.pos.z);
    const counts = g.chunkManager.countByState();
    const info = g.renderer.info;
    const facing = ['S +Z', 'W -X', 'N -Z', 'E +X'][
      Math.round(((-p.yaw % (2 * Math.PI)) + 2 * Math.PI) / (Math.PI / 2)) % 4];
    const heap = performance.memory
      ? ` heap ${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)}MB` : '';
    const biome = BIOME_NAMES[g.world.biomeAt(x, z)] ?? '?';
    // 16 §6: read-only — this is render code and must never emitSound (§5.1).
    const a = g.audio?.debug ?? { voices: 0, drops: 0, state: 'off', budgetMs: 0 };
    const mus = g.audio?.music;
    const music = mus?.piece ? `${mus.piece.mood}#${mus.pieceIndex - 1}` : 'silent';
    this.el.textContent =
`ClaudeCraft F3 | ${g.debug.fps} fps ${g.debug.frameMs.toFixed(1)} ms
XYZ ${p.pos.x.toFixed(2)} / ${p.pos.y.toFixed(2)} / ${p.pos.z.toFixed(2)}
chunk ${x >> 4},${z >> 4} facing ${facing} biome ${biome} dim ${DIM_NAMES[g.world.activeDim] ?? g.world.activeDim}
light sky ${g.world.getSkyLight(x, y, z)} block ${g.world.getBlockLight(x, y, z)} darken ${g.world.skyDarken}
chunks R${counts.requested} G${counts.generated} L${counts.lit} M${counts.meshed} F${counts.failed} | remeshQ ${g.chunkManager.remeshQueue.size}
draws ${info.render.calls} tris ${(info.render.triangles / 1000).toFixed(0)}k geoms ${info.memory.geometries}
entities ${g.entities.count()} time ${g.world.time} (day ${Math.floor(g.world.time / 24000)} ${(Math.floor((g.world.time % 24000) / 1000) + 6) % 24}:00)${heap}
weather ${g.dayNight.raining ? 'rain' : 'clear'}${g.dayNight.thundering ? '+thunder' : ''} seed ${g.world.seedString}
gameMode ${p.gameMode === GameMode.CREATIVE ? 'creative' : 'survival'}${p.flying ? ' (flying)' : ''}
audio ${a.voices}/${g.audio?.poolSize?.() ?? 0} voices drops ${a.drops}/s ${a.state} ${a.budgetMs.toFixed(2)} ms music ${music}
${redstoneLine(g)}
effects ${effectsLine(p)}${netLine(g)}`;
  }
}

// CLAUDE.md §6 — redstone power under the crosshair + the engine's per-tick cost
// (07's ≤ 1 ms/tick budget is unobservable without this).
function redstoneLine(g) {
  const hit = g.interaction?.currentHit ?? g.interaction?.rayHit?.();
  const ms = g.debug.redstoneMs ?? 0;
  const cost = `solve ${ms.toFixed(3)} ms/tick`;
  if (!hit) return `redstone — (no target) ${cost}`;
  const { x, y, z } = hit;
  const id = g.world.getBlock(x, y, z);
  const st = g.world.getState(x, y, z);
  const wire = id === B.REDSTONE_WIRE ? ` wire ${wirePower(st)}` : '';
  return `redstone @${x},${y},${z} strong ${strongPower(g.world, x, y, z)} weak ${weakPower(g.world, x, y, z)}${wire} ${cost}`;
}

// 09-POTIONS §6 — the active effect list (name, level, remaining seconds).
function effectsLine(p) {
  if (!p.effects?.size) return 'none';
  const parts = [];
  for (const [id, e] of p.effects) {
    const meta = EFFECT_META[id];
    const lvl = (e.amplifier ?? 0) + 1;
    const secs = Math.ceil((e.duration ?? 0) / 20);
    parts.push(`${meta?.name ?? id}${lvl > 1 ? ' ' + lvl : ''} ${secs}s`);
  }
  return parts.join(', ');
}

// 14 §13 — F3 net line (role/slot, RTT, peers, snapshot size, corrections, interp).
function netLine(g) {
  const net = g.net;
  if (!net) return '';
  if (net.isHost) {
    const s = net.stats;
    return `\nnet HOST code ${net.code ?? '…'} peers ${net.clients.size} out ${(s.outBytes / 1024).toFixed(1)}KB in ${(s.inBytes / 1024).toFixed(1)}KB`;
  }
  const s = net.stats;
  return `\nnet CLIENT slot ${net.slot} rtt ${Math.round(net.rtt)}ms corr ${s.corrections} snap ${net.stats.snapSize || net._lastSnapSize || 0}B interp ${Math.round(net.interp?.interpTime ? (net.interp.newestSampleTime - net.interp.interpTime) : 0)}ms`;
}
