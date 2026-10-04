# Tests

```
npm install
npx playwright install chromium   # once (or set CHROMIUM_PATH)
npm test
```

three.js and cannon-es are served from `node_modules` during the browser tests, so they run offline. The Google Fonts
stylesheet is stubbed with an empty file, so the page falls back to system fonts in tests.

- `test/static.test.js` – syntax, pinned import-map versions, no remote textures, WebXR wiring, fonts and palette,
  no branding anywhere, "You win" shown once.
- `test/e2e.test.js` – headless Chromium: no console errors, canvas renders, cans stay on the table, balls rest on the
  pedestal, thrown balls hit cans, grab/throw (trigger and grip), ball refills, menu and VR buttons, win celebration,
  leaderboard (typed name, export/import), pyramid sizes, desktop aiming (crosshair, charge, arc preview), stray balls
  being cleared away, the VR on-screen keyboard, the booth scene (colliders, merged scenery), card colours.

WebXR itself can't run headless; the tests simulate controller `selectstart/selectend/squeezestart/squeezeend`
events. Entering VR on a real headset still needs a manual check (needs HTTPS or localhost).

## Notes

- Run the suite on its own: two runs at once starve the software renderer and cause false failures.
- The full browser run takes several minutes with software GL (around 8 minutes on a laptop).
- If Playwright's own Chromium build is missing (it wants a newer build than the one installed), point `CHROMIUM_PATH`
  at an installed one, for example
  `%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1181\chrome-win\headless_shell.exe`.
- Tests turn mouse capture off (`pointerLock: false` in the saved settings) so a click throws; one test covers the
  captured-mouse path with a stubbed `requestPointerLock`.
