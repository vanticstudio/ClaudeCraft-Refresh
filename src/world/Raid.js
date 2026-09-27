// B6 §2–§5 — the Raid system (19-BUILDOUT §B6). Two layers:
//
// 1. RaidStateMachine (PURE) — wave accounting with injected hooks. No world,
//    no game, no mobs: waveCountFor()/waveSize() + the class are unit-testable
//    headlessly (scripts/checks/u20-raids.mjs). The machine only counts
//    signals — registerRaider / notifyRaiderDeath / setVillagerCount /
//    bellBroken — and reports status (wave, alive, won/lost). ALL side effects
//    ride the injected hooks:
//      hooks.waveStarted(n, total)    → n-th wave begins (1-based): spawn + bar
//      hooks.raidWon()                → last wave cleared (HERO + XP burst)
//      hooks.raidLost(reason)         → all villagers dead | bell broken | dry
//      hooks.raidEnded()              → teardown (record + bar), always fires
//   plus resumeWave(n, ids) for the reload path (re-adopt without re-spawning).
// 2. RaidManager (LIVE) — the game-facing side: per-village tick at 20 TPS,
//    spawning Marauders on standable cells around the bell perimeter (ai.js's
//    standable — the B7 grid), boss-bar sync through game.bossBarAdd/Set/Remove
//    (the SAME component the dragon/wither use, purple), and persistence.
//
// PERSISTENCE (§4): the raid record lives ON the villageMeta object as
// meta.raid (plain JSON: { active, wave, waveCount, waveSizeOf, spawnAttempts,
// ended }). villageMeta round-trips with the anchor chunk's save record
// (saveManager.serializeChunk writes it verbatim, Game.onChunkHydrated
// re-registers it in Game.villages), so a raid survives reload mid-wave —
// machineFor re-adopts the record and re-registers re-hydrated raiders by
// raidId. The machines themselves are runtime-only (never on meta).
//
// OMEN GATING (§1): a player with BAD_OMEN within 32 blocks of a village bell
// (scanned every 40 ticks over Game.villages) starts THAT village's raid and
// has the omen consumed. Marauder.onDeath grants BAD_OMEN on captain kills.
import { B } from '../registry/blocks.js';
import { standable } from '../entities/mobs/ai.js';
import { EFFECT, hasEffect, removeEffect } from '../status/effects.js';
import { AABB } from '../math/aabb.js';

const BELL = B.BELL;                       // 171 — village meeting point (12 §7.2)
const VILLAGE_TRIGGER_RADIUS = 32;         // §1 — bell within 32 blocks of the omen carrier
const SPAWN_RING_MIN = 12, SPAWN_RING_MAX = 24;   // §2 — "around the bell perimeter"
const RAID_BAR_ID = 'raid';                // BossBar id (same namespace as dragons')
const RAID_BAR_COLOR = '#b04ad8';          // §3 — purple
const RAID_TICK_PERIOD = 20;               // 1 s machine cadence inside tickRaids
const OMEN_CHECK_PERIOD = 40;              // omen scan cadence (2 s)

// §2 — waves scale by ADULT villager count: 0-2 → 2, 3-5 → 3, 6+ → 4.
export function waveCountFor(adultVillagers) {
  return adultVillagers <= 2 ? 2 : adultVillagers <= 5 ? 3 : 4;
}

// §2 — raiders per wave scale mildly with wave index (later waves hit harder),
// driven from the wave count so a 2-wave hamlet never sees a 12-raider finale.
export function waveSize(waveIndex1, waveCount) {
  return waveIndex1 === waveCount ? 4 + waveCount : 3 + waveIndex1;
}

/**
 * Pure wave-accounting machine. `hooks` are all optional (no-op default) so the
 * test harness can stub only what it asserts on.
 */
export class RaidStateMachine {
  constructor({ waveCount, hooks = {} }) {
    this.waveCount = waveCount;
    this.hooks = hooks;
    this.wave = 0;              // 1-based once the first wave starts
    this.alive = new Set();     // raider entity ids in the CURRENT wave
    this.finished = false;
    this.won = false;
    this.lostReason = null;
  }

  status() {
    return {
      wave: this.wave, waveCount: this.waveCount,
      remaining: this.alive.size, finished: this.finished,
      won: this.won, lostReason: this.lostReason,
      active: !this.finished,
    };
  }

  // ---- inputs --------------------------------------------------------------
  /** A raider spawned for the current wave. */
  registerRaider(id) {
    if (this.finished) return;
    this.alive.add(id);
  }

  /** A raider died (any cause). Completes the wave on the last death. */
  notifyRaiderDeath(id) {
    if (this.finished || !this.alive.delete(id)) return;
    if (this.alive.size === 0) this.completeWave();
  }

  /**
   * Live-pass reconciliation (the manager calls this once per raid tick).
   * Kills fire death SIGNALS; this catches everything that bypasses them:
   *  - a re-hydrated raider (chunk save round-trip mints a NEW entity id) is
   *    re-registered from `presentIds` so its death still counts;
   *  - a ghost id (chunk unloaded, or a silent void death below y=-64 that
   *    never reaches onDeath) is pruned once its entity has left the manager —
   *    `stillExists(id)` checks the manager's live map, so a raider mid-death
   *    animation still resolves and a raider merely in an unloaded chunk
   *    prunes only when the manager has dropped it.
   * An emptied wave completes through the same path as a signal death, so the
   * wave/finish hooks stay single-sourced.
   */
  reconcile(presentIds, stillExists) {
    if (this.finished || this.wave === 0) return;
    for (const id of presentIds) this.alive.add(id);
    for (const id of [...this.alive]) {
      if (!presentIds.includes(id) && !stillExists(id)) this.alive.delete(id);
    }
    if (this.alive.size === 0) this.completeWave();
  }

  // The single completion path (signal death OR reconciliation): advance the
  // wave or win the raid, exactly once — `finished` gates every entry. The
  // hooks are pure notifications of a transition the machine has ALREADY made:
  // raidWon's live handler (endRaid) re-enters, sees finished=true and only
  // runs its manager-side grant/teardown, so no hook can re-entrantly double-
  // fire or resurrect the raid.
  completeWave() {
    if (this.finished || this.wave === 0) return;
    if (this.wave > 0) this.hooks.waveCleared?.(this.wave, this.waveCount);
    if (this.wave >= this.waveCount) {
      this.finished = true; this.won = true;
      this.hooks.raidWon?.();
      this.hooks.raidEnded?.();
    } else {
      this.startWave(this.wave + 1);
    }
  }

  /** A villager of this village died. Losing ALL of them loses the raid (§2). */
  setVillagerCount(n) {
    if (this.finished || n > 0) return;
    this.lose('villagers');
  }

  /** The bell broke mid-raid — raid lost (§2 "the bell is broken mid-raid"). */
  bellBroken() {
    if (this.finished) return;
    this.lose('bell');
  }

  lose(reason) {
    if (this.finished) return;
    this.finished = true; this.won = false; this.lostReason = reason;
    this.hooks.raidLost?.(reason);
    this.hooks.raidEnded?.();
  }

  // ---- waves ---------------------------------------------------------------
  startWave(n) {
    this.wave = n;
    this.alive.clear();
    this.hooks.waveStarted?.(n, this.waveCount);
    // The machine only counts: the live layer registers spawns through
    // registerRaider. A wave whose spawns ALL fail (ocean village edge case)
    // would hang, so the live layer owns a spawn-retry guard instead of the
    // machine inventing entities it cannot verify.
  }

  /** Reload path: adopt a persisted mid-wave raid WITHOUT firing waveStarted
   *  (the wave's raiders already exist — re-hydrated from their chunk saves). */
  resumeWave(n, raiderIds) {
    this.wave = n;
    this.alive.clear();
    for (const id of raiderIds) this.alive.add(id);
  }
}

// ---------------------------------------------------------------------------
// LIVE layer — game-facing. One instance per Game (tickRaids drives all raids).
// ---------------------------------------------------------------------------
export class RaidManager {
  constructor(game) {
    this.game = game;
    this._machines = new Map();     // villageMeta → RaidStateMachine (runtime-only)
    this._metaByRaidId = new Map(); // raid id → villageMeta (death-signal routing)
  }

  /**
   * Mob.onDeath → here (Marauder carries raidId). Routes the death signal to
   * the owning village's machine. Unregistered ids are silently ignored so a
   * stale id (mob survived a raid that already ended) can never strand a wave.
   */
  notifyRaiderDeath(mob) {
    const meta = this._metaByRaidId.get(mob.raidId);
    if (!meta) return;
    this.machineFor(meta).notifyRaiderDeath(mob.id);
  }

  /** Game.tickRaids() — the per-tick entry point (runs at 20 TPS). */
  tick() {
    const g = this.game;
    if (!g.villages || g.villages.size === 0) return;
    const t = g.world.time;
    if (t % RAID_TICK_PERIOD === 0) {
      for (const meta of g.villages.values()) this.tickVillageRaid(meta);
    }
    if (t % OMEN_CHECK_PERIOD === 0) this.checkOmens();
  }

  // §1 — omen gating: an omen carrier within 32 blocks of a bell starts THAT
  // village's raid and consumes the omen. Client sessions never run this (the
  // host-authoritative rule every spawner obeys).
  checkOmens() {
    const g = this.game;
    if (g.net?.isClient) return;
    const players = (g.players?.length ? g.players : [g.player]).filter(p => p && !p.dead);
    for (const p of players) {
      if (!hasEffect(p, EFFECT.BAD_OMEN)) continue;
      for (const meta of g.villages.values()) {
        const [bx, by, bz] = meta.bellPos;
        if (!g.world.isLoaded(bx, bz)) continue;
        // Bell still standing is part of the trigger — no bell, no village.
        if (g.world.getBlock(bx, by, bz) !== BELL) continue;
        if (Math.hypot(p.pos.x - (bx + 0.5), p.pos.z - (bz + 0.5)) > VILLAGE_TRIGGER_RADIUS) continue;
        if (this.startRaid(meta, p)) removeEffect(p, EFFECT.BAD_OMEN);
        break;   // one raid per omen carrier per pass
      }
    }
  }

  /** Start (or resume) a raid on `meta`. Returns the raid record or null. */
  startRaid(meta, trigger) {
    const g = this.game;
    const [bx, by, bz] = meta.bellPos;
    if (!g.world.isLoaded(bx, bz)) return null;
    if (g.world.getBlock(bx, by, bz) !== BELL) return null;
    const adults = this.countVillagers(meta);
    if (adults <= 0) return null;                    // nobody to raid
    // Resume-vs-fresh: a persisted mid-wave record adopts its own wave count.
    const resuming = meta.raid && meta.raid.active && !meta.raid.ended;
    const rec = resuming ? meta.raid
      : { active: true, wave: 0, waveCount: waveCountFor(adults), ended: false,
          id: `raid-${bx},${by},${bz}` };
    meta.raid = rec;
    rec.ended = false;
    this._metaByRaidId.set(rec.id, meta);            // death-signal routing (notifyRaiderDeath)
    const machine = attachMachine(this, meta, rec);
    if (rec.wave === 0) machine.startWave(1);
    g.toast?.('Raid has started!');
    return rec;
  }

  // §2 wave driver: keep the bell + villager checks honest, top the wave's
  // raiders back up after unload/despawn, win on final clear. Everything
  // routes through the machine.
  tickVillageRaid(meta) {
    const g = this.game, w = g.world;
    const rec = meta.raid;
    if (!rec || !rec.active || rec.ended) return;
    const [bx, by, bz] = meta.bellPos;
    // Chunk unloaded → the village is out of sim range; skip rather than let
    // the zero reads below read as "village dead" (a §2 false loss).
    if (!w.isLoaded(bx, bz)) return;
    // §2 lose path — the bell is gone (broken, exploded, creeper'd). Checked
    // every pass: reading the block id each tick is the cheapest reliable
    // break hook that doesn't touch World.setBlock.
    if (w.getBlock(bx, by, bz) !== BELL) {
      this.machineFor(meta).bellBroken();
      return;
    }
    // §2 lose path — every villager dead. Count ADULTS (12 §11's population
    // rule); babies don't hold the raid.
    if (this.countVillagers(meta) <= 0) {
      this.machineFor(meta).setVillagerCount(0);
      return;
    }
    const machine = this.machineFor(meta);
    if (rec.wave === 0) return;                      // waiting for the omen path to start wave 1
    if (machine.finished) return;
    // Reconcile, then re-seed the wave if it emptied through a path that
    // bypassed the death signal (unload-gone / void-death pruning). The cap is
    // `spawnAttempts <= 3` per wave: an unreachable village (ocean ring) ends
    // the raid cleanly instead of spawning forever. A wave emptied by REAL
    // deaths completes inside reconcile — completeWave fires waveStarted for
    // the next wave (fresh attempts) or wins the raid, so this branch only
    // re-seeds genuinely stranded passes, never fights a finished raid.
    const present = this.collectWaveRaiders(meta);
    machine.reconcile(present.map(e => e.id), id => this.game.entities.entities.has(id));
    if (machine.finished) return;
    if (machine.alive.size === 0) {
      rec.spawnAttempts = (rec.spawnAttempts ?? 0) + 1;
      if (rec.spawnAttempts > 3) { this.endRaid(meta, machine, false, 'spawns'); return; }
      this.spawnWave(meta, rec.waveSizeOf ?? waveSize(rec.wave, rec.waveCount), machine);
    }
    this.syncBar(meta, machine);
  }

  machineFor(meta) {
    // Machines live per-raid-record on the manager (not on meta — meta must
    // stay plain-JSON so the chunk save round-trips). attachMachine rebuilds
    // after a reload: resumeWave re-adopts the persisted wave WITHOUT firing
    // waveStarted (no re-spawn). Ghost ids are filtered: a raider that died
    // before the save left no live entity, so only raiders re-hydrated with
    // raidId (checked against the entity map) re-register. WITHOUT this a
    // reload would strand the wave — the ids the old machine counted died with
    // the session, and dead ones would never produce a death signal.
    let m = this._machines.get(meta);
    if (!m) {
      m = attachMachine(this, meta, meta.raid);
      if (meta.raid && meta.raid.wave > 0 && !meta.raid.ended) {
        this._metaByRaidId.set(meta.raid.id, meta);
        const ids = this.collectWaveRaiders(meta)
          .filter(e => this.game.entities.entities.has(e.id))
          .map(e => e.id);
        m.resumeWave(meta.raid.wave, ids);
      }
    }
    return m;
  }

  collectWaveRaiders(meta) {
    const g = this.game;
    const [bx, , bz] = meta.bellPos;
    const out = [];
    const box = new AABB(bx - 64, 0, bz - 64, bx + 64, 128, bz + 64);
    for (const e of g.entities.getEntitiesInBox(box,
      e => e.type === 'marauder' && !e.dead)) {
      if (e.raidId === meta.raid?.id) out.push(e);
    }
    return out;
  }

  // §2 — spawn `n` raiders around the bell perimeter on standable cells,
  // every third a captain. Marauders are persistent raiders bound to this
  // raid id, so the wave's accounting can find them again after a reload.
  spawnWave(meta, n, machine) {
    const g = this.game, w = g.world;
    const [bx, by, bz] = meta.bellPos;
    if (!meta.raid.id) meta.raid.id = `raid-${bx},${by},${bz}`;
    let spawned = 0;
    for (let attempt = 0; attempt < n * 10 && spawned < n; attempt++) {
      const ang = w.rng() * Math.PI * 2;
      const dist = SPAWN_RING_MIN + w.rng() * (SPAWN_RING_MAX - SPAWN_RING_MIN);
      const x = Math.floor(bx + Math.cos(ang) * dist);
      const z = Math.floor(bz + Math.sin(ang) * dist);
      if (!w.isLoaded(x, z)) continue;
      // standable: solid floor + 2 clear cells (ai.js's §7 node test) — scan a
      // small y window around the bell's level like golemSpawnSpot does.
      for (let dy = -4; dy <= 4; dy++) {
        const y = by + dy;
        if (!standable(w, x, y, z, null)) continue;
        const captain = w.rng() < 1 / 3;   // §1 1-in-3 captains, seeded
        const mob = g.spawnMobAt('marauder', x + 0.5, y, z + 0.5, {
          persistent: true, captain, raidId: meta.raid.id,
        });
        if (mob) {
          machine.registerRaider(mob.id);
          spawned++;
        }
        break;
      }
    }
    return spawned;
  }

  // §2 win path — HERO (60 min) to every player near the bell + an XP burst.
  grantVictory(meta) {
    const g = this.game;
    const [bx, by, bz] = meta.bellPos;
    const box = new AABB(bx - 32, by - 16, bz - 32, bx + 32, by + 16, bz + 32);
    for (const p of g.entities.getEntitiesInBox(box, e => g.isPlayer(e) && !e.dead)) {
      g.addEffect(p, EFFECT.HERO, 0, 72000);   // 60 min §2
    }
    // XP burst — one orb shower at the bell.
    g.spawnXpOrb(bx + 0.5, by + 0.5, bz + 0.5, 100);
  }

  endRaid(meta, machine, won, reason = null) {
    // Manager-side finish handler — ALSO the raidWon/raidLost hook. The machine
    // has already made its transition by the time a hook lands here (its
    // `finished` flag is set first inside completeWave/lose), so the guard up
    // front breaks the call cycle: a hook re-entering this method no-ops, and
    // the machine can never be re-entrantly driven. The ONE caller that arrives
    // pre-transition is the dry-spawn loss (tickVillageRaid): it routes through
    // machine.lose() — the machine's single lose path — so the record
    // (rec.active/ended, via the raidEnded hook) always tears down the same way.
    if (!machine.finished) {
      machine.lose(reason ?? 'lost');
      return;
    }
    if (machine.won) this.grantVictory(meta);
    this.game.toast?.(machine.won ? 'Raid defeated!' : 'The village has fallen');
  }

  // §3 — the raid bar: wave X/Y + remaining count on the SHARED BossBar
  // component (dragon/wither namespace), purple. Fraction = wave progress.
  syncBar(meta, machine) {
    const g = this.game;
    const s = machine.status();
    const frac = s.wave / Math.max(1, s.waveCount);
    g.bossBarAdd(RAID_BAR_ID, `Raid — Wave ${s.wave}/${s.waveCount} (${s.remaining} left)`, RAID_BAR_COLOR);
    g.bossBarSet(RAID_BAR_ID, frac);
  }

  removeBar() {
    this.game.bossBarRemove?.(RAID_BAR_ID);
  }

  countVillagers(meta) {
    const g = this.game;
    const key = meta.anchor.join(',');
    const [bx, , bz] = meta.bellPos;
    // Same population rule as tickVillages' golem count (12 §11): homed OR
    // within 32 of the bell, adults only.
    return g.entities.count(e => e.type === 'villager' && !e.isBaby &&
      (e.homeVillage === key || Math.hypot(e.pos.x - bx, e.pos.z - bz) < 32));
  }
}

// Wire a fresh machine onto a raid record with the live hooks. Kept outside
// the class so the machine's hook closure stays injectable/testable. A reload
// loses this closure (machines are runtime-only), so machineFor rebuilds it and
// re-adopts rec.wave — the record is the source of truth, the machine is a view.
function attachMachine(manager, meta, rec) {
  manager._machines ??= new Map();
  // `machine` is declared before the hooks run: waveStarted fires synchronously
  // inside the ctor (startWave from startRaid) and its closure needs the ref.
  let machine = new RaidStateMachine({
    waveCount: rec.waveCount,
    hooks: {
      waveStarted: (n, total) => {
        rec.wave = n;
        rec.waveSizeOf = waveSize(n, total);
        rec.spawnAttempts = 0;
        manager.spawnWave(meta, rec.waveSizeOf, machine);
        manager.syncBar(meta, machine);
      },
      raidWon: () => manager.endRaid(meta, machine, true),
      raidLost: (reason) => manager.endRaid(meta, machine, false, reason),
      raidEnded: () => {
        rec.active = false; rec.ended = true;
        manager.removeBar();
      },
    },
  });
  manager._machines.set(meta, machine);
  return machine;
}
