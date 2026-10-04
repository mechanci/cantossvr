// Browser tests. CDN scripts are served from node_modules so tests are offline and deterministic.
// Run: npm install && npm test   (set CHROMIUM_PATH if Playwright's browser isn't installed)
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
// A-Frame comes from node_modules. The physics script is fetched from its CDN unless
// PHYSICS_JS points at a local copy (useful offline: `npm pack aframe-physics-system@4.0.1`).
const LOCAL = {
  'aframe.min.js': path.join(root, 'node_modules/aframe/dist/aframe-v1.0.4.min.js'),
};
if (process.env.PHYSICS_JS) LOCAL['aframe-physics-system.min.js'] = process.env.PHYSICS_JS;

let server, browser, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(fs.readFileSync(path.join(root, 'index.html')));
  });
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}/`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
});
test.after(async () => { await browser?.close(); server?.close(); });

async function openPage() {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Hand-controller models come from cdn.aframe.io and are blocked in this harness; ignore only those.
  page.on('console', m => { if (m.type() === 'error' && !/ProgressEvent|Failed to load resource|Failed to fetch/.test(m.text())) errors.push(m.text()); });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    const file = Object.keys(LOCAL).find(k => url.endsWith(k));
    if (file) return route.fulfill({ path: LOCAL[file], contentType: 'text/javascript' });
    if (/aframe-physics-system/.test(url)) return route.continue();
    return route.abort(); // any other remote request is a bug (see static test)
  });
  await page.goto(base);
  await page.waitForFunction(() =>
    document.querySelectorAll('.grabbable').length === 4 &&
    [...document.querySelectorAll('.grabbable, #canTower > *')].every(e => e.body), null, { timeout: 20000 });
  return { page, errors };
}
const settle = (page, ms = 2500) => page.waitForTimeout(ms);
const state = page => page.evaluate(() => ({
  cans: [...document.querySelectorAll('#canTower > *')].map(e => e.body.position.toArray ? e.body.position.toArray() : [e.body.position.x, e.body.position.y, e.body.position.z]),
  balls: [...document.querySelectorAll('.grabbable')].map(e => [e.body.position.x, e.body.position.y, e.body.position.z]),
}));

test('page loads with no errors', async () => {
  const { page, errors } = await openPage();
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('10 cans (6/3/1) and 4 balls are created with physics bodies', async () => {
  const { page } = await openPage();
  assert.strictEqual(await page.locator('#canTower > *').count(), 10);
  assert.strictEqual(await page.locator('.grabbable').count(), 4);
  await page.close();
});

test('cans sit stably on the table (physics works, nothing falls or drifts)', async () => {
  const { page } = await openPage();
  const before = await state(page);
  await settle(page, 3000);
  const after = await state(page);
  after.cans.forEach((p, i) => {
    assert.ok(p[1] > 0.8, `can ${i} fell below table top: y=${p[1]}`);
    assert.ok(Math.abs(p[0] - before.cans[i][0]) < 0.05, `can ${i} drifted in x`);
    assert.ok(Math.abs(p[2] - before.cans[i][2]) < 0.05, `can ${i} drifted in z`);
  });
  await page.close();
});

test('balls rest on the pedestal instead of falling through', async () => {
  const { page } = await openPage();
  await settle(page);
  const { balls } = await state(page);
  balls.forEach((p, i) => assert.ok(p[1] > 0.9, `ball ${i} fell: y=${p[1]}`));
  await page.close();
});

test('gravity is active: a thrown ball (mouse click) arcs down and knocks cans', async () => {
  const { page } = await openPage();
  await settle(page);
  const before = await state(page);
  // aim at the table from the origin and click to throw several balls
  for (let i = 0; i < 4; i++) { await page.mouse.click(400, 300); await page.waitForTimeout(400); }
  await settle(page, 3000);
  const after = await state(page);
  const moved = after.cans.filter((p, i) => Math.hypot(p[0]-before.cans[i][0], p[2]-before.cans[i][2]) > 0.1 || p[1] < before.cans[i][1] - 0.1);
  assert.ok(moved.length > 0, 'no can was disturbed by thrown balls');
  await page.close();
});

test('grabbing: trigger near a ball picks it up, it follows the hand, release throws it', async () => {
  const { page } = await openPage();
  await settle(page);
  const r = await page.evaluate(async () => {
    const hand = document.querySelector('#rightHand');
    const ball = document.querySelector('.grabbable');
    const bp = ball.object3D.getWorldPosition(new THREE.Vector3());
    hand.object3D.position.copy(bp).add(new THREE.Vector3(0.05, 0, 0)); // within reach
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await wait(100);
    hand.emit('triggerdown');
    await wait(100);
    const grabbed = ball.heldBy === hand.components['hand-grabber'];
    hand.object3D.position.y += 0.5;           // lift hand
    await wait(300);
    const follows = Math.abs(ball.body.position.y - hand.object3D.position.y) < 0.05;
    // fling toward -z
    // move at a fixed 4 m/s regardless of the (possibly slow, software-rendered) frame rate
    const frame = () => new Promise(r => requestAnimationFrame(r));
    let last = performance.now();
    for (let i = 0; i < 12; i++) {
      await frame();
      const now = performance.now();
      hand.object3D.position.z -= 4 * (now - last) / 1000;
      last = now;
    }
    hand.emit('triggerup');
    return { grabbed, follows, released: !ball.heldBy, vz: ball.body.velocity.z };
  });
  assert.ok(r.grabbed, 'ball not grabbed');
  assert.ok(r.follows, 'ball did not follow the hand');
  assert.ok(r.released, 'ball still held after release');
  assert.ok(r.vz < -1, `ball should leave with throw velocity, vz=${r.vz}`);
  await page.close();
});

test('grabbing: a ball out of reach is NOT picked up', async () => {
  const { page } = await openPage();
  await settle(page);
  const grabbed = await page.evaluate(() => {
    const hand = document.querySelector('#leftHand');
    hand.object3D.position.set(3, 1, 3);
    hand.emit('triggerdown');
    return !!hand.components['hand-grabber'].held;
  });
  assert.strictEqual(grabbed, false);
  await page.close();
});

test('Reset button rebuilds cans and balls', async () => {
  const { page } = await openPage();
  await page.evaluate(() => { document.querySelector('#canTower > *').body.position.set(5, 5, 5); });
  await page.click('#resetBtn');
  await page.waitForFunction(() => [...document.querySelectorAll('#canTower > *')].length === 10 &&
    [...document.querySelectorAll('#canTower > *')].every(e => e.body), null, { timeout: 10000 });
  await settle(page, 1500);
  const { cans } = await state(page);
  assert.ok(cans.every(p => Math.abs(p[0]) < 1.2 && p[1] > 0.8), 'cans not back on the table');
  await page.close();
});
