// 14-MULTIPLAYER §8.2/§8.3 — chat overlay (bottom-left, fading lines) + the Tab
// player-list panel. Text is inserted via textContent only (no HTML injection).
import { STATE } from '../constants.js';

export class Chat {
  constructor(game, overlayEl) {
    this.game = game;
    this.open = false;
    this.lines = [];                 // {el, text, timer}
    this._build(overlayEl);
  }

  _build(overlayEl) {
    const root = document.createElement('div');
    root.id = 'chat-root';
    root.innerHTML = `
      <div id="chat-log"></div>
      <input id="chat-input" maxlength="200" spellcheck="false" autocomplete="off" hidden>
      <div id="player-list" hidden><div id="player-list-rows"></div></div>
      <div id="sleep-line" hidden></div>`;
    overlayEl.appendChild(root);
    this.log = root.querySelector('#chat-log');
    this.input = root.querySelector('#chat-input');
    this.listEl = root.querySelector('#player-list');
    this.listRows = root.querySelector('#player-list-rows');
    this.sleepLine = root.querySelector('#sleep-line');

    // typing must not leak into movement (§8.3) — suppress game input while focused
    this.input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); this._submit(); }
      else if (e.code === 'Escape') { e.preventDefault(); this.close(); }
    });
    this.input.addEventListener('blur', () => { if (this.open) this.close(); });
  }

  openInput() {
    if (this.open || !this.game.net) return;
    this.open = true;
    this.game.input.suppressed = true;      // buttons bitfield → 0 (§8.3)
    this.input.hidden = false;
    this.input.value = '';
    this.input.focus();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.game.input.suppressed = false;
    this.input.hidden = true;
    this.input.blur();
    // keep pointer lock (chat kept it); re-request if it was lost
    if (this.game.state === STATE.PLAYING && !this.game.input.locked) this.game.input.requestLock();
  }

  _submit() {
    const text = this.input.value.trim().slice(0, 200);
    this.input.value = '';
    if (text) this.game.net?.sendChat?.(text);
    this.close();
  }

  addLine(from, text) {
    const line = from == null ? String(text) : `<${from}> ${text}`;
    this._push(line, from == null);
  }
  addSystem(text) { this._push(String(text), true); }

  _push(text, system) {
    const el = document.createElement('div');
    el.className = 'chat-line' + (system ? ' sys' : '');
    el.textContent = text;
    this.log.appendChild(el);
    const rec = { el, timer: 0 };
    this.lines.push(rec);
    while (this.lines.length > 10) { const old = this.lines.shift(); old.el.remove(); }
    // fade after 10 s (opacity transition; history retained)
    rec.fade = setTimeout(() => { el.classList.add('faded'); }, 10000);
  }

  setSleepStatus(sleeping, total) {
    if (!total || sleeping <= 0) { this.sleepLine.hidden = true; return; }
    this.sleepLine.hidden = false;
    this.sleepLine.textContent = `${sleeping}/${total} players sleeping`;
    if (sleeping >= total) this.sleepLine.textContent = 'Everyone is asleep…';
  }

  // Tab player list (§8.2)
  showList(show) {
    this.listEl.hidden = !show;
    if (show) this.refresh();
  }

  refresh() {
    const net = this.game.net;
    if (!net) { this.listRows.innerHTML = ''; return; }
    const rows = [];
    const push = (name, ping, dim, host, self) => rows.push({ name, ping, dim, host, self });
    if (net.isHost) {
      push(this.game.localPlayerName, 0, this.game.world?.activeDim ?? 0, true, true);
      for (const c of net.clients.values()) if (c.player) push(c.name, Math.round(c.rtt || 0), c.dim ?? 0, false, false);
    } else {
      for (const [id, p] of net.players) push(p.name, Math.round(p.rttMs || 0), p.dim ?? 0, p.slot === 0, id === net.playerId);
    }
    const dimName = d => d === 1 ? 'Nether' : d === 2 ? 'End' : 'Overworld';
    this.listRows.innerHTML = '';
    for (const r of rows) {
      const div = document.createElement('div');
      div.className = 'pl-row';
      const n = document.createElement('span'); n.className = 'pl-name'; n.textContent = (r.host ? '⌂ ' : '') + r.name + (r.self ? ' (you)' : '');
      const p = document.createElement('span'); p.className = 'pl-ping'; p.textContent = r.host ? '—' : `${r.ping} ms`;
      const d = document.createElement('span'); d.className = 'pl-dim'; d.textContent = dimName(r.dim);
      div.append(n, d, p);
      this.listRows.appendChild(div);
    }
  }
}
