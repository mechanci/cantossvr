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

test('a ball that falls off the world is replaced on the stand', async () => {
  const { page } = await openPage();
  await settle(page, 1000);
  await page.evaluate(() => { window.game.balls[0].body.position.set(5, -10, 5); });
  await page.waitForTimeout(2500);
  const { balls } = await snap(page);
  assert.strictEqual(balls.length, 4);
  balls.forEach((p, i) => assert.ok(p[1] > 0.9, `ball ${i} not on the stand: y=${p[1]}`));
  await page.close();
});

test('10 cans and 4 balls are created with physics bodies', async () => {
  const { page } = await openPage();
  assert.strictEqual(await page.evaluate(() => window.game.cans.length), 10);
  assert.strictEqual(await page.evaluate(() => window.game.balls.length), 4);
  await page.close();
});

test('Reset Cans rebuilds the pyramid and leaves the balls alone', async () => {
  const { page } = await openPage();
  await settle(page, 1000);
  const before = await page.evaluate(() => { window.game.cans[0].body.position.set(5, 5, 5); window.game.throwBall(); return window.game.balls.length; });
  await page.click('#resetBtn');
  const after = await page.evaluate(() => [window.game.cans.length, window.game.balls.length]);
  assert.deepStrictEqual(after, [10, before]);
  await settle(page, 1500);
  const { cans } = await snap(page);
  assert.ok(cans.every(p => Math.abs(p[0]) < 0.3 && p[1] > 0.9), 'cans not back on the counter');
  await page.close();
});

test('Refill Balls restores the four balls on the stand', async () => {
  const { page } = await openPage();
  await settle(page, 1000);
  await page.evaluate(() => { window.game.throwBall(); window.game.throwBall(); });
  await page.click('#refillBtn');
  const r = await page.evaluate(() => ({ n: window.game.balls.length, slots: window.game.slots.every(Boolean) }));
  assert.deepStrictEqual(r, { n: 4, slots: true });
  await page.close();
});

test('the cans form a triangle: rows of 4-3-2-1, each can centred on the two below', async () => {
  const { page } = await openPage();
  await settle(page, 2500);
  const { cans } = await snap(page);
  const rows = {};
  cans.forEach(p => { (rows[Math.floor((p[1] - 0.9) / 0.123)] ||= []).push(p[0]); });
  assert.deepStrictEqual(Object.keys(rows).map(k => rows[k].length), [4, 3, 2, 1]);
  for (let r = 1; r < 4; r++) {
    const below = rows[r - 1].sort((a, b) => a - b), here = rows[r].sort((a, b) => a - b);
    here.forEach((x, i) => {
      const mid = (below[i] + below[i + 1]) / 2;
      assert.ok(Math.abs(x - mid) < 0.015, `row ${r} can ${i} is not centred on the two below (${x} vs ${mid})`);
    });
  }
  await page.close();
});

test('taking a ball from the stand puts a new one in its place', async () => {
  const { page } = await openPage();
  await settle(page, 1000);
  const r = await page.evaluate(async () => {
    const { hands, balls, slots } = window.game;
    const hand = hands[1];
    hand.ctrl.matrixAutoUpdate = true;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    hand.ctrl.position.copy(balls[0].mesh.position);
    await wait(100);
    hand.ctrl.dispatchEvent({ type: 'selectstart' });
    const emptySlots = slots.filter(s => !s).length;
    hand.ctrl.position.y += 0.5; // take it away from the stand
    // sim time runs slower than wall time on a software renderer, so wait for it rather than a fixed time
    for (let i = 0; i < 300 && !slots.every(Boolean); i++) await wait(50);
    return { emptySlots, filled: slots.every(Boolean), total: balls.length };
  });
  assert.strictEqual(r.emptySlots, 1);
  assert.ok(r.filled, 'slot was not refilled');
  assert.strictEqual(r.total, 5); // 4 on the stand + the one in hand
  await page.close();
});

test('controllers show the real model: no ball/sphere is drawn over them', async () => {
  const { page } = await openPage();
  const r = await page.evaluate(() => window.game.hands.map(h => ({
    spheres: h.ctrl.children.filter(c => c.geometry && c.geometry.type === 'SphereGeometry').length,
    kinds: h.ctrl.children.map(c => c.type),
  })));
  r.forEach(h => assert.strictEqual(h.spheres, 0, `sphere on controller: ${h.kinds}`));
  await page.close();
});

test('controller hint tooltips are created per hand', async () => {
  const { page } = await openPage();
  const r = await page.evaluate(async () => {
    const { hands } = window.game;
    hands[0].ctrl.dispatchEvent({ type: 'connected', data: { handedness: 'left' } });
    hands[1].ctrl.dispatchEvent({ type: 'connected', data: { handedness: 'right' } });
    await new Promise(r => requestAnimationFrame(r));
    return { tips: hands.map(h => !!h.tip && h.tip.visible), hands: hands.map(h => h.handedness) };
  });
  assert.deepStrictEqual(r.tips, [true, true]);
  assert.deepStrictEqual(r.hands, ['left', 'right']);
  await page.close();
});

test('VR menu: pointing at a button highlights it and the trigger presses it (Reset Cans)', async () => {
  const { page } = await openPage();
  await settle(page, 1500);
  const r = await page.evaluate(async () => {
    const { hands, menuMesh, THREE, cans } = window.game;
    const frame = () => new Promise(r => requestAnimationFrame(r));
    const hand = hands[1];
    hand.ctrl.matrixAutoUpdate = true;
    cans[0].body.position.set(5, 5, 5); // wreck the pyramid
    menuMesh.updateMatrixWorld(true);
    // centre of the "Reset Cans" button (canvas 256,136 of 512x720)
    const local = new THREE.Vector3(0, ((1 - 136 / 720) - 0.5) * 0.5 * 720 / 512, 0);
    const target = menuMesh.localToWorld(local);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(menuMesh.quaternion);
    hand.ctrl.position.copy(target).addScaledVector(normal, 0.5);
    hand.ctrl.quaternion.copy(menuMesh.quaternion); // -z of the controller now points into the panel
    await frame(); await frame();
    const hover = hand.hover, laser = hand.laser.visible;
    hand.ctrl.dispatchEvent({ type: 'selectstart' });
    hand.ctrl.dispatchEvent({ type: 'selectend' });
    const x = window.game.cans[0].body.position.x;
    return { hover, laser, restored: Math.abs(x) < 0.3 };
  });
  assert.strictEqual(r.hover, 0, 'Reset Cans button not hovered');
  assert.ok(r.laser, 'pointer line not shown');
  assert.ok(r.restored, 'pressing the button did not reset the cans');
  await page.close();
});

test('VR buttons: A resets cans, Y refills balls, X toggles hints, holding B quits VR', async () => {
  const { page } = await openPage();
  await settle(page, 1000);
  await page.evaluate(() => {
    const g = window.game;
    window.__pad = { right: [false, false], left: [false, false], ended: 0 };
    const btn = (p) => ({ pressed: p });
    const fake = {
      end() { window.__pad.ended++; },
      get inputSources() {
        const mk = (hand, [p4, p5]) => ({ handedness: hand, gamepad: { buttons: [btn(0), btn(0), btn(0), btn(0), btn(p4), btn(p5)] } });
        return [mk('right', window.__pad.right), mk('left', window.__pad.left)];
      },
    };
    g.renderer.xr.getSession = () => fake;
  });
  const frames = async n => page.evaluate(n => new Promise(res => { let i = 0; const f = () => (++i >= n ? res() : requestAnimationFrame(f)); f(); }), n);
  await page.evaluate(() => { window.game.cans[0].body.position.set(5, 5, 5); window.__pad.right = [true, false]; });
  await frames(3);
  assert.ok(await page.evaluate(() => Math.abs(window.game.cans[0].body.position.x) < 0.3), 'A did not reset the cans');
  await page.evaluate(() => { window.__pad.right = [false, false]; });
  await page.evaluate(() => { window.game.throwBall(); window.__pad.left = [false, true]; });
  await frames(3);
  assert.strictEqual(await page.evaluate(() => window.game.balls.length), 4, 'Y did not refill the balls');
  await page.evaluate(() => { window.__pad.left = [false, false]; });
  const before = await page.evaluate(() => window.game.guide.show);
  await page.evaluate(() => { window.__pad.left = [true, false]; });
  await frames(3);
  assert.strictEqual(await page.evaluate(() => window.game.guide.show), !before, 'X did not toggle hints');
  await page.evaluate(() => { window.__pad.left = [false, false]; });
  await page.evaluate(() => { window.__pad.right = [false, true]; });
  await frames(2);
  await page.evaluate(() => { window.__pad.right = [false, false]; });
  await frames(2);
  assert.strictEqual(await page.evaluate(() => window.__pad.ended), 0, 'a quick B tap must not quit');
  await page.evaluate(() => { window.__pad.right = [false, true]; });
  await page.waitForFunction(() => window.__pad.ended > 0, null, { timeout: 25000 });
  await page.close();
});

const soundTypes = page => page.evaluate(() => window.game.audio.log.map(s => s.type));

test('sound: throwing whooshes and impacts clink/thud (unlocked by the click)', async () => {
  const { page, errors } = await openPage();
  await settle(page);
  await page.evaluate(() => { window.game.camera.rotation.x = -0.05; });
  for (let i = 0; i < 3; i++) { await page.mouse.click(400, 300); await page.waitForTimeout(400); }
  await settle(page, 3000);
  const types = await soundTypes(page);
  assert.ok(types.includes('whoosh'), 'no whoosh on throw');
  assert.ok(types.some(t => ['hit', 'tin', 'thud', 'canfloor'].includes(t)), `no impact sounds: ${types}`);
  const pitched = await page.evaluate(() => window.game.audio.log.filter(s => ['hit', 'tin', 'canfloor'].includes(s.type)).map(s => s.pitch));
  assert.ok(pitched.length && pitched.every(p => p >= 1200 && p <= 1900), `can sounds should carry the can's own pitch: ${pitched}`);
  const ctxState = await page.evaluate(() => window.game.audio.ctx && window.game.audio.ctx.state);
  assert.strictEqual(ctxState, 'running', 'AudioContext not unlocked by the user gesture');
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('sound: grabbing a ball clicks', async () => {
  const { page } = await openPage();
  await settle(page, 1000);
  await page.evaluate(() => {
    const { hands, balls } = window.game;
    hands[0].ctrl.matrixAutoUpdate = true;
    hands[0].ctrl.position.copy(balls[0].mesh.position);
    hands[0].ctrl.dispatchEvent({ type: 'selectstart' });
  });
  assert.ok((await soundTypes(page)).includes('grab'));
  await page.close();
});

test('throw assist: a gentle 1.5 m/s hand motion still launches the ball >= 2.2 m/s', async () => {
  const { page } = await openPage();
  await settle(page);
  const vz = await page.evaluate(async () => {
    const { hands, balls } = window.game;
    const hand = hands[1], ball = balls[0];
    hand.ctrl.matrixAutoUpdate = true;
    const frame = () => new Promise(r => requestAnimationFrame(r));
    hand.ctrl.position.copy(ball.mesh.position);
    await frame();
    hand.ctrl.dispatchEvent({ type: 'selectstart' });
    let last = performance.now();
    for (let i = 0; i < 10; i++) {
      await frame();
      const now = performance.now();
      hand.ctrl.position.z -= 1.5 * (now - last) / 1000;
      last = now;
    }
    hand.ctrl.dispatchEvent({ type: 'selectend' });
    return ball.body.velocity.z;
  });
  assert.ok(vz < -2.2, `assist too weak, vz=${vz}`);
  assert.ok(vz > -18.5, `throw speed not capped, vz=${vz}`);
  await page.close();
});

test('scoreboard counts fallen cans, announces a win, and resets', async () => {
  const { page } = await openPage();
  await settle(page, 1500);
  let s = await page.evaluate(() => {
    window.game.cans.slice(0, 3).forEach(c => c.body.position.set(2, 0.3, -2));
    return null;
  });
  await page.waitForTimeout(500);
  assert.strictEqual(await page.evaluate(() => window.game.score.down), 3);
  await page.evaluate(() => window.game.cans.forEach(c => c.body.position.set(2, 0.3, -2)));
  await page.waitForTimeout(500);
  assert.strictEqual(await page.evaluate(() => window.game.score.won), true);
  assert.ok((await soundTypes(page)).includes('win'));
  await page.click('#resetBtn');
  assert.deepStrictEqual(await page.evaluate(() => [window.game.score.down, window.game.score.won]), [0, false]);
  await page.close();
});
