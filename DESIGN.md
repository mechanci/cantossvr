# Design

The interface follows the **three vertex design system** (`threevertexco/design-system`, tokens v0.1.0, dark theme).
The game comes first: the brand styles the interface only, and the 3D world keeps its own carnival look.

## Brand-derived (interface)

| Where | What |
| --- | --- |
| Page buttons, `?` help card, Enter VR button | flat navy surfaces, hairlines, one orange primary, 4px corners, Lexend + IBM Plex Mono |
| In-VR menu, controls, leaderboard, result card | flat deep navy `#0b1c28`, hairline `#7d98ae`, orange only for the primary action / the one figure that matters, mono labels, node dot before titles, lockup in the menu footer |
| Controller hint cards | raised navy `#13293a`, orange mono key names, node dots |
| In-world scoreboard | navy with mono labels while playing; one flat orange field when you win |
| Win banner | flat orange with a navy outline (no gradient) |
| Loading screen, favicon, theme colour | navy ground, orange node dot, `threevertex-mark-on-navy.svg` |

Brand rules applied: flat colour, one accent, no gradients, no emoji, no red (states use words and the ▲ / ▼ glyphs),
square corners (4px ceiling), hairlines instead of shadows, the logo only from the supplied files.

## Game-world (deliberately not branded)

The striped booth, sky, grass, cans, softball, confetti colours and fireworks keep their carnival colours.
Only the lettering on the booth sign and the cans uses Lexend.

## Fonts

Lexend and IBM Plex Mono load from Google Fonts (`display=swap`). Canvas-drawn text (the in-VR panels, scoreboard,
banner) is drawn with fallback fonts first and redrawn when the web fonts arrive. Without network access everything
falls back to Segoe UI / Calibri / Consolas and stays usable.

## Updating

The token values live in `index.html` (`:root { --tv-* }` for page CSS and the `TV` object for canvas drawing).
When the design system changes, update those two blocks to match `project/tokens.json`. `assets/` holds copies of
`threevertex-lockup-orange.svg` and `threevertex-mark-on-navy.svg` from the design system's Logos group.
