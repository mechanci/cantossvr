# Tests

```
npm install
npx playwright install chromium   # once (or set CHROMIUM_PATH)
npm test
```

three.js and cannon-es are served from `node_modules` during the browser tests, so they run offline.

- `test/static.test.js` – syntax, pinned import-map versions, no remote textures, WebXR wiring.
- `test/e2e.test.js` – headless Chromium: no console errors, canvas renders, cans stay on the table,
  balls rest on the pedestal, thrown balls hit cans, grab/throw (trigger and grip), respawn, Reset.

WebXR itself can't run headless; the tests simulate controller `selectstart/selectend/squeezestart/squeezeend`
events. Entering VR on a real headset still needs a manual check (needs HTTPS or localhost).
