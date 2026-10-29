// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Private Cinema contributors.
// Open-source snapshot prepared 2026-10-29; see CHANGELOG.md.
// Local fixture only. No Cloudflare credentials, production rooms or movie files.
const { chromium } = require('playwright');
const { WebSocketServer } = require('ws');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../public');
const out = path.resolve(__dirname, '../build-output');
const room = { id: 'local-test-room', title: 'Local movie test', locked: false, captions: [] };
const captions = [];
const clocks = [];
const requests = [];
let siteSettings = {};
let nextId = 1;
const tickets = new Map();
const sockets = new WebSocketServer({ noServer: true });
const metadata = () => captions.map(({ content, ...meta }) => meta);
const broadcast = (data) => { for (const client of sockets.clients) if (client.readyState === 1) client.send(JSON.stringify(data)); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  requests.push({ method: req.method, pathname: url.pathname });
  const json = (data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (url.pathname.startsWith('/api/')) {
    const authenticated = (req.headers.cookie || '').includes('fixture_admin=1');
    if (url.pathname === '/api/config') return json({ownerConfigured:true,realtimeConfigured:true});
    if (url.pathname === '/api/admin/session') return json({authenticated});
    if (url.pathname === '/api/admin/rooms') return json({rooms:[]});
    if (url.pathname === '/api/admin/login') {
      res.setHeader('Set-Cookie','fixture_admin=1; HttpOnly; SameSite=Strict; Path=/');
      return json({authenticated:true});
    }
    if (url.pathname === '/api/site-settings' || url.pathname === '/api/admin/site-settings') {
      if (req.method !== 'GET' && !authenticated) { res.writeHead(401); return res.end('{}'); }
      if (req.method === 'PUT') { let body='';for await(const chunk of req)body+=chunk; siteSettings=(await import('../public/site-settings.js')).validateSiteSettings(JSON.parse(body)); }
      if (req.method === 'DELETE') siteSettings={};
      return json({settings:siteSettings,configured:Object.keys(siteSettings).length>0});
    }
    if (url.pathname.endsWith('/ticket')) {
      const claims = JSON.parse(Buffer.from(req.headers.authorization.split(' ')[1].split('.')[0], 'base64url'));
      const ticket = `ticket-${nextId++}`; tickets.set(ticket, claims.role);
      return json({ ticket, room: { ...room, captions: metadata() } });
    }
    if (req.method === 'POST' && url.pathname.endsWith('/control/captions')) {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body); const caption = { id: `caption-${nextId++}`, ...input };
      captions.push(caption); broadcast({ type: 'captions:update', captions: metadata() });
      return json({ caption, captions: metadata() });
    }
    if (url.pathname.includes('/captions/')) return json({ caption: captions.find((item) => item.id === url.pathname.split('/').at(-1)) });
    return json({ invites: [], iceServers: [] });
  }
  const name = ['/', '/host'].includes(url.pathname) ? 'index.html' : url.pathname.slice(1);
  if (!['index.html', 'app.js', 'room-connection.js', 'site-config.js', 'site-settings.js', 'local-media.js', 'audio-inspector.js', 'external-audio.js', 'styles.css', 'player.html', 'player.js', 'player.css'].includes(name)) { res.writeHead(404); return res.end(); }
  let content = fs.readFileSync(path.join(root, name), 'utf8');
  // Fixture-only state access for media-independent assertions; never packaged in public/.
  if (name === 'app.js') {
    content = content.replace('} else publishCaptionClock(0, true, "capture", true, 1);', '} else publishCaptionClock(0, true, "capture", true, 1);\n return; // fixture: no production RTC/SFU');
    content += '\nglobalThis.__test={state,applyCaptionClock,currentCaptionTime,renderCaption,showHostPreview,updateLocalPlaybackControls,startCaptionRenderer,startBroadcast,publishCaptionClock};';
  }
  res.writeHead(200, {
    'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
    'cache-control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; connect-src 'self' ws:; img-src 'self' data:",
    'Permissions-Policy': 'camera=(), microphone=(), display-capture=(self), fullscreen=(self)',
  });
  res.end(content);
});
server.on('upgrade', (req, socket, head) => {
  const ticket = new URL(req.url, 'http://localhost').searchParams.get('ticket');
  const role = tickets.get(ticket);
  if (!role) return socket.destroy();
  sockets.handleUpgrade(req, socket, head, (ws) => {
    ws.role = role;
    ws.send(JSON.stringify({ type: 'welcome', id: `${role}-${nextId++}`, role, room: { ...room, captions: metadata() }, participants: [], media: null }));
    ws.on('message', (raw) => {
      const data = JSON.parse(String(raw));
      if (data.type === 'caption:clock' && role === 'host') { clocks.push(data.clock); broadcast(data); }
      if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    });
  });
});

(async () => {
  let browser;
  try {
    fs.mkdirSync(out, { recursive: true });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
      args: ['--disable-gpu', '--autoplay-policy=no-user-gesture-required'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 920 } });
    const errors = [];
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    const host = await context.newPage();
    // Real owner form with server-backed fixture settings; Worker auth and
    // persistence are separately exercised in test/site-settings.test.js.
    const owner = await context.newPage();
    await owner.goto(`${origin}/host`);
    await owner.locator('#ownerEntry').waitFor({state:'visible'});
    await owner.locator('#ownerPassword').fill('fixture-password');
    await owner.locator('#ownerLoginForm button').click();
    await owner.locator('#ownerDashboard').waitFor({state:'visible'});
    assert.equal(await owner.locator('#siteSettingsPanel').evaluate(el=>el.open),true);
    await owner.locator('[data-setting="title"]').fill('Local test cinema');
    await owner.locator('[data-setting="tagline"]').fill('Shared quietly.');
    await owner.locator('[data-setting="defaultHostName"]').fill('Projectionist');
    await owner.locator('#saveSiteSettings').click();
    await owner.waitForFunction(()=>document.querySelector('#siteSettingsStatus').textContent.startsWith('已保存并应用'));
    assert.equal(await owner.title(),'Local test cinema');
    await owner.reload();
    await owner.locator('#ownerDashboard').waitFor({state:'visible'});
    assert.equal(await owner.locator('#siteSettingsPanel').evaluate(el=>el.open),false);
    await owner.locator('#siteSettingsPanel > summary').click();
    assert.equal(await owner.locator('[data-setting="title"]').inputValue(),'Local test cinema');
    assert.equal(await owner.locator('[data-setting="defaultHostName"]').inputValue(),'Projectionist');
    await owner.screenshot({path:path.join(out,'host-settings-desktop.png'),fullPage:true});
    const publicContext = await browser.newContext({viewport:{width:390,height:844}});
    const publicPage = await publicContext.newPage();
    await publicPage.goto(`${origin}/`);
    await publicPage.waitForFunction(()=>document.title==='Local test cinema');
    assert.equal(await publicPage.locator('.brand small').textContent(),'Shared quietly.');
    assert.equal(await publicPage.evaluate(async()=> (await fetch('/api/admin/site-settings',{method:'PUT',body:'{"title":"Denied"}'})).status),401);
    await publicPage.goto(`${origin}/player.html`);
    await publicPage.waitForFunction(()=>document.title.includes('Local test cinema'));
    await owner.route('**/api/admin/site-settings',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Fixture unavailable"}'}));
    await owner.locator('[data-setting="title"]').fill('Draft stays');
    await owner.locator('#saveSiteSettings').click();
    await owner.waitForFunction(()=>document.querySelector('#siteSettingsStatus').textContent.startsWith('保存失败'));
    assert.equal(await owner.locator('[data-setting="title"]').inputValue(),'Draft stays');
    await owner.unroute('**/api/admin/site-settings');
    await owner.setViewportSize({width:390,height:844});
    await owner.locator('.site-settings-advanced > summary').click();
    assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await owner.screenshot({path:path.join(out,'host-settings-mobile.png'),fullPage:true});
    await owner.locator('[data-setting="title"]').fill('测试'.repeat(40));
    await owner.locator('#saveSiteSettings').click();
    await owner.waitForFunction(()=>document.querySelector('#siteSettingsStatus').textContent.startsWith('已保存并应用'));
    assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await publicPage.goto(`${origin}/`);
    await publicPage.waitForFunction(()=>document.title==='测试'.repeat(40));
    assert.equal(await publicPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await owner.route('**/api/site-settings',route=>route.fulfill({status:503,body:'{}'}));
    await owner.reload();
    await owner.locator('#ownerDashboard').waitFor({state:'visible'});
    assert.equal(await owner.locator('#saveSiteSettings').isDisabled(),true);
    await owner.waitForFunction(()=>document.querySelector('#siteSettingsStatus').textContent.startsWith('读取服务器设置失败'));
    await owner.unroute('**/api/site-settings');
    await owner.reload();
    await owner.locator('#ownerDashboard').waitFor({state:'visible'});
    await owner.locator('#siteSettingsPanel > summary').click();
    owner.once('dialog',dialog=>dialog.accept());
    await owner.locator('#resetSiteSettings').click();
    await owner.waitForFunction(()=>document.querySelector('#siteSettingsStatus').textContent.startsWith('已恢复默认'));
    await publicPage.goto(`${origin}/`);
    await publicPage.waitForFunction(()=>document.title==='Private Cinema');
    await publicContext.close(); await owner.close();
    const token = (role) => Buffer.from(JSON.stringify({ room: room.id, role, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.fixture';
    const join = async (page, role) => {
      await page.goto(`${origin}/?invite=${token(role)}`);
      await page.locator('#guestName').fill(role);
      await page.locator('#enterRoomButton').click();
      await page.locator('#cinemaView').waitFor({ state: 'visible' });
    };
    await join(host, 'host');
    assert.equal(await host.title(), 'Private Cinema');
    assert.equal(await host.locator('.brand strong').textContent(), 'Private Cinema');
    assert.equal(await host.locator('#localPlayback').isVisible(), false);
    const newPage = context.waitForEvent('page');
    await host.locator('#openMovie').click();
    const player = await newPage;
    await player.waitForLoadState();
    await player.waitForFunction(() => document.querySelector('#roomConnection').textContent.includes('Room linked'));
    assert.equal(await player.locator('#empty').isVisible(), true);
    assert.equal(await host.locator('#localShare').isDisabled(), true);
    await player.screenshot({ path: path.join(out, 'player-empty-desktop.png'), fullPage: true });
    // Generate a synthetic local video in Chrome. No downloaded/user media needed.
    const producer = await context.newPage(); await producer.goto(`${origin}/player.html`);
    const base64 = await producer.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d');
      const videoStream = canvas.captureStream(24);
      const audioContext = new AudioContext(); await audioContext.resume();
      const oscillator = audioContext.createOscillator();
      const destination = audioContext.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start();
      const stream = new MediaStream([...videoStream.getTracks(), ...destination.stream.getTracks()]);
      const chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((resolve) => recorder.onstop = resolve);
      let frame = 0;
      const draw = () => { ctx.fillStyle = '#241b36'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#b890f8'; ctx.fillRect((frame++ * 5) % 600, 130, 40, 100); };
      draw(); const timer = setInterval(draw, 42); recorder.start();
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      recorder.stop(); await stopped; clearInterval(timer); stream.getTracks().forEach((track) => track.stop());
      oscillator.stop(); await audioContext.close();
      const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    });
    const videoPath = path.join(out, 'synthetic-test.webm'); fs.writeFileSync(videoPath, Buffer.from(base64, 'base64'));
    await producer.close();
    await player.locator('#localFile').setInputFiles(videoPath);
    await host.waitForFunction(() => globalThis.__test.state.playerState?.ready);
    assert.equal(await host.locator('#localShare').isEnabled(), true);
    assert.ok(await player.locator('#movie').evaluate((video) => video.duration > 10));
    await player.locator('#externalAudioFile').setInputFiles(videoPath);
    await player.waitForFunction(() => document.querySelector('#externalAudio').readyState >= 2);
    await player.evaluate(() => document.querySelector('#movie').currentTime = 5);
    await host.waitForFunction(() => Math.abs(__test.state.playerState.time - 5) < .2);
    await host.evaluate(() => Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: async () => {
      const canvas = document.createElement('canvas'); const stream = canvas.captureStream(1);
      Object.defineProperty(stream.getVideoTracks()[0], 'getSettings', { value: () => ({ displaySurface: 'browser' }) });
      return stream;
    }, configurable: true }));
    host.once('dialog', dialog => dialog.accept());
    await host.evaluate(() => __test.startBroadcast());
    await host.waitForFunction(() => __test.state.captionClock?.source === 'local-player' && Math.abs(__test.currentCaptionTime() - 5) < .2);
    // Mark the fixture preview/caption source as selected; actual OS chooser/network are not simulated as verified.
    await host.evaluate(() => {
      const { state, showHostPreview } = globalThis.__test;
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#241b36'; ctx.fillRect(0, 0, 640, 360);
      state.localStream = canvas.captureStream(1);
      state.localCaptureChannelId = state.playerChannelId;
      state.localCaptureVerified = false;
      showHostPreview(state.localStream);
    });
    await host.locator('#localPlayPause').click();
    await player.waitForFunction(() => !document.querySelector('#movie').paused);
    await player.waitForFunction(() => !document.querySelector('#externalAudio').paused);
    await host.waitForFunction(() => globalThis.__test.state.captionClock?.playing);
    await host.locator('#localPlayPause').click();
    await player.waitForFunction(() => document.querySelector('#movie').paused);
    await player.waitForFunction(() => document.querySelector('#externalAudio').paused);
    await host.waitForFunction(() => globalThis.__test.state.captionClock?.playing === false);
    const pausedTime = await host.evaluate(() => globalThis.__test.currentCaptionTime());
    await host.waitForTimeout(600);
    assert.ok(Math.abs(await host.evaluate(() => globalThis.__test.currentCaptionTime()) - pausedTime) < 0.1);
    await host.locator('#localSeek').fill('5');
    await host.locator('#localSeek').dispatchEvent('change');
    await player.waitForFunction(() => Math.abs(document.querySelector('#movie').currentTime - 5) < 0.1);
    await player.waitForFunction(() => Math.abs(document.querySelector('#externalAudio').currentTime - 5) < 0.2);
    await host.waitForFunction(() => Math.abs(globalThis.__test.currentCaptionTime() - 5) < 0.2);
    await player.evaluate(() => { document.querySelector('#movie').playbackRate = 1.5; });
    await host.waitForFunction(() => globalThis.__test.state.captionClock.rate === 1.5);
    await player.evaluate(() => {
      const video = document.querySelector('#movie');
      const track = video.addTextTrack('subtitles', 'Embedded English', 'en');
      track.addCue(new VTTCue(0, 12, 'EMBEDDED TEXT MUST BE HIDDEN')); track.mode = 'showing';
    });
    await player.waitForFunction(() => [...document.querySelector('#movie').textTracks].every((track) => track.mode === 'disabled'));
    await host.locator('#captionFile').setInputFiles([
      { name: 'film.en.srt', mimeType: 'application/x-subrip', buffer: Buffer.from('1\n00:00:00,000 --> 00:00:20,000\nEnglish room caption\n') },
      { name: 'film.ru.srt', mimeType: 'application/x-subrip', buffer: Buffer.from('1\n00:00:00,000 --> 00:00:20,000\nРусские субтитры\n') },
    ]);
    await host.waitForFunction(() => document.querySelector('#captionSelect').options.length === 3);
    const en = captions.find((item) => item.language === 'English').id;
    const ru = captions.find((item) => item.language === 'Русский').id;
    await host.locator('#captionSelect').selectOption(en);
    await host.waitForFunction(() => document.querySelector('#captionOverlay').textContent === 'English room caption');
    const viewerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const viewer = await viewerContext.newPage(); viewer.on('pageerror', (error) => errors.push(error.message));
    await join(viewer, 'viewer');
    await viewer.evaluate(() => {
      const canvas = document.createElement('canvas');
      document.querySelector('#remoteVideo').srcObject = canvas.captureStream(1);
      globalThis.__test.state.activeRoute = 'sfu';
      globalThis.__test.applyCaptionClock({ time: 5, playing: false, rate: 1.5, source: 'local-player' });
    });
    await viewer.locator('#captionSelect').selectOption(ru);
    await viewer.waitForFunction(() => document.querySelector('#captionOverlay').textContent === 'Русские субтитры');
    await player.evaluate(() => { document.querySelector('#movie').currentTime = 8; });
    await viewer.waitForFunction(() => __test.state.captionClock?.playing === false && Math.abs(__test.currentCaptionTime() - 8) < .15);
    await player.locator('#movie').evaluate(video => video.play());
    await viewer.waitForFunction(() => __test.state.captionClock?.playing === true);
    await player.locator('#movie').evaluate(video => video.pause());
    await viewer.waitForFunction(() => __test.state.captionClock?.playing === false);
    const viewerPaused = await viewer.evaluate(() => __test.currentCaptionTime());
    await viewer.waitForTimeout(400);
    assert.ok(Math.abs(await viewer.evaluate(() => __test.currentCaptionTime()) - viewerPaused) < .1);
    // Keep the real heartbeat at the same target as the artificial burst.
    // Otherwise an authoritative 8s source update correctly supersedes fake 9s.
    await player.evaluate(() => { document.querySelector('#movie').currentTime = 9; });
    await host.waitForFunction(() => Math.abs(__test.state.playerState.time - 9) < .1);
    await viewer.evaluate(() => __test.applyCaptionClock({ time: 0, playing: false, source: 'local-player', rate: 1 }));
    const sentBefore = clocks.length;
    await host.evaluate(() => { for (let i = 0; i < 100; i++) __test.publishCaptionClock(i / 10, true, 'local-player', true, 1); __test.publishCaptionClock(9, false, 'local-player', true, 1); });
    await viewer.waitForFunction(() => __test.state.captionClock?.playing === false && Math.abs(__test.currentCaptionTime() - 9) < .1);
    assert.ok(clocks.length - sentBefore <= 3, 'Clock events must coalesce and retain final pause');
    await host.evaluate(() => __test.publishCaptionClock(5, false, 'local-player', true, 1.5));
    assert.equal(await host.locator('#captionSelect').inputValue(), en);
    assert.equal(await viewer.locator('#localPlayback').isVisible(), false);
    assert.equal(await player.locator('#captionOverlay').count(), 0);
    await host.screenshot({ path: path.join(out, 'room-local-controls-desktop.png'), fullPage: true });
    await player.setViewportSize({ width: 390, height: 844 });
    await player.screenshot({ path: path.join(out, 'player-mobile.png'), fullPage: true });
    assert.equal(await player.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await host.setViewportSize({ width: 390, height: 844 });
    await host.screenshot({ path: path.join(out, 'room-local-controls-mobile.png'), fullPage: true });
    assert.equal(await host.evaluate(() => document.querySelector('#localPlayback').scrollWidth <= document.querySelector('#localPlayback').clientWidth), true);
    // A bad media file must show a format error, not the old popup error.
    await player.locator('#localFile').setInputFiles({ name: 'unsupported.mkv', mimeType: 'video/x-matroska', buffer: Buffer.from('not a media container') });
    await player.locator('#playerError').waitFor({ state: 'visible' });
    await host.waitForFunction(() => globalThis.__test.state.playerState.status === 'error');
    assert.equal(await host.locator('#localShare').isDisabled(), true);
    await player.close({ runBeforeUnload: true });
    // Browsers may discard unload-time messages. Heartbeat expiry must also
    // leave controls disabled; never rely on unload delivery for correctness.
    await host.waitForFunction(() => globalThis.__test.state.playerState.status === 'closed'
      || document.querySelector('#localPlayerStatus').textContent.includes('not responding'), { timeout: 15_000 });
    assert.deepEqual(errors, []);
    assert.ok(clocks.some((clock) => !clock.playing && Math.abs(clock.time - 5) < 0.2));
    assert.ok(clocks.some((clock) => clock.rate === 1.5));
    assert.equal(requests.some((item) => /synthetic-test|unsupported\.mkv|blob:/.test(item.pathname)), false);
    console.log(JSON.stringify({ result: 'PASS', browser: browser.version(), nativeTabOpenBeforeFilePicker: true,
      ownerSettingsSaveReloadPublicReset: true, settingsFailureRetainsDraft: true, settingsReadFailureBlocksSave: true, settingsMobileNoOverflow: true,
      neutralBranding: true, realLocalWebmPlayback: true, sidecarAudio: true, midMovieStart: true, viewerFollowsSourceClock: true,
      finalClockSurvivesEventBurst: true, roomPlayPauseSeekRate: true, textTracksDisabled: true, independentEnglishRussianCaptions: true,
      sourceContainsNoRoomCaptions: true, formatErrorReadable: true, mobileNoOverflow: true, movieUploadRequests: 0,
      actualCaptureChooserAndCrossCountryRoute: 'not tested', pageErrors: errors }, null, 2));
    await viewerContext.close();
  } finally {
    if (browser) await browser.close();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close(); await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
