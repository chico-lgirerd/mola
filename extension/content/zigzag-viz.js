// Mola visualizer for zig-zag.fm (top frame). Receives audio frames from the
// YouTube embed tap (content/youtube-tap.js) and draws them on a canvas,
// mirroring src/render.c. Depends on lib/mola-core.js (globalThis.MolaCore).
// The canvas lives in a draggable, resizable floating window styled after the
// site's own island / artist windows.
(function () {
  'use strict';

  if (window.top !== window) return;
  if (globalThis.__molaZigzagViz) return;
  globalThis.__molaZigzagViz = true;

  const Core = globalThis.MolaCore;
  if (!Core) return;

  // After an add-on reload, the previous instance's DOM is left behind in the page
  // with dead handlers (can't move or close). Remove it before building ours.
  const MARK = 'data-mola-viz';
  for (const el of document.querySelectorAll('[' + MARK + ']')) el.remove();

  const api = globalThis.browser ?? globalThis.chrome;
  const YT_ORIGIN = 'https://www.youtube.com';
  const STALE_MS = 1000;
  const WIN_KEY = 'molaWindow';
  const WIN_MIN_W = 240, WIN_MIN_H = 110, TITLE_H = 28;
  const WIN_DEFAULT = { w: 420, h: 170 };
  const IFRAME_SEL = 'iframe[src*="youtube.com/embed"], iframe#youtube-player';

  // ---- storage helper ----
  // MV3: browser.* (Firefox) and chrome.* both return a promise when no
  // callback is passed; Firefox's browser.* rejects extra callback arguments.
  function storageCall(area, method, arg) {
    try {
      return Promise.resolve(api.storage[area][method](arg)).catch(() => undefined);
    } catch (e) {
      return Promise.resolve(undefined);
    }
  }
  const storageGet = () => storageCall('sync', 'get', Core.SETTINGS_KEY);
  const storageSet = (obj) => storageCall('sync', 'set', obj);
  const winGet = () => storageCall('local', 'get', WIN_KEY);
  const winSet = (obj) => storageCall('local', 'set', obj);

  // ---- state ----
  let settings = Core.sanitizeSettings({});
  let host = null, shadow = null, canvas = null, ctx = null, body = null;
  let modeBtn = null, gradBtn = null;
  let cssW = 0, cssH = 0, dpr = 1;
  let win = null; // {x, y, w, h} in CSS px, viewport coordinates
  let resizeObs = null, rafId = 0;
  let playing = false, lastFrameAt = 0, lastDrawAt = 0;
  let reduceMotion = false;

  let ranges = null, rangeKey = '';
  let smoothed = new Float32Array(0);
  let magnitudes = new Float32Array(0);
  let wave = new Float32Array(0);

  // ---- window geometry ----
  function sanitizeWin(o) {
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    const w = num(o && o.w), h = num(o && o.h), x = num(o && o.x), y = num(o && o.y);
    const out = {
      w: w === null ? WIN_DEFAULT.w : w,
      h: h === null ? WIN_DEFAULT.h : h,
      x: x,
      y: y
    };
    return clampWin(out);
  }

  function clampWin(g) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.round(Math.min(Math.max(g.w, WIN_MIN_W), Math.max(WIN_MIN_W, vw)));
    const h = Math.round(Math.min(Math.max(g.h, WIN_MIN_H), Math.max(WIN_MIN_H, vh)));
    // Default spot: bottom centre, clear of the player bar.
    let x = g.x === null || g.x === undefined ? Math.round((vw - w) / 2) : g.x;
    let y = g.y === null || g.y === undefined ? vh - h - 110 : g.y;
    x = Math.round(Math.min(Math.max(x, 0), Math.max(0, vw - w)));
    y = Math.round(Math.min(Math.max(y, 0), Math.max(0, vh - h)));
    return { x: x, y: y, w: w, h: h };
  }

  function applyGeometry() {
    if (!host) return;
    if (!win) win = clampWin({ w: WIN_DEFAULT.w, h: WIN_DEFAULT.h, x: null, y: null });
    host.style.left = win.x + 'px';
    host.style.top = win.y + 'px';
    host.style.width = win.w + 'px';
    host.style.height = win.h + 'px';
  }

  function saveWin() {
    if (win) winSet({ [WIN_KEY]: win });
  }

  // ---- DOM ----
  function styleEl(text) {
    const s = document.createElement('style');
    s.textContent = text;
    return s;
  }

  function makeButton(label, text) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    if (text) b.textContent = text;
    const stop = (e) => e.stopPropagation();
    b.addEventListener('pointerdown', stop);
    b.addEventListener('keydown', stop);
    return b;
  }

  // Drag helper: pointer-capture on `el`, calls onMove(dx, dy) from the start point.
  function dragHandle(el, onStart, onMove, onEnd) {
    let id = null, sx = 0, sy = 0;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      id = e.pointerId;
      sx = e.clientX; sy = e.clientY;
      el.setPointerCapture(id);
      onStart();
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      onMove(e.clientX - sx, e.clientY - sy);
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      onEnd();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function createHost() {
    if (host) return;
    host = document.createElement('div');
    host.setAttribute(MARK, 'window');
    host.style.cssText =
      'position:fixed;z-index:40;margin:0;padding:0;border:0;display:block;';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.appendChild(styleEl(
      ':host{all:initial}' +
      '.win{position:absolute;inset:0;display:flex;flex-direction:column;box-sizing:border-box;' +
      'background:#000;border:1px solid rgba(255,255,255,.15);color:#fff;overflow:hidden;' +
      'font:12px Roboto,system-ui,-apple-system,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.6)}' +
      '.title{flex:none;height:' + TITLE_H + 'px;display:flex;align-items:center;gap:6px;' +
      'padding:0 6px 0 10px;background:#000;cursor:move;user-select:none;-webkit-user-select:none;touch-action:none}' +
      '.name{flex:1;min-width:0;font:13px Dico,Roboto,system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.body{position:relative;flex:1;min-height:0}' +
      'canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block}' +
      '.grip{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;touch-action:none;' +
      'background:linear-gradient(135deg,transparent 55%,rgba(255,255,255,.35) 55%)}' +
      'button{font:11px/1 Roboto,system-ui,sans-serif;color:rgba(255,255,255,.75);background:transparent;' +
      'border:1px solid rgba(255,255,255,.15);border-radius:3px;padding:3px 6px;cursor:pointer}' +
      'button:hover,button:focus-visible{color:#fff;border-color:rgba(255,255,255,.4)}' +
      '.close{border-color:transparent;font-size:14px;padding:2px 6px}'
    ));

    const winEl = document.createElement('div');
    winEl.className = 'win';

    const title = document.createElement('div');
    title.className = 'title';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = 'visualizer';
    modeBtn = makeButton('Change visualizer mode');
    gradBtn = makeButton('Change visualizer color gradient');
    const closeBtn = makeButton('Close window', '×');
    closeBtn.className = 'close';
    modeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      persist({ mode: Core.nextMode(settings.mode) });
    });
    gradBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = Core.GRADIENTS.length;
      const i = Core.gradientIndex(settings.gradient);
      persist({ gradient: Core.GRADIENTS[(Math.max(i, 0) + 1) % n].name });
    });
    // Closing disables the visualizer; the popup toggle brings it back.
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      persist({ enabled: false });
    });
    title.append(name, modeBtn, gradBtn, closeBtn);

    body = document.createElement('div');
    body.className = 'body';
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d');
    body.appendChild(canvas);

    const grip = document.createElement('div');
    grip.className = 'grip';
    body.appendChild(grip);

    winEl.append(title, body);
    shadow.appendChild(winEl);

    let start = null;
    dragHandle(title,
      () => { start = { x: win.x, y: win.y }; },
      (dx, dy) => {
        win = clampWin({ x: start.x + dx, y: start.y + dy, w: win.w, h: win.h });
        applyGeometry();
      },
      saveWin);
    dragHandle(grip,
      () => { start = { w: win.w, h: win.h }; },
      (dx, dy) => {
        win = clampWin({ x: win.x, y: win.y, w: start.w + dx, h: start.h + dy });
        applyGeometry();
      },
      saveWin);

    (document.body || document.documentElement).appendChild(host);
    updateLabels();
    applyGeometry();

    if (typeof ResizeObserver === 'function') {
      resizeObs = new ResizeObserver(resizeCanvas);
      resizeObs.observe(body);
    }
    resizeCanvas();
  }

  function removeHost() {
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    if (host) host.remove();
    host = shadow = canvas = ctx = body = modeBtn = gradBtn = null;
  }

  function updateLabels() {
    if (!modeBtn) return;
    modeBtn.textContent = settings.mode;
    const g = Core.GRADIENTS[Core.gradientIndex(settings.gradient)];
    gradBtn.textContent = g ? g.name : String(settings.gradient);
  }

  function resizeCanvas() {
    if (!canvas || !body) return;
    dpr = window.devicePixelRatio || 1;
    cssW = Math.max(1, Math.floor(body.clientWidth));
    cssH = Math.max(1, Math.floor(body.clientHeight));
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    draw();
  }

  // ---- toggle button (sits under the site's Notifications button) ----
  const NOTIF_SEL = 'button[aria-label="Notifications"]';
  const TOGGLE = 30;
  let toggleHost = null, toggleBtn = null;

  function createToggle() {
    if (toggleHost) return;
    toggleHost = document.createElement('div');
    toggleHost.setAttribute(MARK, 'toggle');
    toggleHost.style.cssText =
      'position:fixed;z-index:40;margin:0;padding:0;border:0;right:12px;top:56px;' +
      'width:' + TOGGLE + 'px;height:' + TOGGLE + 'px;';
    const sh = toggleHost.attachShadow({ mode: 'closed' });
    sh.appendChild(styleEl(
      ':host{all:initial}' +
      'button{all:unset;box-sizing:border-box;width:100%;height:100%;display:flex;align-items:center;' +
      'justify-content:center;cursor:pointer;opacity:.6;transition:opacity .15s}' +
      'button:hover,button:focus-visible,button[aria-pressed=true]{opacity:1}' +
      'svg{width:18px;height:18px;fill:#fff}'
    ));
    toggleBtn = makeButton('Toggle visualizer');
    toggleBtn.title = 'Visualizer';
    toggleBtn.innerHTML =
      '<svg viewBox="0 0 18 18" aria-hidden="true">' +
      '<rect x="1" y="9" width="2.5" height="8"/><rect x="5" y="3" width="2.5" height="14"/>' +
      '<rect x="9" y="6" width="2.5" height="11"/><rect x="13" y="1" width="2.5" height="16"/></svg>';
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      persist({ enabled: !settings.enabled });
    });
    sh.appendChild(toggleBtn);
    (document.body || document.documentElement).appendChild(toggleHost);
    updateToggle();
    positionToggle();
    setInterval(positionToggle, 500);
  }

  function updateToggle() {
    if (toggleBtn) toggleBtn.setAttribute('aria-pressed', String(!!settings.enabled));
  }

  // Align to the Notifications button's right edge, just below it. If the site
  // markup changes and it is not found, the fixed top-right fallback is kept.
  function positionToggle() {
    if (!toggleHost) return;
    const n = document.querySelector(NOTIF_SEL);
    const r = n && n.getBoundingClientRect();
    if (!r || !r.width) return;
    toggleHost.style.right = 'auto';
    toggleHost.style.left = Math.round(r.right - TOGGLE) + 'px';
    toggleHost.style.top = Math.round(r.bottom + 6) + 'px';
  }

  // ---- settings ----
  async function persist(patch) {
    const stored = await storageGet();
    const base = Core.sanitizeSettings((stored && stored[Core.SETTINGS_KEY]) || settings);
    const next = Core.sanitizeSettings(Object.assign({}, base, patch));
    await storageSet({ [Core.SETTINGS_KEY]: next });
    applySettings(next); // also applied via onChanged; harmless twice
  }

  function applySettings(next) {
    settings = Core.sanitizeSettings(next);
    updateToggle();
    if (!settings.enabled) {
      cancelAnimationFrame(rafId);
      rafId = 0;
      removeHost();
      return;
    }
    createHost();
    updateLabels();
    draw();
    if (playing && performance.now() - lastFrameAt <= STALE_MS) startLoop();
  }

  // ---- incoming frames ----
  function isYoutubeFrame(source) {
    if (!source) return false;
    for (const f of document.querySelectorAll(IFRAME_SEL)) {
      if (f.contentWindow === source) return true;
    }
    return false;
  }

  function onMessage(event) {
    if (!settings.enabled) return;
    if (event.origin !== YT_ORIGIN) return;
    if (!isYoutubeFrame(event.source)) return;
    const d = event.data;
    if (!d || typeof d !== 'object') return;

    if (Core.isValidFrame(d) && d.kind === 'frame') {
      onFrame(d);
    } else if (d.type === Core.MSG_TYPE && d.kind === 'state' && d.playing === false) {
      idle();
    }
  }

  function onFrame(d) {
    const bars = settings.bars;
    const key = bars + ':' + d.fftSize + ':' + d.sampleRate;
    if (key !== rangeKey || !ranges) {
      ranges = Core.buildBarRanges(bars, d.fftSize, d.sampleRate, Core.MIN_FREQ, Core.maxFreqFor(d.sampleRate));
      rangeKey = key;
      smoothed = new Float32Array(ranges.count);
    }
    if (magnitudes.length !== d.spectrum.length) magnitudes = new Float32Array(d.spectrum.length);
    Core.dbToMolaMagnitudes(d.spectrum, magnitudes);
    Core.updateBars(ranges, smoothed, magnitudes, settings.sensitivity, Core.ATTACK, Core.RELEASE);
    wave = d.wave;

    playing = true;
    lastFrameAt = performance.now();
    startLoop();
  }

  // ---- loop ----
  // The window stays on screen while enabled; with no audio it just shows empty.
  function idle() {
    playing = false;
    cancelAnimationFrame(rafId);
    rafId = 0;
    smoothed.fill(0);
    wave = new Float32Array(0);
    draw();
  }

  function startLoop() {
    if (!rafId && host) {
      rafId = requestAnimationFrame(tick);
    }
  }

  function tick(now) {
    rafId = 0;
    if (!host) return;
    if (!playing || performance.now() - lastFrameAt > STALE_MS) { idle(); return; }
    if (!reduceMotion || now - lastDrawAt >= 100) {
      lastDrawAt = now;
      draw();
    }
    rafId = requestAnimationFrame(tick);
  }

  // ---- drawing (mirrors src/render.c) ----
  const rgb = (c) => 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';

  function draw() {
    if (!ctx) return;
    const w = cssW, h = cssH;
    const grad = Core.GRADIENTS[Math.max(Core.gradientIndex(settings.gradient), 0)];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgb(' + Core.BG_COLOR[0] + ',' + Core.BG_COLOR[1] + ',' + Core.BG_COLOR[2] + ')';
    ctx.fillRect(0, 0, w, h);

    if (settings.mode === 'wave') drawWave(w, h, grad);
    else if (settings.mode === 'bezier') drawBezier(w, h, grad);
    else drawBars(w, h, grad);
  }

  function drawBars(w, h, grad) {
    for (const r of Core.barRects(smoothed, w, h)) {
      ctx.fillStyle = rgb(Core.lerpColor(grad, r.v));
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
  }

  function drawWave(w, h, grad) {
    if (!wave || wave.length < 2) return;
    const pts = Core.waveformPoints(wave, w, h);
    if (pts.length < 4) return;
    ctx.strokeStyle = 'rgb(' + grad.hi[0] + ',' + grad.hi[1] + ',' + grad.hi[2] + ')';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.stroke();
  }

  function drawBezier(w, h, grad) {
    if (smoothed.length < 2) return;
    const curve = Core.bezierCurve(smoothed, w, h);
    const n = Math.min(curve.length, w);
    const cols = new Array(n);
    for (let x = 0; x < n; x++) {
      const c = Core.lerpColor(grad, Core.bezierLevel(curve[x], h));
      cols[x] = c;
      ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (90 / 255) + ')';
      ctx.fillRect(x, curve[x], 1, h - curve[x]);
    }
    // 2px line segments, batched per run of identical color
    ctx.lineWidth = 2;
    let runColor = null;
    for (let x = 1; x < n; x++) {
      const c = rgb(cols[x]);
      if (c !== runColor) {
        if (runColor !== null) ctx.stroke();
        ctx.beginPath();
        ctx.strokeStyle = c;
        runColor = c;
      }
      ctx.moveTo(x - 1, curve[x - 1]);
      ctx.lineTo(x, curve[x]);
    }
    if (runColor !== null) ctx.stroke();
  }

  // ---- init ----
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  if (mq) {
    reduceMotion = mq.matches;
    mq.addEventListener('change', (e) => { reduceMotion = e.matches; });
  }

  window.addEventListener('message', onMessage);
  window.addEventListener('resize', () => {
    if (win) win = clampWin(win);
    applyGeometry();
    positionToggle();
  });
  createToggle();

  try {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes || !changes[Core.SETTINGS_KEY]) return;
      applySettings((changes[Core.SETTINGS_KEY].newValue) || {});
    });
  } catch (e) { /* storage unavailable: run with defaults */ }

  Promise.all([winGet(), storageGet()]).then(([w, s]) => {
    win = sanitizeWin(w && w[WIN_KEY]);
    applySettings((s && s[Core.SETTINGS_KEY]) || {});
  });
})();
