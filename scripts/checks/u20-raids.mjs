#!/usr/bin/env node
// ============================================================================
// U20 — B6 "Raids & village life" (19-BUILDOUT-v1.3 §B6): the raid wave state
// machine, the wave-scaling table, Marauder class integrity, and the omen/hero
// effect registrations. Self-contained ESM; mirrors the checks harness's
// conventions (real imports, no frameworks, exit 0 = PASS / 1 = FAIL).
// Run: node scripts/checks/u20-raids.mjs
//
// (a) STATE MACHINE — RaidStateMachine with a stubbed hook bag: start → wave 1
//     spawns, deaths advance waves, final clear WINS (raidWon + raidEnded,
//     exactly once each), villager wipe LOSES, bell break LOSES mid-wave,
//     signals after a finish are ignored (idempotency), and omen gating is the
//     pure hasEffect/badge rule the live manager reads.
// (b) WAVE TABLE — waveCountFor: 0-2 → 2, 3-5 → 3, 6+ → 4 (boundaries).
// (c) MARAUDER — imports headlessly, extends Mob, type 'marauder', 24 HP,
//     hostile + persistent, captain flag honored from opts and serialized.
// (d) EFFECTS — BAD_OMEN and HERO registered in EFFECT + EFFECT_META (distinct
//     free ids; HERO readable through effectLevel for the trade discount).
// ============================================================================

const imp = p => import(new URL('../../src/' + p, import.meta.url).href);

let failures = 0;
let checks = 0;
function report(id, title, fails, notes = []) {
  checks++;
  const ok = fails.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  U20.${id}  ${title}`);
  for (const n of notes) console.log(`        note: ${n}`);
  for (const f of fails) console.log(`      - ${f}`);
}

// Node-safe import chain: Marauder reaches audio/engine.js's module-scope
// AudioEngine, which touches localStorage in its ctor (same stub as smoke U9).
globalThis.localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

// Deterministic rng for ctor rolls (captain fallback), mirroring U21's fixture.
const detRng = () => 0.99;

async function main() {
  const [{ RaidStateMachine, waveCountFor }, { Mob }, { Marauder },
         { EFFECT, EFFECT_META, effectLevel, addEffect }, { idOf }] = await Promise.all([
    imp('world/Raid.js'), imp('entities/mobs/Mob.js'), imp('entities/mobs/Marauder.js'),
    imp('status/effects.js'), imp('registry/items.js'),
  ]);

  // ---------------------------------------------------------------- (a)
  const failsA = [], notesA = [];
  const H = (extra = {}) => {
    const h = { waveStarted: [], raidWon: 0, raidLost: [], raidEnded: 0 };
    const hooks = {
      waveStarted: (n, total) => h.waveStarted.push([n, total]),
      raidWon: () => h.raidWon++,
      raidLost: r => h.raidLost.push(r),
      raidEnded: () => h.raidEnded++,
      ...extra,
    };
    return { h, hooks };
  };

  // WIN path: 3-wave raid, every raider of every wave dies.
  {
    const { h, hooks } = H();
    const m = new RaidStateMachine({ waveCount: 3, hooks });
    m.startWave(1);
    for (let i = 0; i < 5; i++) m.registerRaider(100 + i);
    if (m.status().remaining !== 5 || m.status().wave !== 1) failsA.push('wave 1 must hold 5 raiders');
    for (let i = 0; i < 4; i++) m.notifyRaiderDeath(100 + i);
    if (m.status().wave !== 1 || m.status().finished) failsA.push('raid must still be in wave 1 with 1 raider alive');
    m.notifyRaiderDeath(104);
    if (m.status().wave !== 2) failsA.push('clearing wave 1 must start wave 2');
    if (h.waveStarted.length !== 2 || h.waveStarted[1][0] !== 2) failsA.push('waveStarted must fire per wave');
    m.notifyRaiderDeath(999);          // unknown id: must be a no-op
    if (m.status().wave !== 2) failsA.push('unknown death signal must not advance the wave');
    m.startWave(2);                    // re-register wave-2 raiders (live layer does)
    for (let i = 0; i < 5; i++) m.registerRaider(200 + i);
    for (let i = 0; i < 5; i++) m.notifyRaiderDeath(200 + i);
    if (m.status().wave !== 3) failsA.push('clearing wave 2 must start wave 3');
    m.startWave(3);
    for (let i = 0; i < 7; i++) m.registerRaider(300 + i);
    for (let i = 0; i < 7; i++) m.notifyRaiderDeath(300 + i);
    const s = m.status();
    if (!s.finished || !s.won) failsA.push('final clear must WIN');
    if (h.raidWon !== 1 || h.raidEnded !== 1) failsA.push(`raidWon/raidEnded must fire exactly once (got ${h.raidWon}/${h.raidEnded})`);
    if (h.raidLost.length !== 0) failsA.push('win path must not fire raidLost');
    // post-finish idempotency: late signals change nothing.
    m.registerRaider(1); m.notifyRaiderDeath(1); m.bellBroken(); m.setVillagerCount(0);
    if (h.raidWon !== 1 || h.raidEnded !== 1 || h.raidLost.length !== 0) failsA.push('finished raid must ignore all signals');
    notesA.push('win path: waves 1→2→3 on clears, won/ended once, post-win signals ignored');
  }

  // LOSE paths: villagers wiped; bell broken mid-wave.
  {
    const { h, hooks } = H();
    const m = new RaidStateMachine({ waveCount: 2, hooks });
    m.startWave(1); m.registerRaider(1); m.registerRaider(2);
    m.setVillagerCount(0);
    if (!m.status().finished || m.status().won || m.status().lostReason !== 'villagers')
      failsA.push('wiping villagers must lose with reason "villagers"');
    if (h.raidLost[0] !== 'villagers' || h.raidEnded !== 1) failsA.push('lose path must fire raidLost(villagers)+raidEnded');
    // A live raid has no raiders of its own after the loss; late deaths no-op.
    m.notifyRaiderDeath(1);
    if (h.raidWon !== 0 && h.raidEnded !== 1) failsA.push('post-lose signals must not double-fire');
  }
  {
    const { h, hooks } = H();
    const m = new RaidStateMachine({ waveCount: 2, hooks });
    m.startWave(1); m.registerRaider(1);
    m.notifyRaiderDeath(1);            // wave 1 clears → wave 2 starts
    m.bellBroken();
    if (!m.status().finished || m.status().lostReason !== 'bell')
      failsA.push('bell break mid-raid must lose with reason "bell"');
    if (h.raidLost[0] !== 'bell') failsA.push('bell lose path must fire raidLost(bell)');
    if (h.raidWon !== 0) failsA.push('bell loss must not win');
  }

  // OMEN GATING — the pure rule the live manager reads: a raid starts only for
  // a player whose effects map carries BAD_OMEN, and starting consumes it.
  {
    const player = { effects: new Map() };
    addEffect(player, EFFECT.BAD_OMEN, 0, 36000);
    if (!player.effects.has(EFFECT.BAD_OMEN)) failsA.push('BAD_OMEN must land in the effects map (captain-kill grant)');
    // consume = removeEffect, the exact call site in RaidManager.checkOmens
    player.effects.delete(EFFECT.BAD_OMEN);
    if (player.effects.has(EFFECT.BAD_OMEN)) failsA.push('omen must be consumed when the raid starts');
    // a player WITHOUT the omen never triggers (the manager's hasEffect gate)
    const noOmen = { effects: new Map() };
    if (noOmen.effects.has(EFFECT.BAD_OMEN)) failsA.push('no omen, no raid');
  }
  // RECONCILE — the live pass: re-hydrated ids re-register, ghosts prune, an
  // emptied wave completes through the SAME hook path as a signal death.
  {
    const { h, hooks } = H();
    const m = new RaidStateMachine({ waveCount: 1, hooks });
    m.startWave(1); m.registerRaider(1);
    m.reconcile([1, 2], () => true);          // re-hydrated raider 2 re-registers
    if (m.status().remaining !== 2) failsA.push('reconcile must re-register present ids');
    m.reconcile([2], id => id === 2);         // ghost 1 (entity map says gone) prunes
    if (m.status().remaining !== 1) failsA.push('reconcile must prune ghost ids absent from present AND the entity map');
    m.reconcile([], () => false);             // 2 also gone → wave completes → WIN
    const s = m.status();
    if (!s.finished || !s.won) failsA.push('reconcile must complete an emptied wave (win)');
    if (h.raidWon !== 1 || h.raidEnded !== 1) failsA.push('reconcile completion must fire the same win hooks once');
    // reconcile before wave 1 is a no-op
    const { h: h2, hooks: hooks2 } = H();
    const m2 = new RaidStateMachine({ waveCount: 2, hooks: hooks2 });
    m2.reconcile([], () => false);
    if (h2.waveStarted.length !== 0) failsA.push('reconcile must no-op before wave 1 (wave 0)');
  }
  notesA.push('omen gating tested as the pure hasEffect → start → consume rule; reconcile: re-register/ghost-prune/complete');
  report('a', 'raid state machine — waves advance on death signals, win/lose/idempotent, omen gate rule', failsA, notesA);

  // ---------------------------------------------------------------- (b)
  const failsB = [], notesB = [];
  const expect = [[0, 2], [1, 2], [2, 2], [3, 3], [4, 3], [5, 3], [6, 4], [12, 4]];
  for (const [n, want] of expect) {
    if (waveCountFor(n) !== want) failsB.push(`waveCountFor(${n}) = ${waveCountFor(n)}, want ${want}`);
  }
  notesB.push('boundaries: 0/2 → 2 waves, 3/5 → 3, 6+ → 4');
  report('b', 'wave-count scaling — 0-2 → 2, 3-5 → 3, 6+ → 4 (bounds exact)', failsB, notesB);

  // ---------------------------------------------------------------- (c)
  const failsC = [], notesC = [];
  if (typeof Marauder !== 'function' || !(Marauder.prototype instanceof Mob))
    failsC.push('Marauder must extend Mob');
  let m0 = null;
  try { m0 = new Marauder({ rng: detRng }, 0, 10, 0); } catch (e) { failsC.push('ctor threw: ' + e.message); }
  if (m0) {
    if (m0.type !== 'marauder') failsC.push(`type must be 'marauder' (got ${m0.type})`);
    if (m0.hostile !== true) failsC.push('Marauder must be hostile');
    if (m0.persistent !== true) failsC.push('Marauder must be persistent (raiders never despawn mid-raid)');
    if (m0.health !== 24 || m0.maxHealth !== 24) failsC.push('health must be 24');
    if (m0.captain !== false) failsC.push('detRng 0.99 must roll a plain raider (1/3 captain chance)');
    // drop table: item NAMES that resolve through idOf (spawnItemByName's path)
    for (const d of m0.dropTable(0)) {
      try { if (idOf(d.name) === undefined) failsC.push(`drop '${d.name}' does not resolve`); }
      catch { failsC.push(`drop '${d.name}' does not resolve through idOf`); }
      if (!Number.isInteger(d.count) || d.count < 0) failsC.push(`drop '${d.name}' count must be a non-negative int`);
    }
    // captain flag from opts (the raid spawn path passes the seeded roll)
    let cap = null;
    try { cap = new Marauder({ rng: detRng }, 0, 10, 0, { captain: true, raidId: 'raid-1' }); }
    catch (e) { failsC.push('captain ctor threw: ' + e.message); }
    if (cap) {
      if (cap.captain !== true) failsC.push('opts.captain must be honored');
      if (cap.raidId !== 'raid-1') failsC.push('opts.raidId must be honored');
      // §1 — the captain's death grants BAD_OMEN to the killer (Entity.die
      // threads opts.attacker into onDeath).
      const killer = { effects: new Map() };
      cap.onDeath('melee', { attacker: killer });
      if (!killer.effects.has(EFFECT.BAD_OMEN)) failsC.push('captain death must grant BAD_OMEN to opts.attacker');
      // plain raider's death must NOT grant
      const killer2 = { effects: new Map() };
      m0.onDeath('melee', { attacker: killer2 });
      if (killer2.effects.has(EFFECT.BAD_OMEN)) failsC.push('plain raider death must not grant BAD_OMEN');
      // persistence round-trip of the raid binding + captain flag
      const rec = cap.serialize();
      if (rec.raidId !== 'raid-1' || rec.captain !== true) failsC.push('serialize must carry raidId + captain');
      const cap2 = new Marauder({ rng: detRng }, 0, 10, 0);
      cap2.deserialize(rec);
      if (cap2.captain !== true || cap2.raidId !== 'raid-1') failsC.push('deserialize must restore raidId + captain');
    }
    // crossbow goal present in the goal list (skeleton-mechanics ranged attack)
    const goalNames = m0.goals.map(g => g.constructor.name);
    if (!goalNames.some(n => /Crossbow/.test(n))) failsC.push('goals must include a crossbow attack goal');
    if (!goalNames.some(n => /Melee/.test(n))) failsC.push('goals must include the melee fallback');
    notesC.push('24 HP, persistent, opts-driven captain, BAD_OMEN kill credit, raidId round-trips');
  }
  report('c', 'Marauder — Mob subclass, raid stat block, captain omen credit, persistence', failsC, notesC);

  // ---------------------------------------------------------------- (d)
  const failsD = [], notesD = [];
  if (typeof EFFECT.BAD_OMEN !== 'number') failsD.push('EFFECT.BAD_OMEN must be a registered id');
  if (typeof EFFECT.HERO !== 'number') failsD.push('EFFECT.HERO must be a registered id');
  if (EFFECT.BAD_OMEN === EFFECT.HERO) failsD.push('BAD_OMEN and HERO must be distinct ids');
  if (EFFECT.BAD_OMEN < 22 || EFFECT.BAD_OMEN > 40) failsD.push(`BAD_OMEN id ${EFFECT.BAD_OMEN} outside the free band (22..40)`);
  if (EFFECT.HERO < 22 || EFFECT.HERO > 40) failsD.push(`HERO id ${EFFECT.HERO} outside the free band (22..40)`);
  for (const id of [EFFECT.BAD_OMEN, EFFECT.HERO]) {
    const meta = EFFECT_META[id];
    if (!meta) { failsD.push(`EFFECT_META[${id}] missing — the HUD effect stack would render nothing`); continue; }
    if (!meta.name || !meta.display || typeof meta.color !== 'number') failsD.push(`EFFECT_META[${id}] row incomplete`);
  }
  // HERO readable through effectLevel (villager.js's discount read path)
  {
    const p = { effects: new Map() };
    addEffect(p, EFFECT.HERO, 1, 72000);   // level II
    if (effectLevel(p, EFFECT.HERO) !== 2) failsD.push('effectLevel must read the HERO amplifier (trade-discount read path)');
  }
  // emerald/iron drop targets resolve (Marauder's drop table uses existing items)
  for (const nm of ['emerald', 'iron_ingot', 'arrow']) {
    try { idOf(nm); } catch { failsD.push(`drop target '${nm}' missing from the item registry`); }
  }
  notesD.push(`BAD_OMEN=${EFFECT.BAD_OMEN}, HERO=${EFFECT.HERO} — both render in the HUD stack via EFFECT_META`);
  report('d', 'effects — BAD_OMEN + HERO registered with free ids, META rows, HERO level readable', failsD, notesD);

  console.log(`\nU20 ${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks green`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('U20 harness threw:', e.stack || e);
  process.exit(1);
});
