# `public/theme-music/` — the shipped menu-music set

Drop **original or properly-licensed** audio files here. That's it — no code
changes, no hardcoded track list. The player adapts to however many tracks are
present (16-AUDIO §4A.1) and shuffles them at runtime.

Supported: `.mp3` `.ogg` `.oga` `.m4a` `.aac` `.wav` `.opus` `.flac` `.webm`

## Dropping tracks in

**1. Copy the files here.**

```
public/theme-music/dunes.mp3
public/theme-music/mesa-night.mp3
```

**2. They play locally immediately.**

```
npm run dev
```

`predev` regenerates `src/audio/themeManifest.js` from this folder, and Vite
serves `public/` natively — press start and the menu plays them, shuffled, with
1.5 s fade-in / 0.8 s fade-out and a 10–20 s gap between tracks.

**3. To make them SHIP, declare each one in `CLEARED.json`.**

```json
{
  "tracks": [
    { "file": "dunes.mp3",      "license": "original — © Vantic Studio 2026" },
    { "file": "mesa-night.mp3", "license": "Epidemic Sound, subscription #12345" }
  ]
}
```

Then `npm run build`. Every file in this folder must appear in `CLEARED.json`
with a non-empty `license`, or the gate emits an **empty manifest** and the build
ships with the theme layer off — all of it, not just the undeclared file. The
build prints exactly what's missing.

## Why the declaration step is manual

`CLEARED.json` is the licence record. It is a human asserting provenance for each
file — the one thing tooling cannot check. A build can verify that a file *is
declared*; it cannot verify that the declaration is *true*.

This exists because the placeholder set previously here was the copyrighted C418
Minecraft soundtrack. Renaming those files and stripping their ID3 tags changed
every byte-level hash while leaving the audio frames identical — so "the file
looks different" is not evidence of anything. If you want to check a candidate
track against known audio, hash the **MPEG frames** (skipping ID3v2 at the head
and ID3v1 at the tail), not the whole file.

## No tracks? Nothing breaks.

An empty folder is a fully supported, tested configuration:

- the menu is silent, with no 404s and no console errors;
- **in-game music still plays** — 16-AUDIO §4's generative composer is
  synthesized at runtime and needs zero assets;
- all SFX are unaffected (they are 100 % synthesized, always).

This is the current shipping configuration.

## Options → Theme music

- **Off** — no theme layer; the synth composer plays in-game.
- **Menu only** *(default)* — theme on the title screen, synth composer in-game.
- **Menu + gameplay** — theme layer both places. With no cleared tracks this
  falls back to the synth composer rather than going silent.
