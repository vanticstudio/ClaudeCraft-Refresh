// Keyboard/mouse capture + per-tick snapshots (01 §15.1, 03 §3).
import { KEYBINDS } from '../constants.js';

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ControlLeft',
  'KeyE', 'KeyQ', 'F3', 'F4', 'F5',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
]);

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
    this.wheelBuf = 0;
    this.locked = false;
    this.onKeyEdge = null;           // immediate hook (F3/F4/Esc handling in Game)

    document.addEventListener('keydown', e => {
      if (e.repeat) { if (GAME_KEYS.has(e.code) && this.locked) e.preventDefault(); return; }
      this.keys.add(e.code);
      this.pressedBuf.add(e.code);
      if (e.code === 'F3' || e.code === 'F4' || e.code === 'F5') e.preventDefault();
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
    document.addEventListener('mousedown', e => {
      if (e.button <= 2) {
        this.buttons[e.button] = true;
        this.pressBuf[e.button] = true;
      }
    });
    document.addEventListener('mouseup', e => {
      if (e.button <= 2) this.buttons[e.button] = false;
    });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', e => {
      if (this.locked) { e.preventDefault(); this.wheelBuf += Math.sign(e.deltaY); }
    }, { passive: false });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.clearMovement();
      this.onLockChange?.(this.locked);
    });
  }

  clearMovement() {
    this.keys.clear();
    this.buttons[0] = this.buttons[1] = this.buttons[2] = false;
  }

  // Latched immutable frame struct, read once per game tick (01 §3 step 1)
  snapshot() {
    const k = this.keys;
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
      wheel: this.wheelBuf,
      hotbar: -1,
      shift: k.has('ShiftLeft') || k.has('ShiftRight'),
    };
    for (let i = 0; i < 9; i++) {
      if (this.pressedBuf.has(KEYBINDS.hotbar[i])) frame.hotbar = i;
    }
    this.pressedBuf.clear();
    this.releasedBuf.clear();
    this.pressBuf[0] = this.pressBuf[1] = this.pressBuf[2] = false;
    this.wheelBuf = 0;
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
