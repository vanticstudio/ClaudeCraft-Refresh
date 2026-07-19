// End crystal entity (13-BOSSES §3): non-living, fixed, one-hit destructible.
// Sits on End pillars healing the dragon; player-placed ones respawn the dragon.
import * as THREE from 'three';
import { Entity } from './Entity.js';

// Scratch basis for the §3.3 beam orientation (one shared instance; the beam is
// re-oriented every frame and never keeps a reference to it).
const BEAM_BASIS = new THREE.Matrix4();

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
    // §7.11 — a pillar crystal spawned by the respawn ritual is invulnerable
    // until the dragon appears at t=604.
    this.ritualInvuln = !!opts.ritualInvuln;
  }

  // AABB = base Entity: 2x2x2 box centered horizontally on pos.x/z, feet at pos.y.

  tick() {
    this.baseTick();
    // No movement, no gravity, not pushable — fully stationary.
  }

  // §3: ANY damage instance destroys the crystal in one hit.
  hurt(amount, source = 'generic', opts = {}) {
    if (this.dead) return false;
    if (this.ritualInvuln) return false;              // §7.11
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

    // §3.3 — the healing / ritual beam: a camera-facing quad from the crystal
    // center to beamTarget. Additive, and depth-tested OFF because the beam is
    // explicitly never occluded by terrain (Java-verified).
    const beam = new THREE.Mesh(
      new THREE.PlaneGeometry(0.25, 1).translate(0, 0.5, 0),
      new THREE.MeshBasicMaterial({
        color: 0xf7eaff, transparent: true, opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthTest: false, depthWrite: false,
        side: THREE.DoubleSide, fog: false,
      }),
    );
    beam.position.y = 1.0;                 // starts at the crystal center
    beam.frustumCulled = false;            // its geometry is 1 m; it stretches per frame
    beam.renderOrder = 3;
    beam.visible = false;
    group.add(beam);

    this.outer = outer;
    this.inner = inner;
    this.beam = beam;
    return group;
  }

  updateRender(alpha) {
    super.updateRender(alpha);
    if (!this.object3d) return;
    if (this.outer) this.outer.rotation.y += 0.035;
    if (this.inner) this.inner.rotation.y -= 0.035;
    this.object3d.position.y += 0.1 * Math.sin(this.age / 15);   // bob
    this.updateBeam();
  }

  // §3.3 — stretch/orient the beam quad toward beamTarget (world space). The
  // parent group carries no rotation, so world and local axes coincide.
  updateBeam() {
    const b = this.beam;
    if (!b) return;
    const t = this.beamTarget;
    if (!t) { b.visible = false; return; }
    const o = this.object3d;
    const ox = o.position.x, oy = o.position.y + b.position.y, oz = o.position.z;
    let dx = t.x - ox, dy = t.y - oy, dz = t.z - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) { b.visible = false; return; }
    dx /= len; dy /= len; dz /= len;

    // width axis = beam × view, so the quad always faces the camera edge-on.
    const cam = this.world.game?.camera;
    let rx = 1, ry = 0, rz = 0;
    if (cam) {
      const vx = cam.position.x - ox, vy = cam.position.y - oy, vz = cam.position.z - oz;
      rx = dy * vz - dz * vy; ry = dz * vx - dx * vz; rz = dx * vy - dy * vx;
    }
    let rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-4) { rx = 1; ry = 0; rz = 0; rl = 1; }
    rx /= rl; ry /= rl; rz /= rl;
    const nx = ry * dz - rz * dy, ny = rz * dx - rx * dz, nz = rx * dy - ry * dx;
    BEAM_BASIS.set(rx, dx, nx, 0, ry, dy, ny, 0, rz, dz, nz, 0, 0, 0, 0, 1);
    b.quaternion.setFromRotationMatrix(BEAM_BASIS);
    b.scale.set(1, len, 1);
    b.visible = true;
  }

  serialize() {
    return {
      type: 'end_crystal',
      pos: [this.pos.x, this.pos.y, this.pos.z],
      hasBase: this.hasBase,
      playerPlaced: this.playerPlaced,
      ritualInvuln: this.ritualInvuln,
    };
  }

  static deserialize(world, rec) {
    // rec.pos is already centered (x/z end in .5). The ctor re-centers via
    // Math.floor(x)+0.5, which is idempotent for an already-centered coord.
    const e = new EndCrystal(world, rec.pos[0], rec.pos[1], rec.pos[2], {
      hasBase: rec.hasBase,
      playerPlaced: rec.playerPlaced,
      ritualInvuln: rec.ritualInvuln,
    });
    return e;
  }
}
