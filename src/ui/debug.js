// F3 debug overlay (01 §15.3): fps, pos, chunks, light, draw calls. 4 Hz.
import { BIOME_NAMES } from '../world/gen/biomes.js';

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
    this.el.textContent =
`ClaudeCraft F3 | ${g.debug.fps} fps ${g.debug.frameMs.toFixed(1)} ms
XYZ ${p.pos.x.toFixed(2)} / ${p.pos.y.toFixed(2)} / ${p.pos.z.toFixed(2)}
chunk ${x >> 4},${z >> 4} facing ${facing} biome ${biome}
light sky ${g.world.getSkyLight(x, y, z)} block ${g.world.getBlockLight(x, y, z)} darken ${g.world.skyDarken}
chunks R${counts.requested} G${counts.generated} L${counts.lit} M${counts.meshed} F${counts.failed} | remeshQ ${g.chunkManager.remeshQueue.size}
draws ${info.render.calls} tris ${(info.render.triangles / 1000).toFixed(0)}k geoms ${info.memory.geometries}
entities ${g.entities.count()} time ${g.world.time} (day ${Math.floor(g.world.time / 24000)} ${(Math.floor((g.world.time % 24000) / 1000) + 6) % 24}:00)${heap}
weather ${g.dayNight.raining ? 'rain' : 'clear'}${g.dayNight.thundering ? '+thunder' : ''} seed ${g.world.seedString}`;
  }
}
