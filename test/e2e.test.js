// Browser tests. three / cannon-es are served from node_modules (offline, deterministic).
// Run: npm install && npm test   (set CHROMIUM_PATH if Playwright's browser isn't installed)
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const CDN = [
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.160\.0\/(.*)$/, 'node_modules/three/'],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/cannon-es@0\.20\.0\/(.*)$/, 'node_modules/cannon-es/'],
];

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
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    for (const [re, dir] of CDN) {
      const m = url.match(re);
      if (m) return route.fulfill({ path: path.join(root, dir, m[1]), contentType: 'text/javascript' });
    }
    return route.abort(); // any other remote request is a bug
  });
  await page.goto(base);
  await page.waitForFunction(() => window.game && window.game.cans.length === 10 && window.game.balls.length === 4,
    null, { timeout: 20000 });
  return { page, errors };
}
const settle = (page, ms = 2500) => page.waitForTimeout(ms);
const snap = page => page.evaluate(() => ({
  cans: window.game.cans.map(c => [c.body.position.x, c.body.position.y, c.body.position.z]),
  balls: window.game.balls.map(b => [b.body.position.x, b.body.position.y, b.body.position.z]),
}));

test('page loads with no errors', async () => {
  const { page, errors } = await openPage();
  await settle(page, 1000);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('WebXR is enabled and both controllers are in the scene', async () => {
  const { page } = await openPage();
  const r = await page.evaluate(() => ({
    xr: window.game.renderer.xr.enabled,
    hands: window.game.hands.length,
    inScene: window.game.hands.every(h => { let p = h.ctrl; while (p.parent) p = p.parent; return p === window.game.scene; }),
    canvas: !!document.querySelector('canvas'),
  }));
  assert.deepStrictEqual(r, { xr: true, hands: 2, inScene: true, canvas: true });
  await page.close();
});

test('the scene actually renders (canvas is not blank)', async () => {
  const { page } = await openPage();
  await settle(page, 1000);
  const shot = await page.screenshot();
  // sky blue background + objects: a blank/black canvas would have a single colour
  const { PNG } = (() => { try { return require('pngjs'); } catch { return {}; } })();
  if (!PNG) { assert.ok(shot.length > 5000, 'screenshot suspiciously small'); }
  else {
    const png = PNG.sync.read(shot);
    const colours = new Set();
    for (let i = 0; i < png.data.length; i += 4 * 97) colours.add(png.data.slice(i, i + 3).join(','));
    assert.ok(colours.size > 5, 'canvas looks blank');
  }
  await page.close();
});

test('cans sit stably on the table (physics works, nothing falls or drifts)', async () => {
  const { page } = await openPage();
  const before = await snap(page);
  await settle(page, 3000);
  const after = await snap(page);
  after.cans.forEach((p, i) => {
    assert.ok(p[1] > 0.9, `can ${i} fell below table top: y=${p[1]}`);
    assert.ok(Math.abs(p[0] - before.cans[i][0]) < 0.02, `can ${i} drifted in x`);
    assert.ok(Math.abs(p[2] - before.cans[i][2]) < 0.02, `can ${i} drifted in z`);
  });
  await page.close();
});

test('balls rest on the pedestal instead of falling through', async () => {
  const { page } = await openPage();
  await settle(page);
  const { balls } = await snap(page);
  balls.forEach((p, i) => assert.ok(p[1] > 0.9, `ball ${i} fell: y=${p[1]}`));
  await page.close();
});

test('a thrown ball (mouse click) falls under gravity and knocks cans over', async () => {
  const { page } = await openPage();
  await settle(page);
  const before = await snap(page);
  // aim slightly down so the arc reaches the cans (camera already looks down -z)
  await page.evaluate(() => { window.game.camera.rotation.x = -0.05; });
  for (let i = 0; i < 4; i++) { await page.mouse.click(400, 300); await page.waitForTimeout(400); }
  await settle(page, 3000);
  const after = await snap(page);
  const moved = after.cans.filter((p, i) =>
    Math.hypot(p[0] - before.cans[i][0], p[2] - before.cans[i][2]) > 0.05 || p[1] < before.cans[i][1] - 0.05);
  assert.ok(moved.length > 0, 'no can was disturbed by thrown balls');
  await page.close();
});

test('grabbing: trigger near a ball picks it up, it follows the hand, release throws it', async () => {
  const { page } = await openPage();
  await settle(page);
  const r = await page.evaluate(async () => {
    const { hands, balls, THREE } = window.game;
    // three drives controllers from the XR session (matrixAutoUpdate=false); outside VR we drive them by hand
    hands.forEach(h => { h.ctrl.matrixAutoUpdate = true; });
    const hand = hands[1], ball = balls[0];
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const frame = () => new Promise(r => requestAnimationFrame(r));
    hand.ctrl.position.copy(ball.mesh.position).add(new THREE.Vector3(0.05, 0, 0)); // within reach
    await frame();
    hand.ctrl.dispatchEvent({ type: 'selectstart' });
    const grabbed = hand.held === ball && ball.heldBy === hand;
    hand.ctrl.position.y += 0.5;
    await wait(300);
    const follows = Math.abs(ball.body.position.y - hand.ctrl.position.y) < 0.05;
    // move at a fixed 4 m/s regardless of the (possibly slow, software-rendered) frame rate
    let last = performance.now();
    for (let i = 0; i < 12; i++) {
      await frame();
      const now = performance.now();
      hand.ctrl.position.z -= 4 * (now - last) / 1000;
      last = now;
    }
    hand.ctrl.dispatchEvent({ type: 'selectend' });
    return { grabbed, follows, released: !ball.heldBy && !hand.held, vz: ball.body.velocity.z };
  });
  assert.ok(r.grabbed, 'ball not grabbed');
  assert.ok(r.follows, 'ball did not follow the hand');
  assert.ok(r.released, 'ball still held after release');
  assert.ok(r.vz < -1, `ball should leave with throw velocity, vz=${r.vz}`);
  await page.close();
});

test('grip (squeeze) also grabs, and each ball can only be held by one hand', async () => {
  const { page } = await openPage();
  await settle(page);
  const r = await page.evaluate(async () => {
    const { hands, balls } = window.game;
    const frame = () => new Promise(r => requestAnimationFrame(r));
    hands.forEach(h => { h.ctrl.matrixAutoUpdate = true; });
    hands[0].ctrl.position.copy(balls[1].mesh.position);
    hands[1].ctrl.position.copy(balls[1].mesh.position);
    await frame();
    hands[0].ctrl.dispatchEvent({ type: 'squeezestart' });
    hands[1].ctrl.dispatchEvent({ type: 'squeezestart' });
    return { first: hands[0].held === balls[1], second: hands[1].held === balls[1] };
  });
  assert.strictEqual(r.first, true);
  assert.strictEqual(r.second, false);
  await page.close();
});

test('a ball out of reach is NOT picked up', async () => {
  const { page } = await openPage();
  await settle(page);
  const held = await page.evaluate(() => {
    const h = window.game.hands[0];
    h.ctrl.matrixAutoUpdate = true;
    h.ctrl.position.set(3, 1, 3);
    h.ctrl.dispatchEvent({ type: 'selectstart' });
    return !!h.held;
  });
  assert.strictEqual(held, false);
  await page.close();
});

test('a ball that falls off the world respawns on the pedestal', async () => {
  const { page } = await openPage();
  await settle(page, 1000);
  await page.evaluate(() => { const b = window.game.balls[0]; b.body.position.set(5, -10, 5); });
  await page.waitForTimeout(1500);
  const { balls } = await snap(page);
  assert.ok(balls[0][1] > 0.9, `ball did not respawn: y=${balls[0][1]}`);
  await page.close();
});

test('Reset button rebuilds cans and balls', async () => {
  const { page } = await openPage();
  await page.evaluate(() => { window.game.cans[0].body.position.set(5, 5, 5); window.game.throwBall(); });
  await page.click('#resetBtn');
  const counts = await page.evaluate(() => [window.game.cans.length, window.game.balls.length]);
  assert.deepStrictEqual(counts, [10, 4]);
  await settle(page, 1500);
  const { cans } = await snap(page);
  assert.ok(cans.every(p => Math.abs(p[0]) < 0.7 && p[1] > 0.9), 'cans not back on the table');
  await page.close();
});
