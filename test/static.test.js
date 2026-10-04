// Fast checks that need no browser: catch broken URLs/syntax before they hit a headset.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const inlineScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

test('inline script has valid syntax', () => {
  assert.doesNotThrow(() => new Function(inlineScript));
});

test('external scripts are version-pinned (no master/latest)', () => {
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(srcs.length >= 2, 'expected A-Frame + physics scripts');
  for (const s of srcs) {
    assert.match(s, /@\d+\.\d+\.\d+|\/releases\/\d+\.\d+\.\d+\//, `unpinned script: ${s}`);
  }
});

test('page loads no remote images/textures that can fail and blank the scene', () => {
  assert.doesNotMatch(html, /<img[^>]+src="https?:/);
  assert.doesNotMatch(html, /<a-sky[^>]+src=/);
});

test('scene has lights, a camera, and two hands with hand-grabber', () => {
  assert.match(html, /light="type: ambient/);
  assert.match(html, /light="type: directional/);
  assert.match(html, /\bcamera\b/);
  assert.strictEqual((html.match(/hand-grabber/g) || []).length >= 3, true); // registration + 2 hands
});

test('every dynamic/static body component used is provided by the physics system', () => {
  assert.match(html, /aframe-physics-system/);
  assert.match(html, /dynamic-body|static-body/);
});

test('A-Frame version is compatible with aframe-physics-system 4.0.1 (needs THREE.Geometry => A-Frame 1.0.x)', () => {
  const v = html.match(/aframe\.io\/releases\/(\d+)\.(\d+)\.(\d+)\/aframe/);
  assert.ok(v, 'A-Frame script not found');
  assert.ok(+v[1] === 1 && +v[2] === 0, `A-Frame ${v.slice(1).join('.')} breaks the physics system (THREE.Geometry/THREE.Math removed)`);
});

test('hand-grabber is registered before <a-scene> is parsed (otherwise the hands never get it)', () => {
  const reg = html.indexOf("registerComponent('hand-grabber'");
  assert.ok(reg > -1 && reg < html.indexOf('<a-scene'), 'register hand-grabber in <head>, before the scene');
});
