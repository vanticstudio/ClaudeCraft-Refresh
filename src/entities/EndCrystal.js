// End crystal entity (13-BOSSES §3): non-living, fixed, one-hit destructible.
// Sits on End pillars healing the dragon; player-placed ones respawn the dragon.
import * as THREE from 'three';
import { Entity } from './Entity.js';

export class EndCrystal extends Entity {
  // ctor takes CELL coords (integer block cell); the entity is centered on that
  // cell — x/z get +0.5, and pos.y stays the cell FLOOR (feet = bottom of the
  // 2m box), so the power-6 explosion originates at bottom-center and never
  // craters the obsidian pillar the crystal rests on.
  constructor(world, x, y, z, opts = {}) {
    super(world, Math.floor(x) + 0.5, y, Math.floor(z) + 0.5);
    this.type = 'end_crystal';
    this.width = 2.0; this.height = 2.0;              // 2x2x2 AABB centered on cell
    this.hasBase = opts.hasBase !== false;           // bedrock plate (default true)
    this.playerPlaced = !!opts.playerPlaced;
    this.beamTarget = null;                           // {x,y,z}|null — dragon sets each tick
  }

  // AABB = base Entity: 2x2x2 box centered horizontally on pos.x/z, feet at pos.y.

  tick() {
    this.baseTick();
    // No movement, no gravity, not pushable — fully stationary.
  }

  // §3: ANY damage instance destroys the crystal in one hit.
  hurt(amount, source = 'generic', opts = {}) {
    if (this.dead) return false;
    if (source === 'explosion') {
      // Chain-detonation from a neighbour: vanish SILENTLY (no secondary blast),
      // otherwise a cluster would recursively amplify into a mega-explosion.
      this.dead = true;
      return true;
    }
    this.dead = true;
    // (a) Linked crystals: the dragon reads `dead` on the crystals it tracks each
    // tick and takes the 10-HP link hit itself. beamTarget being non-null marks
    // the link; we expose nothing further — the dragon owns that bookkeeping.
    // (b) Power-6 explosion at bottom-center (pos.y = feet = cell floor).
    this.world.game?.explode?.(this.pos.x, this.pos.y, this.pos.z, 6);
    return true;
  }

  buildMesh() {
    const group = new THREE.Group();

    // Optional bedrock plate: 16x2x16 px = 1.0 x 0.125 x 1.0 m at the cell floor.
    if (this.hasBase) {
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(1.0, 0.125, 1.0),
        new THREE.MeshBasicMaterial({ color: 0x5a5a5a }),   // bedrock-ish grey
      );
      base.position.y = 0.0625;
      group.add(base);
    }

    // Both cubes centered 1.0m above the base cell floor.
    const outer = new THREE.Mesh(
      new THREE.BoxGeometry(12 / 16, 12 / 16, 12 / 16),
      new THREE.MeshBasicMaterial({ color: 0xe8d9f7, transparent: true, opacity: 0.55 }),
    );
    outer.position.y = 1.0;
    const inner = new THREE.Mesh(
      new THREE.BoxGeometry(6 / 16, 6 / 16, 6 / 16),
      new THREE.MeshBasicMaterial({ color: 0xe079fa }),
    );
    inner.position.y = 1.0;
    group.add(outer);
    group.add(inner);

    this.outer = outer;
    this.inner = inner;
    return group;
  }

  updateRender(alpha) {
    super.updateRender(alpha);
    if (!this.object3d) return;
    if (this.outer) this.outer.rotation.y += 0.035;
    if (this.inner) this.inner.rotation.y -= 0.035;
    this.object3d.position.y += 0.1 * Math.sin(this.age / 15);   // bob
  }

  serialize() {
    return {
      type: 'end_crystal',
      pos: [this.pos.x, this.pos.y, this.pos.z],
      hasBase: this.hasBase,
      playerPlaced: this.playerPlaced,
    };
  }

  static deserialize(world, rec) {
    // rec.pos is already centered (x/z end in .5). The ctor re-centers via
    // Math.floor(x)+0.5, which is idempotent for an already-centered coord.
    const e = new EndCrystal(world, rec.pos[0], rec.pos[1], rec.pos[2], {
      hasBase: rec.hasBase,
      playerPlaced: rec.playerPlaced,
    });
    return e;
  }
}
