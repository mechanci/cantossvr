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
