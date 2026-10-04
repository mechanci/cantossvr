# Tests

```
npm install
npx playwright install chromium   # once
npm test
```

- `test/static.test.js` – fast checks (syntax, pinned CDN versions, no remote textures, component order, A-Frame/physics compatibility).
- `test/e2e.test.js` – headless-browser checks: no console errors, cans stay on the table, balls rest on the pedestal, thrown balls hit cans, grab/throw works, Reset works.

Offline: `npm pack aframe-physics-system@4.0.1`, extract it, and run with
`PHYSICS_JS=<path>/package/dist/aframe-physics-system.min.js npm test`.
Set `CHROMIUM_PATH` to use a specific Chromium binary.

Note: `aframe-physics-system` 4.0.1 needs A-Frame 1.0.x (it uses `THREE.Geometry`/`THREE.Math`,
removed in newer three.js). Don't bump A-Frame without replacing the physics library.
