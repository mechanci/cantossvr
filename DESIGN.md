# Design

A friendly, welcoming carnival booth. The look comes from the Claude Design project "CanToss VR booth visuals"
(`CanToss Scene v3.html`), and the interface follows the same warm palette so everything feels like one place.

There is **no branding in the game** (no logo, no company name, no credit plate): it is a hobby project.

## Palette

| Role | Colour |
| --- | --- |
| Cards, panels | cream `#fff6e6`, white keys and buttons, wood-brown edge `#a8673a` |
| Text | warm dark brown `#3a2f2b`, muted `#7a6a60` |
| Accents | coral `#ff6f61`, sunshine `#ffc93c`, teal `#2fbfb0`, lilac `#a58be0` |
| Sky and page | `#d6ecf7` |

Fonts: **Fredoka** (rounded, friendly) for the interface and the signs, **Gochi Hand** for the chalkboard. Both load
from Google Fonts with `display=swap`; canvas-drawn text is redrawn when they arrive, and everything falls back to
system fonts if the network is blocked.

## The world

| Element | Notes |
| --- | --- |
| Booth, canopy, sign, counter, deck, posts | geometry from the design; "CAN TOSS" sign in Fredoka |
| Chalk scoreboard | dynamic canvas texture: cans down, time, throws (keeps its layout on a win) |
| Cans | the design's lathe can (body, coloured label band, rim) scaled to the real 6.6 x 12.2 cm |
| Sky, fog, lights | vertex-coloured sky dome, hemisphere + warm sun + cool fill, string lights |
| Scenery | neighbouring stalls, 6 tents, hay bales, ferris wheel, 40 trees |
| Ground | tessellated grass ring around a dirt patch (no giant triangles: they mis-sort against nearby objects) |

The design is a **visual** layer. Physics keeps the real-world sizes: counter top 0.9 m, can table at z = -4, ball stand
at z = -0.8, 9.6 cm ball. The booth is built around them (`BOOTH_Z`). Added colliders: the booth counter (a low throw
bounces off it) and the back wall (a miss rebounds). The aiming arc preview accounts for both.

All static scenery is merged by material (`mergeStatic`) so the whole fairground costs a handful of draw calls. The
**Low** quality setting also hides the ferris wheel and trees and turns shadows off.

## The interface

| Where | What |
| --- | --- |
| Page buttons, `?` help card, Enter VR button | chunky white and sunshine pill buttons, cream help card with keycaps |
| In-VR menu, controls, leaderboard, score card | rounded cream cards with a wood edge, coral dot before titles, sunshine primary action, big coral score |
| VR on-screen keyboard | rounded white keys, sunshine when pointed at |
| Controller hint cards | small cream cards with a wood edge |
| Desktop aiming | crosshair, charge bar, dotted arc and landing ring |
| Win | one "YOU WIN!" banner with confetti and fireworks; the score card replaces it a moment later |

Flat canvas UI (cards, banner, hints) skips tone mapping so the cream and colours stay as drawn.

## Updating

- Interface colours live in `index.html`: `:root { --cream, --ink, ... }` for the page and the `UI` object for the
  canvas-drawn cards.
- World colours live in the `mat` table in the booth section (`CORAL`, `SUNSHINE`, `TEAL`, `LILAC`, `CREAM`, wood tones).
