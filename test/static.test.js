// Fast checks that need no browser.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const moduleSrc = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const importMap = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;

test('module script has valid syntax', () => {
  // strip static imports, then parse the rest as an async function body
  const body = moduleSrc.replace(/^import .*$/gm, '');
  assert.doesNotThrow(() => new (Object.getPrototypeOf(async function () {}).constructor)(body));
});

test('import map pins exact versions (no latest / master)', () => {
  for (const name of ['three', 'cannon-es']) {
    assert.match(importMap[name], /@\d+\.\d+\.\d+\//, `${name} is not version-pinned: ${importMap[name]}`);
  }
  assert.match(importMap['three/addons/'], /three@\d+\.\d+\.\d+\//);
});

test('every bare import has an import-map entry', () => {
  for (const m of moduleSrc.matchAll(/^import .* from '([^']+)'/gm)) {
    const spec = m[1];
    const ok = importMap[spec] || Object.keys(importMap).some(k => k.endsWith('/') && spec.startsWith(k));
    assert.ok(ok, `no import-map entry for ${spec}`);
  }
});

test('no remote textures/images that could fail and blank the scene', () => {
  assert.doesNotMatch(html, /<img[^>]+src="https?:/);
  assert.doesNotMatch(moduleSrc, /TextureLoader|\.jpg|\.png/);
});

test('WebXR is wired up: xr enabled, VRButton, local-floor, two controllers, lights', () => {
  assert.match(moduleSrc, /renderer\.xr\.enabled\s*=\s*true/);
  assert.match(moduleSrc, /VRButton\.createButton/);
  assert.match(moduleSrc, /setReferenceSpaceType\('local-floor'\)/);
  assert.match(moduleSrc, /getController\(i\)/);
  assert.match(moduleSrc, /HemisphereLight|AmbientLight/);
  assert.match(moduleSrc, /setAnimationLoop/);
});

test('object sizes are realistic (soda can 6.6x12.2 cm, softball ~9.6 cm, counter ~0.9 m)', () => {
  const num = n => +moduleSrc.match(new RegExp(`(?:const|,) ${n}\\s*=\\s*([0-9.]+)`))[1];
  assert.ok(Math.abs(num('CAN_R') * 2 - 0.066) < 0.005);
  assert.ok(Math.abs(num('CAN_H') - 0.122) < 0.01);
  assert.ok(Math.abs(num('BALL_RADIUS') * 2 - 0.096) < 0.02);
  assert.ok(num('TABLE_TOP') >= 0.8 && num('TABLE_TOP') <= 1.1);
});

test('audio is synthesised in code (no sound files to fail loading)', () => {
  assert.doesNotMatch(moduleSrc, /\.(mp3|ogg|wav)|AudioLoader|fetch\(/);
  assert.match(moduleSrc, /AudioContext/);
  assert.match(moduleSrc, /unlockAudio/);
});

test('visuals: shadows, tone mapping and environment lighting are enabled', () => {
  assert.match(moduleSrc, /shadowMap\.enabled\s*=\s*true/);
  assert.match(moduleSrc, /toneMapping/);
  assert.match(moduleSrc, /scene\.environment/);
});

test('controller UI: guide text names every button, quit is available, no sphere over the controller', () => {
  for (const word of ['TRIGGER', 'GRIP', 'Quit VR', 'Refill Balls', 'Reset Game']) assert.ok(moduleSrc.includes(word), `missing "${word}"`);
  assert.match(moduleSrc, /session\.end\(\)/);
  assert.doesNotMatch(moduleSrc, /ctrl\.add\(new THREE\.Mesh\(new THREE\.SphereGeometry/);
});

test('can sound uses inharmonic metal partials and a per-can pitch', () => {
  assert.match(moduleSrc, /CAN_PARTIALS/);
  assert.match(moduleSrc, /body\.pitch\s*=/);
});

test('storage access is guarded (private mode / blocked storage must not crash the game)', () => {
  assert.match(moduleSrc, /try \{ const v = localStorage\.getItem/);
  assert.match(moduleSrc, /try \{ localStorage\.setItem/);
});

test('celebration, leaderboard and size settings exist', () => {
  for (const name of ['celebrate', 'computePoints', 'addScore', 'importBoard', 'exportBoard', 'setRows', 'setQuality']) {
    assert.match(moduleSrc, new RegExp(`(function|const) ${name}\\b`), `missing ${name}`);
  }
  assert.match(moduleSrc, /MIN_ROWS = 3, MAX_ROWS = 6/);
});

test('help text is collapsed by default (not an always-on overlay)', () => {
  assert.match(html, /#help \{\s*display: none/);
  assert.match(html, /id="helpBtn"/);
});

// ---------------------------------------------------------------- friendly look, no direct branding

test('design: fonts are Fredoka (interface and world) and Gochi Hand (chalkboard), from Google Fonts with system fallbacks', () => {
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Fredoka:wght@400;500;600;700&family=Gochi\+Hand&display=swap/);
  assert.match(moduleSrc, /FONT_SANS = 'Fredoka, "Segoe UI"/);
  assert.match(moduleSrc, /WORLD_HAND = '"Gochi Hand"/);
  assert.match(html, /--font: Fredoka/);
  assert.doesNotMatch(html, /Lexend|IBM\+Plex|IBM Plex/);
});

test('design: warm palette (cream, wood, coral, sunshine) and no leftover dark-navy interface colours', () => {
  for (const hex of ['#fff6e6', '#a8673a', '#ff6f61', '#ffc93c', '#3a2f2b']) assert.ok(html.toLowerCase().includes(hex), `missing ${hex}`);
  for (const old of ['#0b1c28', '#13293a', '#1f4260', '#24405a', '#7d98ae', '#ff9d55']) assert.ok(!html.toLowerCase().includes(old), `old navy-theme colour ${old} is still in the page`);
});

test('design: canvas text goes through the font helpers (no bare sans-serif font strings)', () => {
  assert.doesNotMatch(moduleSrc, /\d+px sans-serif/);
});

test('design: friendly shapes (pill buttons, rounded cards) and flat colour (no gradients in the page css)', () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /\.btn \{[^}]*border-radius: 999px/);
  assert.doesNotMatch(css, /gradient\(/);
  assert.match(moduleSrc, /roundRect\(g, 3, 3, PANEL_W - 6, PANEL_H - 6, 30\)/); // rounded cream card
});

test('no direct branding: no logo, brand name, lockup files or credit plate anywhere', () => {
  assert.doesNotMatch(html, /three ?vertex|threevertex|lockup/i);
  assert.doesNotMatch(html, /assets\//);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'assets')), 'assets/ (logo files) should not exist');
  assert.doesNotMatch(moduleSrc, /credit_plate|new Image\(\)/);
});

test('"You win" appears once: only the banner says it (not the chalkboard, not the score card)', () => {
  assert.doesNotMatch(moduleSrc, /chalk\([^)]*you win/i);
  assert.doesNotMatch(moduleSrc, /title\('You win/i);
  assert.match(moduleSrc, /title\('Your score'\)/);
  assert.strictEqual((moduleSrc.match(/fillText\('YOU WIN!'/g) || []).length, 1);
});

test('scene: the booth is ported from the Claude Design scene, merged for performance, with real colliders', () => {
  assert.match(moduleSrc, /mergeGeometries/);
  assert.match(moduleSrc, /function mergeStatic/);
  assert.match(moduleSrc, /function booth\(/);
  assert.match(moduleSrc, /addCollider\(3\.18, COUNTER_TOP/);       // counter
  assert.match(moduleSrc, /addCollider\(3\.0, 2\.4, 0\.06/);         // back wall
  assert.match(moduleSrc, /woodBox\(1\.2, TABLE_TOP, 0\.6, 0, TABLE_TOP \/ 2, -4\)/);   // can table keeps its real place
  assert.match(moduleSrc, /woodBox\(0\.8, PEDESTAL_TOP, 0\.4, 0, PEDESTAL_TOP \/ 2, -0\.8\)/); // ball stand too
  assert.doesNotMatch(moduleSrc, /CircleGeometry\(90/);               // no giant ground triangles (depth-sorting artefacts)
});

test('VR keyboard: on-screen keys exist for A-Z, 0-9 and DEL', () => {
  assert.match(moduleSrc, /\['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'\]/);
  assert.match(moduleSrc, /id: 'key_DEL'/);
  assert.match(moduleSrc, /function typeKey/);
});

test('touch support: touch handlers, no page zoom/scroll, on-screen keys, coarse-pointer defaults', () => {
  for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) assert.match(moduleSrc, new RegExp(`addEventListener\\('${ev}'`));
  assert.match(html, /user-scalable=no/);
  assert.match(html, /touch-action: none/);
  assert.match(html, /@media \(pointer: coarse\)/);
  assert.match(moduleSrc, /const onScreenKeys = /);
});
