ClaudeCraft — Asset Pack
========================

backgrounds/  (1920x1080 PNG, opaque)
  bg-sunset.png     Primary title-screen scene (badlands sunset)
  bg-overworld.png  Bright day / grassy biome
  bg-twilight.png   Night sky, moon, pines, emerald ore
  bg-dark.png       Flat dark backdrop for menus / overlays

logos/  (transparent PNG)
  logo-primary.png  ClaudeCraft wordmark (Bungee, single line) — matches sunset
  logo-stacked.png  Stacked CLAUDE / CRAFT, pixel style
  logo-emerald.png  Stacked, cobblestone + glowing emerald

buttons/  (transparent PNG)
  btn-press-start / btn-new-game / btn-continue  (terracotta)
  btn-settings / btn-quit                        (stone)

claudecraft-title.html
  Full title screen, sunset preset, framework-free (HTML + CSS only).
  Emits a `claudecraft:start` event on click / Enter / Space — wire it
  into your game. Block colors are CSS custom properties at the top.

Fonts: Bungee + VT323 (Google Fonts). Swap freely.
