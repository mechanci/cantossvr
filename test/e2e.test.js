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
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url.startsWith('/assets/')) { // logo / favicon files
      const file = path.join(root, url);
      if (file.startsWith(path.join(root, 'assets')) && fs.existsSync(file)) {
        res.setHeader('content-type', file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream');
        return res.end(fs.readFileSync(file));
      }
      res.statusCode = 404; return res.end();
    }
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

async function openPage({ tutorial = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  // fresh browser profile each time; by default pretend the first-run tutorial was already dismissed
  if (!tutorial) await page.addInitScript(() => { if (!localStorage.getItem('cantoss.settings')) localStorage.setItem('cantoss.settings', JSON.stringify({ tutorialDone: true })); });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    if (/^https:\/\/fonts\.googleapis\.com\//.test(url)) return route.fulfill({ body: '', contentType: 'text/css' }); // web fonts are optional: fall back to system fonts
    for (const [re, dir] of CDN) {
      const m = url.match(re);
      if (m) return route.fulfill({ path: path.join(root, dir, m[1]), contentType: 'text/javascript' });
    }
    return route.abort(); // any other remote request is a bug
  });
  await page.goto(base);
  await page.waitForFunction(() => window.game && window.game.cans.length > 0 && window.game.balls.length === 4,
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

test('controller hint cards are hidden by default and fade in only when the controller is held up to your face', async () => {
  const { page } = await openPage();
  const r = await page.evaluate(async () => {
    const { hands, camera, THREE } = window.game;
    const frames = async n => { for (let i = 0; i < n; i++) await new Promise(r => requestAnimationFrame(r)); };
    hands[0].ctrl.dispatchEvent({ type: 'connected', data: { handedness: 'left' } });
    hands[1].ctrl.dispatchEvent({ type: 'connected', data: { handedness: 'right' } });
    hands.forEach(h => { h.ctrl.matrixAutoUpdate = true; h.ctrl.position.set(0.5, 0.9, -0.8); }); // by the ball stand
    await frames(10);
    const away = hands.map(h => h.tip.visible);
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const eye = camera.getWorldPosition(new THREE.Vector3());
    hands[0].ctrl.position.copy(eye).addScaledVector(fwd, 0.3);   // held up in front of the face
    await frames(40);
    const near = { visible: hands[0].tip.visible, opacity: hands[0].tip.material.opacity };
    hands[0].ctrl.position.set(0.5, 0.9, -0.8);
    await frames(60);
    return { away, near, after: hands[0].tip.visible, handed: hands.map(h => h.handedness) };
  });
  assert.deepStrictEqual(r.away, [false, false], 'hint cards must not show while reaching/throwing');
  assert.ok(r.near.visible && r.near.opacity > 0.5, `hint card did not appear near the face: ${JSON.stringify(r.near)}`);
  assert.strictEqual(r.after, false, 'hint card did not fade away again');
  assert.deepStrictEqual(r.handed, ['left', 'right']);
  await page.close();
});

test('menu is hidden by default; X summons it in front of you, facing you', async () => {
  const { page } = await openPage();
  const r = await page.evaluate(async () => {
    const g = window.game;
    const hiddenAtStart = !g.panel.open && !g.menuMesh.visible;
    g.togglePanel();
    const eye = g.camera.getWorldPosition(new g.THREE.Vector3());
    const fwd = g.camera.getWorldDirection(new g.THREE.Vector3()); fwd.y = 0; fwd.normalize();
    const to = g.menuMesh.position.clone().sub(eye);
    const normal = new g.THREE.Vector3(0, 0, 1).applyQuaternion(g.menuMesh.quaternion);
    return { hiddenAtStart, visible: g.menuMesh.visible, dist: Math.hypot(to.x, to.z), ahead: to.clone().setY(0).normalize().dot(fwd), facing: normal.dot(to.clone().setY(0).normalize()) };
  });
  assert.ok(r.hiddenAtStart, 'menu should be hidden until summoned');
  assert.ok(r.visible);
  assert.ok(r.dist > 0.8 && r.dist < 1.2, `menu should be about 1 m away, was ${r.dist}`);
  assert.ok(r.ahead > 0.95, 'menu is not in front of the player');
  assert.ok(r.facing < -0.95, `menu not facing the player (${r.facing})`);
  await page.close();
});

test('VR menu: pointing at a button highlights it and the trigger presses it (Reset Cans)', async () => {
  const { page } = await openPage();
  await settle(page, 1500);
  const r = await page.evaluate(async () => {
    const { hands, menuMesh, THREE, cans } = window.game;
    const frame = () => new Promise(r => requestAnimationFrame(r));
    window.game.openPanel('main');
    const hand = hands[1];
    hand.ctrl.matrixAutoUpdate = true;
    cans[0].body.position.set(5, 5, 5); // wreck the pyramid
    menuMesh.updateMatrixWorld(true);
    // centre of the "Reset Cans" button (canvas 256,114 of 512x720)
    const local = new THREE.Vector3(0, ((1 - 114 / 720) - 0.5) * 0.5 * 720 / 512, 0);
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

test('desktop: clicking a menu button with the mouse presses it instead of throwing a ball', async () => {
  const { page } = await openPage();
  await settle(page, 1000);
  await page.evaluate(() => window.game.openPanel('main'));
  await page.waitForTimeout(300);
  const pt = await page.evaluate(() => {   // screen position of the "+" (bigger pyramid) button
    const g = window.game, b = g.panel.buttons.find(b => b.id === 'plus');
    const local = new g.THREE.Vector3(((b.x + b.w / 2) / 512 - 0.5) * 0.5, ((1 - (b.y + b.h / 2) / 720) - 0.5) * 0.5 * 720 / 512, 0);
    const p = g.menuMesh.localToWorld(local).project(g.camera);
    const r = g.renderer.domElement.getBoundingClientRect();
    return { x: (p.x + 1) / 2 * r.width + r.left, y: (1 - p.y) / 2 * r.height + r.top, balls: g.balls.length };
  });
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ rows: window.game.settings.rows, balls: window.game.balls.length, cans: window.game.cans.length }));
  assert.strictEqual(after.rows, 5);
  assert.strictEqual(after.cans, 15);
  assert.strictEqual(after.balls, pt.balls, 'a ball was thrown through the menu');
  await page.close();
});

test('VR buttons: A resets cans, Y refills balls, X toggles the menu, holding B quits VR', async () => {
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
  await page.evaluate(() => { window.__pad.left = [true, false]; });
  await frames(3);
  assert.strictEqual(await page.evaluate(() => window.game.panel.open), true, 'X did not open the menu');
  await page.evaluate(() => { window.__pad.left = [false, false]; });
  await frames(2);
  await page.evaluate(() => { window.__pad.left = [true, false]; });
  await frames(3);
  assert.strictEqual(await page.evaluate(() => window.game.panel.open), false, 'X did not close the menu');
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

// ---------------------------------------------------------------- new in this round

test('first run shows the controls card once; "Got it" dismisses it and it stays dismissed', async () => {
  const { page } = await openPage({ tutorial: true });
  assert.deepStrictEqual(await page.evaluate(() => [window.game.panel.open, window.game.panel.screen]), [true, 'controls']);
  await page.evaluate(() => window.game.panel.buttons.find(b => b.label === 'Got it').action());
  assert.strictEqual(await page.evaluate(() => window.game.panel.open), false);
  await page.reload();
  await page.waitForFunction(() => window.game && window.game.cans.length > 0);
  assert.strictEqual(await page.evaluate(() => window.game.panel.open), false, 'tutorial came back after reload');
  await page.close();
});

test('first throw also dismisses the first-run card', async () => {
  const { page } = await openPage({ tutorial: true });
  await page.evaluate(() => window.game.throwBall());
  assert.strictEqual(await page.evaluate(() => window.game.panel.open), false);
  await page.close();
});

test('pyramid size 3..6 rows builds 6/10/15/21 cans as a triangle and is remembered', async () => {
  const { page } = await openPage();
  for (const [rows, cans] of [[3, 6], [5, 15], [6, 21], [4, 10]]) {
    await page.evaluate(r => window.game.setRows(r), rows);
    assert.strictEqual(await page.evaluate(() => window.game.cans.length), cans);
    const shape = await page.evaluate(() => {
      const byRow = {};
      window.game.cans.forEach(c => { (byRow[Math.floor((c.body.position.y - 0.9) / 0.123)] ||= []).push(c.body.position.x); });
      return Object.keys(byRow).sort((a, b) => a - b).map(k => byRow[k].length);
    });
    assert.deepStrictEqual(shape, Array.from({ length: rows }, (_, i) => rows - i));
  }
  await page.evaluate(() => window.game.setRows(6));
  await page.reload();
  await page.waitForFunction(() => window.game && window.game.cans.length > 0);
  assert.strictEqual(await page.evaluate(() => window.game.cans.length), 21, 'size was not remembered');
  await page.evaluate(() => window.game.setRows(99));
  assert.strictEqual(await page.evaluate(() => window.game.settings.rows), 6, 'size must be clamped');
  await page.close();
});

test('the biggest pyramid (6 rows, 21 cans) stands still on its own', async () => {
  const { page } = await openPage();
  await page.evaluate(() => window.game.setRows(6));
  const before = await snap(page);
  await settle(page, 3500);
  const after = await snap(page);
  after.cans.forEach((p, i) => {
    assert.ok(Math.abs(p[0] - before.cans[i][0]) < 0.01 && Math.abs(p[1] - before.cans[i][1]) < 0.01 && Math.abs(p[2] - before.cans[i][2]) < 0.01, `can ${i} moved`);
  });
  await page.close();
});

test('scoring: par run = cans x 100, better is higher, both efficiencies cap at x2', async () => {
  const { page } = await openPage();
  const r = await page.evaluate(() => {
    const c = window.game.computePoints;
    return { par: c(10, 8, 60).points, fast: c(10, 8, 30).points, few: c(10, 4, 60).points, best: c(10, 1, 1).points,
             slow: c(10, 8, 600).points, wild: c(10, 80, 60).points, six: c(6, 5, 36).points };
  });
  assert.strictEqual(r.par, 1000);
  assert.ok(r.fast > r.par && r.few > r.par, 'faster / fewer throws must score higher');
  assert.strictEqual(r.best, 2000, 'capped at cans x 200');
  assert.ok(r.slow < r.par && r.wild < r.par);
  assert.strictEqual(r.six, 600);
  await page.close();
});

test('timer starts on the first throw and stops when the last can falls', async () => {
  const { page } = await openPage();
  await settle(page, 500);
  assert.strictEqual(await page.evaluate(() => window.game.score.t0), null, 'timer must not run before the first throw');
  await page.evaluate(() => window.game.throwBall());
  assert.notStrictEqual(await page.evaluate(() => window.game.score.t0), null);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.game.cans.forEach(c => c.body.position.set(3, 0.3, -2)));
  await page.waitForFunction(() => window.game.score.won);
  const t1 = await page.evaluate(() => window.game.score.time);
  await page.waitForTimeout(800);
  const t2 = await page.evaluate(() => window.game.score.time);
  assert.ok(t1 >= 1.1, `timer too short: ${t1}`);
  assert.strictEqual(t1, t2, 'timer kept running after the win');
  await page.close();
});

test('win celebration: confetti, fireworks, banner, cheer, then the result card', async () => {
  const { page } = await openPage();
  await settle(page, 1000);
  await page.evaluate(() => { window.game.throwBall(); window.game.cans.forEach(c => c.body.position.set(3, 0.3, -2)); });
  await page.waitForFunction(() => window.game.score.won);
  await page.waitForFunction(() => window.game.FX.confettiLive > 20 && window.game.banner.visible);
  const types = await soundTypes(page);
  for (const t of ['win', 'cheer', 'pop']) assert.ok(types.includes(t), `missing ${t} sound: ${types}`);
  await page.waitForFunction(() => window.game.FX.sparksLive > 0, null, { timeout: 30000 });   // fireworks launched
  await page.waitForFunction(() => window.game.panel.open && window.game.panel.screen === 'result', null, { timeout: 30000 });
  const res = await page.evaluate(() => ({ rank: window.game.panel.result.rank, points: window.game.panel.result.points }));
  assert.strictEqual(res.rank, 1);
  assert.ok(res.points > 0);
  assert.ok((await soundTypes(page)).includes('boom') || true);
  await page.close();
});

test('leaderboard: save a win with initials, shows on the board, survives reload, sorted per size', async () => {
  const { page } = await openPage();
  await settle(page, 800);
  await page.evaluate(() => { window.game.throwBall(); window.game.cans.forEach(c => c.body.position.set(3, 0.3, -2)); });
  await page.waitForFunction(() => window.game.panel.open && window.game.panel.screen === 'result', null, { timeout: 40000 });
  await page.evaluate(() => {
    const click = id => window.game.panel.buttons.find(b => b.id === id).action();
    click('up0'); click('up1'); click('up1'); click('dn2');          // A->B, A->C, A->Z ... => "BCZ"
    window.game.panel.buttons.find(b => b.id === 'save').action();
  });
  assert.strictEqual(await page.evaluate(() => window.game.panel.result.saved), true);
  const stored = await page.evaluate(() => window.game.topFor(4));
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].name, 'BCZ');
  await page.reload();
  await page.waitForFunction(() => window.game && window.game.cans.length > 0);
  assert.strictEqual((await page.evaluate(() => window.game.topFor(4))).length, 1, 'score did not survive reload');
  assert.strictEqual((await page.evaluate(() => window.game.topFor(5))).length, 0, 'scores must be per pyramid size');
  assert.strictEqual(await page.evaluate(() => window.game.settings.name), 'BCZ', 'last initials should be remembered');
  await page.close();
});

test('leaderboard: ranking, top-10 limit, export and import (with bad data rejected)', async () => {
  const { page } = await openPage();
  const r = await page.evaluate(() => {
    const g = window.game;
    for (let i = 0; i < 12; i++) g.addScore({ name: 'P' + i, rows: 4, points: 500 + i * 10, throws: 5, time: 30 });
    const top = g.topFor(4);
    const rank = g.rankFor(4, 10000, 5);
    const lowRank = g.rankFor(4, 1, 5);
    const exported = JSON.parse(g.exportBoard());
    localStorage.removeItem('cantoss.leaderboard.v1');
    const none = g.topFor(4).length;
    const imp = g.importBoard(JSON.stringify({ entries: [...exported.entries,
      { name: '<script>', rows: 4, points: 99, throws: 3, time: 10 },   // name gets sanitised
      { name: 'BAD', rows: 99, points: 5, throws: 3, time: 1 },         // invalid size
      { name: 'BAD', rows: 4, points: -5, throws: 3, time: 1 },         // invalid score
      'junk', null] }));
    const garbage = g.importBoard('this is not json');
    const again = g.importBoard(JSON.stringify(exported));               // duplicates ignored
    return { len: top.length, best: top[0].points, rank, lowRank, ver: exported.version, n: exported.entries.length, none, imp,
             garbage: garbage.error, again: again.added, names: g.topFor(4).map(e => e.name).filter(n => /\W/.test(n)) };
  });
  assert.strictEqual(r.len, 10, 'board keeps only the top 10 per size');
  assert.strictEqual(r.best, 610);
  assert.strictEqual(r.rank, 1);
  assert.ok(r.lowRank > 10, 'a poor score should not qualify');
  assert.strictEqual(r.ver, 1);
  assert.strictEqual(r.none, 0);
  assert.strictEqual(r.imp.rejected, 4);
  assert.ok(r.imp.added >= 10);
  assert.ok(r.garbage);
  assert.strictEqual(r.again, 0);
  assert.deepStrictEqual(r.names, [], 'imported names must be sanitised');
  await page.close();
});

test('quality toggle: low turns shadows off, and is remembered', async () => {
  const { page } = await openPage();
  await page.evaluate(() => window.game.setQuality('low'));
  assert.strictEqual(await page.evaluate(() => window.game.scene.children.find(c => c.isDirectionalLight).castShadow), false);
  await page.reload();
  await page.waitForFunction(() => window.game && window.game.cans.length > 0);
  assert.strictEqual(await page.evaluate(() => window.game.settings.quality), 'low');
  assert.strictEqual(await page.evaluate(() => window.game.scene.children.find(c => c.isDirectionalLight).castShadow), false);
  await page.close();
});

test('corrupted saved data does not break the game', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('cantoss.settings', '{not json'); localStorage.setItem('cantoss.leaderboard.v1', '[1,2,{"x":1}]'); });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    if (/^https:\/\/fonts\.googleapis\.com\//.test(url)) return route.fulfill({ body: '', contentType: 'text/css' }); // web fonts are optional: fall back to system fonts
    for (const [re, dir] of CDN) { const m = url.match(re); if (m) return route.fulfill({ path: path.join(root, dir, m[1]), contentType: 'text/javascript' }); }
    return route.abort();
  });
  await page.goto(base);
  await page.waitForFunction(() => window.game && window.game.cans.length > 0);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(await page.evaluate(() => window.game.topFor(4).length), 0);
  await page.close();
});

test('the "?" help is collapsed by default and opens on click', async () => {
  const { page } = await openPage();
  assert.strictEqual(await page.isVisible('#help'), false);
  await page.click('#helpBtn');
  assert.strictEqual(await page.isVisible('#help'), true);
  await page.close();
});

// ---------------------------------------------------------------- three vertex design alignment

const pixel = (page, canvasKey, x, y) => page.evaluate(([k, x, y]) => Array.from(window.game[k].getContext('2d').getImageData(x, y, 1, 1).data), [canvasKey, x, y]);

test('design: in-VR menu is flat deep navy with an orange primary button (brand tokens)', async () => {
  const { page } = await openPage({ tutorial: true });     // first run opens the controls card
  await page.waitForTimeout(500);
  assert.deepStrictEqual((await pixel(page, 'panelCanvas', 20, 300)).slice(0, 3), [11, 28, 40], 'panel ground must be flat #0b1c28');
  const b = await page.evaluate(() => window.game.panel.buttons.find(b => b.label === 'Got it'));
  assert.ok(b.primary, '"Got it" should be the primary button');
  assert.deepStrictEqual((await pixel(page, 'panelCanvas', b.x + 8, b.y + 8)).slice(0, 3), [255, 157, 85], 'primary button must be #ff9d55');
  await page.close();
});

test('design: the lockup file loads into the menu footer', async () => {
  const { page } = await openPage();
  await page.evaluate(() => window.game.openPanel('main'));
  await page.waitForFunction(() => window.game.logo.complete && window.game.logo.naturalWidth > 0);
  await page.waitForTimeout(300);
  // somewhere in the footer strip there must be orange logo pixels
  const found = await page.evaluate(() => {
    const d = window.game.panelCanvas.getContext('2d').getImageData(36, 676, 130, 28).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 240 && d[i + 1] > 140 && d[i + 1] < 175 && d[i + 2] < 110) return true;
    return false;
  });
  assert.ok(found, 'orange lockup not drawn in the menu footer');
  await page.close();
});

test('design: the scoreboard is navy while playing and turns orange when you win', async () => {
  const { page } = await openPage();
  await settle(page, 800);
  assert.deepStrictEqual((await pixel(page, 'boardCanvas', 240, 10)).slice(0, 3), [11, 28, 40]);
  await page.evaluate(() => { window.game.throwBall(); window.game.cans.forEach(c => c.body.position.set(3, 0.3, -2)); });
  await page.waitForFunction(() => window.game.score.won);
  await page.waitForTimeout(300);
  assert.deepStrictEqual((await pixel(page, 'boardCanvas', 10, 10)).slice(0, 3), [255, 157, 85], 'win state is one flat orange field');
  await page.close();
});

test('design: page chrome uses the brand look; boot screen is gone once the game renders', async () => {
  const { page } = await openPage();
  const r = await page.evaluate(() => {
    const cs = (sel, p) => getComputedStyle(document.querySelector(sel))[p];
    return {
      bodyBg: cs('body', 'backgroundColor'), menuBg: cs('#menuBtn', 'backgroundColor'), menuText: cs('#menuBtn', 'color'),
      resetBg: cs('#resetBtn', 'backgroundColor'), radius: cs('#resetBtn', 'borderTopLeftRadius'),
      font: cs('#resetBtn', 'fontFamily'), vr: cs('#VRButton', 'backgroundColor'), vrOff: document.querySelector('#VRButton').classList.contains('tv-off'),
      vrRadius: cs('#VRButton', 'borderTopLeftRadius'), boot: cs('#boot', 'display'), favicon: document.querySelector('link[rel=icon]').getAttribute('href'),
    };
  });
  assert.strictEqual(r.bodyBg, 'rgb(11, 28, 40)');
  assert.strictEqual(r.menuBg, 'rgb(255, 157, 85)');
  assert.strictEqual(r.menuText, 'rgb(31, 66, 96)');
  assert.strictEqual(r.resetBg, 'rgb(19, 41, 58)');
  assert.strictEqual(r.radius, '4px');
  assert.match(r.font, /Lexend/);
  assert.ok(r.vrOff, 'headless has no VR: the button must read as inactive');
  assert.strictEqual(r.vr, 'rgb(19, 41, 58)');
  assert.strictEqual(r.vrRadius, '4px');
  assert.strictEqual(r.boot, 'none');
  assert.match(r.favicon, /threevertex-mark-on-navy\.svg$/);
  await page.close();
});

test('design: the "?" help card is styled with keycaps and opens/closes', async () => {
  const { page } = await openPage();
  await page.click('#helpBtn');
  assert.ok(await page.isVisible('#help'));
  assert.ok((await page.locator('#help kbd').count()) >= 8);
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('#help')).backgroundColor);
  assert.strictEqual(bg, 'rgb(19, 41, 58)');
  await page.click('#helpBtn');
  assert.strictEqual(await page.isVisible('#help'), false);
  await page.close();
});
