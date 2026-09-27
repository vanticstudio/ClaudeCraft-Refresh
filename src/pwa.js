// B11 — PWA glue: service-worker registration + beforeinstallprompt capture.
//
// Registered from menus.js's scope (main.js is off-limits this wave — documented
// deviation in the phase report): Menus calls setupPWA() once; this module owns
// the whole lifecycle and just reports via the callbacks. Everything degrades
// silently in dev — a service worker caching src modules would break HMR — so
// registration is PROD-only (import.meta.env.PROD).
//
// The install hint is surfaced quietly per 19-BUILDOUT §1: a small text button
// on the title screen, dismissible (it hides once installed or after the
// prompt runs).

let deferredPrompt = null;   // the captured beforeinstallprompt event
let setDone = false;

export function setupPWA({ onInstallAvailable, onInstalled } = {}) {
  if (setDone) return;
  setDone = true;

  // beforeinstallprompt can fire BEFORE the SW even registers — capture on
  // window regardless of registration outcome.
  window.addEventListener('beforeinstallprompt', e => {
    // The default mini-infobar is exactly the noisy install UX the spec bans;
    // swallow it and surface our quiet title-screen button instead.
    e.preventDefault();
    deferredPrompt = e;
    onInstallAvailable?.();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    onInstalled?.();
  });

  if (!('serviceWorker' in navigator)) return;
  // import.meta.env is Vite-injected; guard for non-Vite contexts (tests parse
  // this file, they never evaluate it).
  const prod = import.meta.env?.PROD;
  if (!prod) return;
  // sw.js sits at the site root (public/ → dist/); base './' makes this safe
  // under sub-path deploys too.
  navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './' })
    .catch(() => {
      // A blocked/failed worker must never break boot — the game runs fine
      // uninstalled, it just won't play offline.
    });
}

/**
 * Run the browser's install prompt with the captured event.
 * @returns {Promise<boolean>} true when the user accepted the install.
 */
export async function promptInstall() {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;    // one-shot: the UA will not re-fire until criteria re-match
  return outcome === 'accepted';
}