// 14-MULTIPLAYER §4.2/§4.3 — client-side prediction: input ring + rewind/replay
// reconciliation against host snapshots, plus render-only correction smoothing.
import { seqLE } from './protocol.js';

const RING = 128;                // 6.4 s of inputs
const RECONCILE_EPS = 0.01;      // m — below this, prediction accepted
const SNAP_DIST = 0.25;          // m — above this, hard snap (no smoothing)

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export class Predictor {
  constructor(player, tickFn) {
    this.player = player;
    this.tickFn = tickFn;                 // (player, frame) => void  (03 §4 physics)
    this.ring = new Array(RING);
    this.nextSeq = 0;
    this.renderOffset = { x: 0, y: 0, z: 0 };
    this.lastCorrectionMag = 0;
    this.corrections = 0;                 // for F3 (§13)
  }

  // Predict one client tick with the captured input; store the result in the ring.
  predict(frame) {
    const seq = this.nextSeq & 0xffff;
    frame.seq = seq;
    this.tickFn(this.player, frame);
    this.ring[seq % RING] = {
      seq, frame,
      predPos: { ...this.player.pos },
      predVel: { ...this.player.vel },
    };
    this.nextSeq = (this.nextSeq + 1) & 0xffff;
    return seq;
  }

  // Reconcile against the snapshot header's authoritative own-state (§4.2).
  reconcile(h) {
    const p = this.player;
    const r = this.ring[h.lastInputSeq % RING];
    if (!r || r.seq !== h.lastInputSeq) {           // ring overrun / post-teleport
      this.hardSnap(h.ownPos, h.ownVel);
      return;
    }
    const err = dist(r.predPos, h.ownPos);
    if (err <= RECONCILE_EPS) return;               // prediction accepted

    const renderBefore = { ...p.pos };
    p.pos.x = h.ownPos.x; p.pos.y = h.ownPos.y; p.pos.z = h.ownPos.z;   // rewind to authority
    p.vel.x = h.ownVel.x; p.vel.y = h.ownVel.y; p.vel.z = h.ownVel.z;
    p.onGround = (h.ownFlags & 1) !== 0;

    // replay every unacked input with the SAME physics against the current world
    let seq = (h.lastInputSeq + 1) & 0xffff;
    const lastSeq = (this.nextSeq - 1) & 0xffff;
    let guard = 0;
    while (seqLE(seq, lastSeq) && guard++ < RING) {
      const g = this.ring[seq % RING];
      if (g && g.seq === seq) {
        this.tickFn(p, g.frame);
        g.predPos = { ...p.pos };
        g.predVel = { ...p.vel };
      }
      seq = (seq + 1) & 0xffff;
    }

    this.corrections++;
    this.lastCorrectionMag = err;
    if (err <= SNAP_DIST) {
      // smooth: the eye keeps the pre-correction render pos, decays to truth (§4.3)
      this.renderOffset.x += renderBefore.x - p.pos.x;
      this.renderOffset.y += renderBefore.y - p.pos.y;
      this.renderOffset.z += renderBefore.z - p.pos.z;
    } else {
      this.renderOffset.x = this.renderOffset.y = this.renderOffset.z = 0;   // hard snap
    }
  }

  // §4.3 — teleport/respawn/dim-change: clear ring, restart seq, snap hard.
  hardSnap(pos, vel) {
    const p = this.player;
    p.pos.x = pos.x; p.pos.y = pos.y; p.pos.z = pos.z;
    p.prevPos.x = pos.x; p.prevPos.y = pos.y; p.prevPos.z = pos.z;
    if (vel) { p.vel.x = vel.x; p.vel.y = vel.y; p.vel.z = vel.z; }
    this.renderOffset.x = this.renderOffset.y = this.renderOffset.z = 0;
  }

  reset() {
    this.ring = new Array(RING);
    this.nextSeq = 0;
    this.renderOffset.x = this.renderOffset.y = this.renderOffset.z = 0;
  }

  // Per-frame render-offset decay (§4.3): dissolves ≤0.25 m corrections over ~150 ms.
  decayOffset() {
    const o = this.renderOffset;
    o.x *= 0.85; o.y *= 0.85; o.z *= 0.85;
    if (Math.abs(o.x) < 0.001) o.x = 0;
    if (Math.abs(o.y) < 0.001) o.y = 0;
    if (Math.abs(o.z) < 0.001) o.z = 0;
  }
}
