// Keyboard/mouse capture + per-tick snapshots (01 §15.1, 03 §3).
// B11 adds two platform layers on the SAME surface: a polled gamepad layer and
// a coarse-pointer touch layer. Both synthesize the exact state the keyboard/
// mouse handlers produce (key codes in `keys`/`pressedBuf`, button bits, look
// counts in mouseDX/DY) — no consumer had to change, no second input shape.
import { KEYBINDS } from '../constants.js';

// 03 §3 — one wheel detent's worth of pixel delta. Chrome reports deltaMode 0
// (≈100 px per notch), Firefox deltaMode 1 (3 lines). Normalising to pixels and
// stepping per NOTCH makes one detent = one slot on a notched mouse while
// stopping a trackpad's 60–120 Hz pixel stream from walking the whole hotbar.
const NOTCH = 40;
const LINE_PX = 16, PAGE_PX = 100;

// ---------------- B11: gamepad mapping ----------------
// B11/U24 contract: every action the pad can express has an index here, or an
// EXPLICIT null (the phase's spec lets unmapped actions be declared rather than
// silently missing). Indices are standard-mapping GamepadButton positions.
// Deviations from 19-BUILDOUT §4 (per the B11 build brief): LT(6) is USE, not
// sneak — sneak stays keyboard-only this wave; Start(9) pauses by faking a
// pointer-lock loss (pause-on-Esc in this game IS the lock-lost event — the
// browser owns Esc while locked, so the pad replays that same path).
export const GAMEPAD_DEADZONE = 0.15;
export const GAMEPAD_MAPPING = {
  axes: { moveX: 0, moveY: 1, lookX: 2, lookY: 3 },
  buttons: {
    jump: 0,        // A — hold = Space held; press edge = Space pressed (fly toggle)
    drop: 1,        // B — press = KeyQ pressed edge
    inventory: 3,   // Y — press = KeyE edge via onKeyEdge (the E handler lives in main.js)
    attack: 7,      // RT — hold = mouseLeft; press edge = leftPressed
    use: 6,         // LT — hold = mouseRight; press edge = rightPressed
    hotbarPrev: 14, // dpad ← — one wheel detent down
    hotbarNext: 15, // dpad → — one wheel detent up
    dpadUp: 12,     // explicitly unmapped this wave
    dpadDown: 13,   // explicitly unmapped this wave
    sneak: null,    // explicit null — no pad binding (brief maps LT to use)
    sprint: null,   // explicit null — pad can sprint-stop but not start (no double-tap W)
    pause: 9,       // Start — replays the lock-lost pause path
  },
};
// counts/frame at full stick tilt, consumed by Game.applyMouseLook (0.15°/count
// at sensitivity 1.0) → ≈115°/s full tilt at 60 fps. Applied per rAF poll, not
// per tick, so look stays frame-smooth like the mouse path.
const PAD_LOOK_SPEED = 16;
const PAD_TRIGGER_THRESHOLD = 0.5;   // RT/LT are analog; anything past half is "down"

// ---------------- B11: touch constants ----------------
const TOUCH_LOOK_SCALE = 1.5;   // right-half drag px → mouse-count multiplier
const JOY_RADIUS = 56;          // stick travel radius in px

// Deadzone + squared response curve (B11): 15% band is zero, output = sign·mag².
function padCurve(v) {
  const a = Math.abs(v);
  if (a < GAMEPAD_DEADZONE) return 0;
  const n = (a - GAMEPAD_DEADZONE) / (1 - GAMEPAD_DEADZONE);
  return Math.sign(v) * n * n;
}
const clamp1 = v => Math.max(-1, Math.min(1, v));

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ControlLeft',
  'KeyE', 'KeyQ', 'KeyF', 'F3', 'F4', 'F5',
  // 14 §8 — chat + player list keys are preventDefault'd while locked so Tab
  // doesn't move focus and T/Enter don't scroll.
  'KeyT', 'Tab', 'Enter',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
]);

// 14 §8.3 — buttons bitfield sent as 0 while the chat input is focused.
const NEUTRAL_INPUT_FRAME = {
  forward: 0, strafe: 0, jump: false, sneak: false, sprintKey: false,
  mouseLeft: false, mouseRight: false, leftPressed: false, rightPressed: false,
  middlePressed: false, pressed: new Set(), wheel: 0, hotbar: -1, shift: false, ctrl: false,
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressedBuf = new Set();     // keydown edges since last snapshot
    this.releasedBuf = new Set();
    this.mouseDX = 0;                // consumed per frame by the camera
    this.mouseDY = 0;
    this.buttons = [false, false, false];
    this.pressBuf = [false, false, false];   // button-down edges since last snapshot
    this.wheelAccum = 0;             // pixel-normalised wheel delta, stepped per NOTCH
    this.locked = false;
    this.onKeyEdge = null;           // immediate hook (F3/F4/Esc handling in Game)

    document.addEventListener('keydown', e => {
      if (e.repeat) { if (GAME_KEYS.has(e.code) && this.locked) e.preventDefault(); return; }
      // 01 §15.1 — only latch world edges while the pointer is LOCKED. PAUSED is
      // the one unlocked state Game.frame() does not tick (Game.js §3), so it
      // never drains these buffers: without the gate every key pressed and every
      // click made on the pause/options sheet replayed into the world on resume
      // (F4 flipped the game mode, a Resume click swung at whatever was ahead).
      if (this.locked) {
        this.keys.add(e.code);
        this.pressedBuf.add(e.code);
      }
      // 01 §15.1 — "all game keys preventDefault() while pointer-locked". F3/F4
      // stay unconditional (both are bound to toggles that work unlocked, and
      // Firefox's F3 quick-find would open); F5 must NOT be, or the browser's
      // reload shortcut is dead for the page's whole lifetime (03 §3: F5 is a
      // reserved no-op).
      if (e.code === 'F3' || e.code === 'F4') e.preventDefault();
      else if (GAME_KEYS.has(e.code) && this.locked) e.preventDefault();
      this.onKeyEdge?.(e.code, e);
    });
    document.addEventListener('keyup', e => {
      this.keys.delete(e.code);
      this.releasedBuf.add(e.code);
    });
    document.addEventListener('mousemove', e => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    // Same lock gate as keydown: a click on the pause menu, the options sheet or
    // the title screen must never become a world press. `mouseup` stays
    // unconditional so a button released outside the lock still clears `buttons`.
    document.addEventListener('mousedown', e => {
      if (e.button <= 2 && this.locked) {
        this.buttons[e.button] = true;
        this.pressBuf[e.button] = true;
      }
    });
    document.addEventListener('mouseup', e => {
      if (e.button <= 2) this.buttons[e.button] = false;
    });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', e => {
      if (!this.locked) return;
      e.preventDefault();
      this.wheelAccum += e.deltaY * (e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1);
      // The clamp is what stops trackpad momentum banking a dozen steps into one
      // tick: at most one detent's worth ever survives to the next snapshot.
      this.wheelAccum = Math.max(-NOTCH, Math.min(NOTCH, this.wheelAccum));
    }, { passive: false });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.clearMovement();
      this.onLockChange?.(this.locked);
    });
    // requestLock() cannot tell a silently-refused lock from a granted one where
    // requestPointerLock() returns undefined (it resolves on the next microtask
    // either way). Without this listener a refusal left STATE.PLAYING with no
    // lock: frozen camera, live cursor, and no path back to PAUSED.
    document.addEventListener('pointerlockerror', () => {
      this.locked = false;
      this.clearMovement();
      this.onLockChange?.(false);
    });

    // -------- B11: gamepad + touch layers --------
    // Gamepad: per-frame rAF poll (look deltas must land per FRAME — Game feeds
    // mouseDX/DY through applyMouseLook once per frame; per-tick injection would
    // look choppy). Buttons hold/press state is read later by snapshot().
    this.padPrev = null;          // last poll's button-down flags (edge detection)
    this.padMoveX = 0;            // analog move axes after deadzone+curve, [-1,1]
    this.padMoveY = 0;
    this._padRAF = 0;
    const padLoop = () => { this.pollGamepad(); this._padRAF = requestAnimationFrame(padLoop); };
    this._padRAF = requestAnimationFrame(padLoop);

    // Touch: activate on coarse pointers immediately; on hybrid devices a real
    // mouse/keyboard event (B11 §3 "fired last") deactivates it, and the next
    // touchstart re-arms. One-time fallback: some phones report a fine pointer
    // until the first touch, so the first trusted touchstart enables too.
    this.touchMode = false;
    this._touchDOM = null;        // root element of the touch controls
    this._canvasHandlers = [];    // [event, fn, opts] registered on the canvas in touch mode
    this._touchArmed = matchMedia('(pointer: coarse)').matches;
    this._joyId = null;           // touch identifier driving the stick
    this._lookId = null;          // touch identifier dragging the look side
    this._joyVec = { x: 0, y: 0 };
    this._touchPlaceMode = false; // tap on the right half mines; toggle flips to place
    if (this._touchArmed) this.enableTouch();
    window.addEventListener('touchstart', () => {
      if (!this._touchArmed) { this._touchArmed = true; this.enableTouch(); }
    }, { passive: true });
    // Hybrid-device guard: the last real input wins. A trusted mouse
    // pointerdown or keydown tears the layer down (canvas taps preventDefault
    // their touchstarts, so they never spawn these events).
    document.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && this.touchMode) this.disableTouch();
    });
    document.addEventListener('keydown', e => {
      if (e.isTrusted && this.touchMode) this.disableTouch();
    });
  }

  // -------- B11: gamepad --------
  pollGamepad() {
    if (document.hidden || this.suppressed) { this.padPrev = null; return; }
    const pads = navigator.getGamepads?.() ?? [];
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (!pad) { this.padPrev = null; this.padMoveX = this.padMoveY = 0; return; }
    const M = GAMEPAD_MAPPING;
    const btn = i => {
      const b = pad.buttons[i];
      return !!b && (b.pressed || b.value > PAD_TRIGGER_THRESHOLD);
    };

    // Move axes: squared curve + deadzone (B11). Y axis INVERTED here (stick up
    // = -1 raw) so +padMoveY already means "forward" for the snapshot merge.
    this.padMoveY = -padCurve(pad.axes[M.axes.moveY] ?? 0);
    this.padMoveX = padCurve(pad.axes[M.axes.moveX] ?? 0);

    // Look: straight into the mouse delta path — the exact surface and
    // sensitivity the mouse uses (Game.applyMouseLook consumes per frame).
    const lx = padCurve(pad.axes[M.axes.lookX] ?? 0);
    const ly = padCurve(pad.axes[M.axes.lookY] ?? 0);
    if (lx || ly) { this.mouseDX += lx * PAD_LOOK_SPEED; this.mouseDY += ly * PAD_LOOK_SPEED; }

    // Buttons → the same key/button state the real devices produce.
    const prev = this.padPrev ?? {};
    const edge = i => btn(i) && !prev[i];
    const B = M.buttons;
    // Button writes are CHANGE-GATED on the pad's own previous state: an idle
    // connected pad polls every frame, and unconditional writes would clobber a
    // mouse-held button (mouse mining died the instant a pad was plugged in).
    const padJump = B.jump !== null && btn(B.jump);
    if (padJump) {
      if (!this.keys.has('Space')) this.pressedBuf.add('Space');   // press edge for fly toggle
      this.keys.add('Space');
    } else if (B.jump !== null && prev[B.jump]) this.keys.delete('Space');
    if (B.attack !== null && !!prev[B.attack] !== btn(B.attack)) {
      this.buttons[0] = btn(B.attack);
      if (btn(B.attack)) this.pressBuf[0] = true;
    }
    if (B.use !== null && !!prev[B.use] !== btn(B.use)) {
      this.buttons[2] = btn(B.use);
      if (btn(B.use)) this.pressBuf[2] = true;
    }
    if (B.drop !== null && edge(B.drop)) this.pressedBuf.add('KeyQ');
    // Inventory is NOT a frame consumer — main.js's onKeyEdge owns KeyE, so the
    // pad replays that hook directly (same surface, no side door).
    if (B.inventory !== null && edge(B.inventory)) this.onKeyEdge?.('KeyE');
    if (B.hotbarPrev !== null && edge(B.hotbarPrev)) this.wheelAccum = -NOTCH;
    if (B.hotbarNext !== null && edge(B.hotbarNext)) this.wheelAccum = NOTCH;
    // Pause: this game pauses when pointer lock is LOST (the browser owns Esc
    // while locked) — replay that exact signal rather than inventing a new one.
    if (B.pause !== null && edge(B.pause)) this.onLockChange?.(false);
    // Sneak/sprint/middle are explicitly null this wave — see GAMEPAD_MAPPING.
    this.padPrev = pad.buttons.map(b => b.pressed || b.value > PAD_TRIGGER_THRESHOLD);
  }

  // -------- B11: touch layer --------
  // Fixed-position controls appended to document.body (hud.js is off-limits this
  // wave); all state lands on the shared surface: joystick → move axes, drag →
  // mouseDX/DY, taps → button bits/edges, buttons → key codes / onKeyEdge.
  enableTouch() {
    if (this.touchMode) return;
    this.touchMode = true;
    // Game.applyMouseLook DISCARDS deltas unless input.locked — pointer lock is
    // bypassed on touch, so we present as locked (requestLock below is the
    // matching no-op gate; no real lock is ever requested).
    this.locked = true;

    const root = document.createElement('div');
    root.id = 'cc-touch';
    const css = 'position:fixed;z-index:500;user-select:none;-webkit-user-select:none;' +
      'touch-action:none;background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.35);' +
      'color:#fff;font:600 13px/1 monospace;display:flex;align-items:center;justify-content:center;' +
      'border-radius:12px;pointer-events:auto;';
    root.style.cssText = 'position:fixed;inset:0;z-index:499;pointer-events:none;touch-action:none;';

    // Left-half joystick: fixed base bottom-left, floating knob.
    const joyBase = document.createElement('div');
    joyBase.style.cssText = css + `left:24px;bottom:24px;width:${JOY_RADIUS * 2 + 20}px;height:${JOY_RADIUS * 2 + 20}px;border-radius:50%;`;
    const joyKnob = document.createElement('div');
    joyKnob.style.cssText = `position:absolute;left:50%;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;background:rgba(255,255,255,0.55);`;
    joyBase.appendChild(joyKnob);

    // Right-side buttons: JUMP (hold), SNEAK (toggle), MINE/PLACE (toggle), INV, PAUSE.
    const mkBtn = (label, bottom, extra = '') => {
      const b = document.createElement('div');
      b.textContent = label;
      b.style.cssText = css + `right:16px;bottom:${bottom}px;width:76px;height:52px;` + extra;
      root.appendChild(b);
      return b;
    };
    const btnJump = mkBtn('JUMP', 100);
    const btnSneak = mkBtn('SNEAK', 164);
    const btnMode = mkBtn('MINE', 24);
    const btnInv = mkBtn('INV', 164, 'right:104px;');
    const btnPause = mkBtn('PAUSE', 24, 'right:104px;');

    root.appendChild(joyBase);
    document.body.appendChild(root);
    this._touchDOM = root;
    this.canvas.style.touchAction = 'none';
    joyBase.style.pointerEvents = btnJump.style.pointerEvents = 'auto';

    const stickTo = t => {
      const r = joyBase.getBoundingClientRect();
      const dx = t.clientX - (r.left + r.width / 2);
      const dy = t.clientY - (r.top + r.height / 2);
      // vector clamped to the ring, then a squared response curve (same feel as
      // the pad: fine control near centre, full speed at the rim)
      const nx = dx / JOY_RADIUS, ny = dy / JOY_RADIUS;
      const len = Math.hypot(nx, ny) || 1;
      const c = Math.min(1, len);
      let vx = nx / len * c, vy = ny / len * c;
      const m = Math.hypot(vx, vy);
      if (m > 0) { vx *= m; vy *= m; }
      joyKnob.style.transform = `translate(${vx * JOY_RADIUS}px,${vy * JOY_RADIUS}px)`;
      // +Y is DOWN in screen space; the snapshot merge negates it into forward
      this._joyVec.x = vx;
      this._joyVec.y = vy;
    };

    joyBase.addEventListener('touchstart', e => {
      e.preventDefault();
      const t = e.changedTouches[0];
      this._joyId = t.identifier; stickTo(t);
    }, { passive: false });
    joyBase.addEventListener('touchmove', e => {
      e.preventDefault();
      for (const t of e.changedTouches) if (t.identifier === this._joyId) stickTo(t);
    }, { passive: false });
    const joyEnd = e => {
      for (const t of e.changedTouches) if (t.identifier === this._joyId) {
        this._joyId = null; this._joyVec.x = this._joyVec.y = 0;
        joyKnob.style.transform = '';
      }
    };
    joyBase.addEventListener('touchend', joyEnd);
    joyBase.addEventListener('touchcancel', joyEnd);

    // Canvas: LEFT half feeds the stick (touches outside the base clamp onto it,
    // "push-direction" style), RIGHT half = drag-look + hold-to-mine. Both
    // halves preventDefault: an unprevented touch spawns a synthetic mousedown,
    // which the hybrid-device guard would read as "real mouse fired last" and
    // tear the whole touch layer down.
    this._canvasHandlers = [
      ['touchstart', e => {
        if (e.target !== this.canvas) return;
        e.preventDefault();
        for (const t of e.changedTouches) {
          if (t.clientX < innerWidth / 2) {
            if (this._joyId === null) { this._joyId = t.identifier; stickTo(t); }
          } else if (this._lookId === null) {
            this._lookId = t.identifier;
            this._lookLast = { x: t.clientX, y: t.clientY, mode: this._touchPlaceMode };
            // hold-to-mine (or place) while the finger is down — MC PE style
            this.buttons[this._touchPlaceMode ? 2 : 0] = true;
            this.pressBuf[this._touchPlaceMode ? 2 : 0] = true;
          }
        }
      }, false],
      ['touchmove', e => {
        e.preventDefault();
        for (const t of e.changedTouches) {
          if (t.identifier !== this._lookId) continue;
          const l = this._lookLast;
          const dx = t.clientX - l.x, dy = t.clientY - l.y;
          l.x = t.clientX; l.y = t.clientY;
          l.moved += Math.abs(dx) + Math.abs(dy);
          this.mouseDX += dx * TOUCH_LOOK_SCALE;
          this.mouseDY += dy * TOUCH_LOOK_SCALE;
        }
      }, { passive: false }],
      ['touchend', e => {
        e.preventDefault();
        for (const t of e.changedTouches) {
          if (t.identifier !== this._lookId) continue;
          // the hold is over either way — a tap already fired its edge at start
          this.buttons[this._lookLast.mode ? 2 : 0] = false;
          this._lookId = null;
        }
      }, false],
    ];
    for (const [ev, fn, opt] of this._canvasHandlers) this.canvas.addEventListener(ev, fn, opt);

    const bind = (el, down, up) => {
      el.addEventListener('touchstart', e => { e.preventDefault(); down(); }, { passive: false });
      if (up) { el.addEventListener('touchend', e => { e.preventDefault(); up(); }); el.addEventListener('touchcancel', up); }
    };
    // JUMP: hold = Space held (same as holding the key)
    bind(btnJump, () => { this.keys.add('Space'); this.pressedBuf.add('Space'); }, () => this.keys.delete('Space'));
    // SNEAK: a TOGGLE (sustainable on touch) driving the ShiftLeft key state
    bind(btnSneak, () => {
      const on = !this.keys.has(KEYBINDS.sneak);
      if (on) this.keys.add(KEYBINDS.sneak); else this.keys.delete(KEYBINDS.sneak);
      btnSneak.style.background = on ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.35)';
    });
    // MINE/PLACE: flips what a right-half tap does
    bind(btnMode, () => {
      this._touchPlaceMode = !this._touchPlaceMode;
      btnMode.textContent = this._touchPlaceMode ? 'PLACE' : 'MINE';
    });
    // INV: KeyE edge via the shared onKeyEdge hook (same path as gamepad Y)
    bind(btnInv, () => this.onKeyEdge?.('KeyE'));
    // PAUSE: replay the lock-lost signal (the game's only pause path)
    bind(btnPause, () => this.onLockChange?.(false));
  }

  disableTouch() {
    if (!this.touchMode) return;
    this.touchMode = false;
    this._touchDOM?.remove();
    this._touchDOM = null;
    for (const [ev, fn, opt] of this._canvasHandlers) this.canvas.removeEventListener(ev, fn, opt);
    this._canvasHandlers = [];
    this.canvas.style.touchAction = '';
    this._joyVec.x = this._joyVec.y = 0;
    // back to the honest locked=false: deltas gate, pause-on-lock-loss resumes
    this.locked = false;
    this.clearMovement();
  }

  // B11 — touch mode bypasses pointer lock entirely: callers (Resume, respawn,
  // container-close) get a truthful "ready to play" without a lock round-trip.
  async requestLock() {
    if (this.touchMode) return true;
    try {
      await this.canvas.requestPointerLock({ unadjustedMovement: true });
      return true;
    } catch {
      try { await this.canvas.requestPointerLock(); return true; }
      catch { return false; }
    }
  }

  clearMovement() {
    this.keys.clear();
    this.buttons[0] = this.buttons[1] = this.buttons[2] = false;
    // Drain the pending EDGES too. snapshot() is the only other drain and it is
    // never reached while PAUSED (Game.frame does not tick that state), so
    // anything latched at the moment the lock dropped would otherwise replay
    // into the world on resume.
    this.pressedBuf.clear();
    this.releasedBuf.clear();
    this.pressBuf[0] = this.pressBuf[1] = this.pressBuf[2] = false;
    this.wheelAccum = 0;
  }

  // Latched immutable frame struct, read once per game tick (01 §3 step 1)
  snapshot() {
    // 14 §8.3 — while chat is focused, movement/actions are suppressed (the player
    // stands still and blinks). Still drain the edge buffers so they don't back up.
    if (this.suppressed) {
      this.pressedBuf.clear(); this.releasedBuf.clear();
      this.pressBuf[0] = this.pressBuf[1] = this.pressBuf[2] = false; this.wheelAccum = 0;
      return NEUTRAL_INPUT_FRAME;
    }
    const k = this.keys;
    // One slot per full detent; the remainder is dropped rather than carried, so
    // a 100 px notch cannot drift a phantom second step in later.
    let wheel = 0;
    if (this.wheelAccum >= NOTCH) wheel = 1;
    else if (this.wheelAccum <= -NOTCH) wheel = -1;
    if (wheel) this.wheelAccum = 0;
    const frame = {
      forward: (k.has(KEYBINDS.forward) ? 1 : 0) - (k.has(KEYBINDS.back) ? 1 : 0),
      strafe: (k.has(KEYBINDS.right) ? 1 : 0) - (k.has(KEYBINDS.left) ? 1 : 0),
      jump: k.has(KEYBINDS.jump),
      sneak: k.has(KEYBINDS.sneak),
      sprintKey: k.has(KEYBINDS.sprint),
      mouseLeft: this.buttons[0],
      mouseRight: this.buttons[2],
      leftPressed: this.pressBuf[0],
      rightPressed: this.pressBuf[2],
      middlePressed: this.pressBuf[1],
      pressed: new Set(this.pressedBuf),
      wheel,
      hotbar: -1,
      shift: k.has('ShiftLeft') || k.has('ShiftRight'),
      // 18 §5.4 — the Ctrl+pick-block modifier. Distinct from `sprintKey` even
      // though both read ControlLeft today: rebinding sprint must not silently
      // rebind pick-block's modifier.
      ctrl: k.has('ControlLeft') || k.has('ControlRight'),
    };
    for (let i = 0; i < 9; i++) {
      if (this.pressedBuf.has(KEYBINDS.hotbar[i])) frame.hotbar = i;
    }
    // B11 — merge the analog layers into the SAME fields (no forked shape):
    // keyboard still contributes its ±1, pad/joystick add their curve-shaped
    // axis values; the sum is clamped so diagonal keyboard+stick can't exceed 1.
    // Consumers already treat these numerically (Player: strafe*0.98, sprint
    // gate forward>=0.8), so full stick tilt sprints like a held W.
    const mx = clamp1(this.padMoveX + this._joyVec.x);
    const my = clamp1(this.padMoveY - this._joyVec.y);
    if (mx) frame.strafe = clamp1(frame.strafe + mx);
    if (my) frame.forward = clamp1(frame.forward + my);
    this.pressedBuf.clear();
    this.releasedBuf.clear();
    this.pressBuf[0] = this.pressBuf[1] = this.pressBuf[2] = false;
    return frame;
  }

  consumeMouseDelta() {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0; this.mouseDY = 0;
    return d;
  }

}
