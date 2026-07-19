// 14-MULTIPLAYER §8.1 — Host / Join / Connecting screens + the persistent host-code
// badge. Injects two entry buttons into the title menu and owns its own dialogs so
// the base menus template stays untouched.
import { STATE, DEFAULT_RELAY_URL } from '../constants.js';
import { getLocalPlayerName, setLocalPlayerName, sanitizeName } from '../net/identity.js';

const RELAY_KEY = 'voxelcraft.relayUrl';
const relayUrl = () => { try { return localStorage.getItem(RELAY_KEY) || DEFAULT_RELAY_URL; } catch { return DEFAULT_RELAY_URL; } };
const saveRelay = u => { try { localStorage.setItem(RELAY_KEY, u); } catch {} };

// 17-SHIP §2.4 — a page served over https can only open wss:// sockets (mixed
// content silently blocks ws://). Normalise the scheme: default it, auto-upgrade
// ws://→wss:// on https (localhost is a secure context and stays ws://), and
// surface a clear error rather than a silent failure.
function normalizeRelayUrl(raw) {
  let url = (raw || '').trim();
  if (!url) return { error: 'Enter a relay URL — run `npm run relay` locally, or paste a wss:// tunnel URL (see README).' };
  if (!/^wss?:\/\//i.test(url)) url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + url;
  const isLocal = /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
  if (location.protocol === 'https:' && /^ws:\/\//i.test(url)) {
    if (isLocal) return { error: 'This page is served over HTTPS but the relay is ws://localhost — run the game locally (npm run dev) for a localhost relay, or use a wss:// tunnel.' };
    return { url: 'wss://' + url.slice(5), warning: 'Upgraded ws:// → wss:// (this site is served over HTTPS).' };
  }
  return { url };
}

const ERR = {
  version: 'Version mismatch — host runs a different game build.',
  'relay-version': 'Relay version mismatch.',
  dupe: 'You are already connected to this world.',
  full: 'Room is full (8 players max).',
  nocode: 'No such room — check the join code.',
  badurl: 'Could not reach the relay. Is it running?',
  lost: 'Connection lost.',
  hostGone: 'The host ended the session.',
  hostEnded: 'The host ended the session.',
  'relay-lost': 'Relay connection lost — session ended.',
  'relay-full': 'The relay is full.',
};

export class NetMenus {
  constructor(game, screensEl, { onHost, onJoin } = {}) {
    this.game = game;
    this.onHost = onHost;
    this.onJoin = onJoin;
    this._build(screensEl);
  }

  _build(screensEl) {
    const root = document.createElement('div');
    root.id = 'net-screens';
    root.innerHTML = `
      <div id="screen-host" class="screen net-screen">
        <h1>Host Game</h1>
        <div class="net-hint">Multiplayer needs a WebSocket relay. Run <code>npm run relay</code> locally (default below), or expose one at a <code>wss://</code> URL — see the README.</div>
        <label>Relay URL <input id="host-relay" spellcheck="false"></label>
        <label>Your name <input id="host-name" maxlength="16" spellcheck="false"></label>
        <div class="net-row"><button id="host-go">Create World &amp; Host</button><button id="host-back">Back</button></div>
        <div id="host-msg" class="net-msg"></div>
      </div>
      <div id="screen-join" class="screen net-screen">
        <h1>Join Game</h1>
        <div class="net-hint">Enter the host's join code and the same relay URL they're using (a <code>wss://</code> URL when playing over the internet).</div>
        <label>Your name <input id="join-name" maxlength="16" spellcheck="false"></label>
        <label>Join code <input id="join-code" maxlength="6" spellcheck="false" style="text-transform:uppercase"></label>
        <label>Relay URL <input id="join-relay" spellcheck="false"></label>
        <div class="net-row"><button id="join-go">Join</button><button id="join-back">Back</button></div>
        <div id="join-msg" class="net-msg"></div>
      </div>
      <div id="screen-connecting" class="screen net-screen">
        <h1 id="conn-title">Connecting…</h1>
        <div id="conn-bar-outer"><div id="conn-bar"></div></div>
        <div id="conn-label"></div>
        <button id="conn-cancel">Cancel</button>
      </div>`;
    screensEl.appendChild(root);
    this.root = root;
    this.el = {
      host: root.querySelector('#screen-host'), join: root.querySelector('#screen-join'),
      connecting: root.querySelector('#screen-connecting'),
      hostRelay: root.querySelector('#host-relay'), hostName: root.querySelector('#host-name'),
      hostMsg: root.querySelector('#host-msg'),
      joinName: root.querySelector('#join-name'), joinCode: root.querySelector('#join-code'),
      joinRelay: root.querySelector('#join-relay'), joinMsg: root.querySelector('#join-msg'),
      connTitle: root.querySelector('#conn-title'), connBar: root.querySelector('#conn-bar'),
      connLabel: root.querySelector('#conn-label'),
    };
    const name = getLocalPlayerName() || '';
    this.el.hostRelay.value = relayUrl();
    this.el.joinRelay.value = relayUrl();
    this.el.hostName.value = name;
    this.el.joinName.value = name;

    root.querySelector('#host-back').onclick = () => this.hideAll();
    root.querySelector('#join-back').onclick = () => this.hideAll();
    root.querySelector('#conn-cancel').onclick = () => { this.game.net?.disconnect?.(); this.hideAll(); this.game.setState(STATE.TITLE); };
    root.querySelector('#host-go').onclick = () => this._doHost();
    root.querySelector('#join-go').onclick = () => this._doJoin();

    // inject Host / Join entry buttons into the title menu
    this._injectTitleButtons(screensEl);
  }

  _injectTitleButtons() {
    const menu = document.getElementById('cc-menu');
    if (!menu) return;
    const mk = (label, fn) => { const b = document.createElement('button'); b.className = 'cc-btn cc-btn-text'; b.textContent = label; b.onclick = fn; return b; };
    menu.appendChild(mk('Host Multiplayer', () => this.showHost()));
    menu.appendChild(mk('Join Multiplayer', () => this.showJoin()));
  }

  hideAll() { this.el.host.classList.remove('visible'); this.el.join.classList.remove('visible'); this.el.connecting.classList.remove('visible'); }
  showHost() { this.hideAll(); this.el.hostMsg.textContent = ''; this.el.host.classList.add('visible'); }
  showJoin() { this.hideAll(); this.el.joinMsg.textContent = ''; this.el.join.classList.add('visible'); }

  _doHost() {
    const norm = normalizeRelayUrl(this.el.hostRelay.value);
    if (norm.error) { this.el.hostMsg.textContent = norm.error; return; }
    if (norm.warning) this.el.hostMsg.textContent = norm.warning;
    const url = norm.url;
    const name = sanitizeName(this.el.hostName.value);
    saveRelay(url); setLocalPlayerName(name);
    this.game.localPlayerName = name;
    this.hideAll();
    this.onHost?.(url);
  }

  _doJoin() {
    const code = this.el.joinCode.value.trim().toUpperCase();
    if (code.length !== 6) { this.el.joinMsg.textContent = 'Enter a 6-character code.'; return; }
    const norm = normalizeRelayUrl(this.el.joinRelay.value);
    if (norm.error) { this.el.joinMsg.textContent = norm.error; return; }
    const url = norm.url;
    const name = sanitizeName(this.el.joinName.value);
    saveRelay(url); setLocalPlayerName(name);
    this.game.localPlayerName = name;
    this.showConnecting('Connecting…');
    this.onJoin?.({ url, code, name });
  }

  showConnecting(title) {
    this.hideAll();
    this.el.connTitle.textContent = title || 'Connecting…';
    this.el.connBar.style.width = '0%';
    this.el.connLabel.textContent = '';
    this.el.connecting.classList.add('visible');
  }

  setProgress(received, total) {
    const pct = Math.round(received / total * 100);
    this.el.connBar.style.width = pct + '%';
    this.el.connLabel.textContent = received >= total ? 'Entering world…' : `Receiving chunks ${received}/${total}`;
  }

  showCountdown(seconds) {
    this.showConnecting('Host is ending the session…');
    let n = seconds;
    this.el.connLabel.textContent = `Returning to title in ${n}…`;
    const iv = setInterval(() => { n--; this.el.connLabel.textContent = `Returning to title in ${n}…`; if (n <= 0) clearInterval(iv); }, 1000);
  }

  setHostCode(code) { this.game.ui?.hud?.setJoinCode?.(code); }
  onHostError(reason) {
    if (reason === 'relay-lost') { this.game.ui?.hud?.setRelayLost?.(); return; }
    this.game.ui?.toast?.(ERR[reason] || ('Host error: ' + reason));
  }

  // client connection failure → error + back to title
  onClientError(reason) {
    this.hideAll();
    this.game.net = null;
    this.game.setState(STATE.TITLE);
    this.game.ui?.toast?.(ERR[reason] || ('Connection error: ' + reason));
  }
}
