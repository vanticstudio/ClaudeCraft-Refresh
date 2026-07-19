# `public/theme-music/` — background music

Drop audio files in here and they play. That's the whole thing — no config, no
registration step, no hardcoded track list. The player adapts to however many
tracks are present (16-AUDIO §4A.1) and shuffles them at runtime.

```
cp ~/Music/*.mp3 public/theme-music/
npm run dev
```

Supported: `.mp3` `.ogg` `.oga` `.m4a` `.aac` `.wav` `.opus` `.flac` `.webm`

The dev server watches this folder, so adding or removing tracks while it is
running regenerates the playlist and reloads the page — no restart. Press start
and the menu plays them, shuffled, with 1.5 s fade-in / 0.8 s fade-out and a
10–20 s gap between tracks. `npm run build` copies whatever is here into
`dist/theme-music/` unchanged.

The repo ships this folder **empty** — it is a clean slate for whatever you want
to listen to.

## Where files can live

| Folder | In git? | Plays in dev | Plays in a build |
| --- | --- | --- | --- |
| `public/theme-music/` | yes | ✅ | ✅ |
| `CC-assets/CC-sounds/` | no — gitignored | ✅ | ✗ not copied to `dist/` |

`CC-assets/CC-sounds/` is a local scratch folder. Use it for music you want to
hear while working but don't want to add to the repo. Create it, drop files in,
restart the dev server. Since Vite never copies it into `dist/`, listing it in a
build would just produce URLs that 404 — so builds read `public/theme-music/`
only.

Nothing else in the audio system loads files: SFX and the in-game generative
composer (16-AUDIO §4) are 100 % synthesized at runtime, so an empty folder is a
fully supported configuration — the menu is simply silent, with no 404s and no
console errors.

## A note for contributors

Music you add locally is your own business. Please just don't **commit** tracks
to this repo that you don't hold the rights to — it's a shared, public tree, and
audio pushed here lands in everyone's clone.

## Options → Theme music

- **Off** — no theme layer; the synth composer plays in-game.
- **Menu only** *(default)* — theme on the title screen, synth composer in-game.
- **Menu + gameplay** — theme layer both places. With no tracks present this
  falls back to the synth composer rather than going silent.
