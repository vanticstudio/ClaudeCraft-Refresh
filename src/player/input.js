// Keyboard/mouse capture + per-tick snapshots (01 §15.1, 03 §3).
import { KEYBINDS } from '../constants.js';

// 03 §3 — one wheel detent's worth of pixel delta. Chrome reports deltaMode 0
// (≈100 px per notch), Firefox deltaMode 1 (3 lines). Normalising to pixels and
// stepping per NOTCH makes one detent = one slot on a notched mouse while
// stopping a trackpad's 60–120 Hz pixel stream from walking the whole hotbar.
const NOTCH = 40;
const LINE_PX = 16, PAGE_PX = 100;

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

  async requestLock() {
    try {
      await this.canvas.requestPointerLock({ unadjustedMovement: true });
      return true;
    } catch {
      try { await this.canvas.requestPointerLock(); return true; }
      catch { return false; }
    }
  }
}
