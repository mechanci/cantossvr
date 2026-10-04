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
  for (const word of ['TRIGGER', 'GRIP', 'Quit VR', 'Refill Balls', 'Reset Cans']) assert.ok(moduleSrc.includes(word), `missing "${word}"`);
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

// ---------------------------------------------------------------- three vertex design alignment

test('design: fonts load from Google Fonts (Lexend + IBM Plex Mono, display=swap) with system fallbacks', () => {
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Lexend:wght@300;400;500;600;700&family=IBM\+Plex\+Mono:wght@400;500&display=swap/);
  assert.match(moduleSrc, /FONT_SANS = 'Lexend, "Segoe UI", Calibri/);
  assert.match(moduleSrc, /FONT_MONO = '"IBM Plex Mono", Consolas/);
});

test('design: brand tokens are defined and the legacy off-brand UI colours are gone', () => {
  for (const hex of ['#ff9d55', '#0b1c28', '#13293a', '#1f4260', '#7d98ae', '#24405a', '#a3b1bd']) {
    assert.ok(html.toLowerCase().includes(hex), `missing token ${hex}`);
  }
  // old gold/grey/green/red UI colours must not creep back
  for (const old of ['#ffe9a8\'', '#e0a526', '#2d3340', '#9fb0c8', '#7dffa0', '#ff9a8a', '#ff8a7a', '#6f7d92']) {
    // #ffe9a8 is still the booth sign / bulb colour in the world, so only the UI use (quoted in canvas code) is checked
    const inUi = moduleSrc.split('\n').filter(l => l.includes(old) && !/signTex\(|bulbMat|PointLight|0xffe9a8/.test(l));
    assert.deepStrictEqual(inUi, [], `legacy colour ${old} used in UI code`);
  }
});

test('design: canvas text goes through the font helpers (no bare sans-serif font strings)', () => {
  assert.doesNotMatch(moduleSrc, /\d+px sans-serif/);
  assert.match(html, /--tv-font-sans: Lexend/);
});

test('design: UI is square-ish (radius <= 4px) and flat (no gradients in UI css)', () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  for (const m of css.matchAll(/border-radius:\s*([^;]+);/g)) {
    assert.ok(/var\(--tv-radius\)|9999px/.test(m[1]) || parseFloat(m[1]) <= 4, `radius too round: ${m[1]}`);
  }
  assert.doesNotMatch(css, /gradient\(/);
  assert.doesNotMatch(moduleSrc, /createLinearGradient\([\s\S]{0,200}YOU WIN/); // win banner is flat orange
});

test('design: logo and favicon files exist and are used', () => {
  for (const f of ['threevertex-lockup-orange.svg', 'threevertex-mark-on-navy.svg']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', f)), `missing assets/${f}`);
    assert.ok(html.includes(`assets/${f}`), `assets/${f} is not referenced`);
  }
});

test('design: the brand name is never typed in running UI text (the logo is a file)', () => {
  assert.doesNotMatch(moduleSrc, /(fillText|drawText)\([^)]*three vertex/i);
  assert.doesNotMatch(moduleSrc, /Three Vertex|ThreeVertex|3Vertex/);
});
