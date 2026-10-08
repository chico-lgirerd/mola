// Mola visualizer for zig-zag.fm (top frame). Receives audio frames from the
// YouTube embed tap (content/youtube-tap.js) and draws them on a canvas,
// mirroring src/render.c. Depends on lib/mola-core.js (globalThis.MolaCore).
(function () {
  'use strict';

  if (window.top !== window) return;
  if (globalThis.__molaZigzagViz) return;
  globalThis.__molaZigzagViz = true;

  const Core = globalThis.MolaCore;
  if (!Core) return;

  const api = globalThis.browser ?? globalThis.chrome;
  const YT_ORIGIN = 'https://www.youtube.com';
  const STRIP_H = 72;
  const STALE_MS = 1000;
  const SLIDER_SEL = '[role="slider"][aria-label="Playback position"]';
  const IFRAME_SEL = 'iframe[src*="youtube.com/embed"], iframe#youtube-player';

  // ---- storage helper ----
  // MV3: browser.* (Firefox) and chrome.* both return a promise when no
  // callback is passed; Firefox's browser.* rejects extra callback arguments.
  function storageCall(method, arg) {
    try {
      return Promise.resolve(api.storage.sync[method](arg)).catch(() => undefined);
    } catch (e) {
      return Promise.resolve(undefined);
    }
  }
  const storageGet = () => storageCall('get', Core.SETTINGS_KEY);
  const storageSet = (obj) => storageCall('set', obj);

  // ---- state ----
  let settings = Core.sanitizeSettings({});
  let host = null, shadow = null, canvas = null, ctx = null;
  let modeBtn = null, gradBtn = null;
  let cssW = 0, cssH = STRIP_H, dpr = 1;
  let resizeObs = null, mountTimer = 0, rafId = 0;
  let visible = false, playing = false, lastFrameAt = 0, lastDrawAt = 0;
  let reduceMotion = false;

  let ranges = null, rangeKey = '';
  let smoothed = new Float32Array(0);
  let magnitudes = new Float32Array(0);
  let wave = new Float32Array(0);

  // ---- DOM ----
  function styleEl(text) {
    const s = document.createElement('style');
    s.textContent = text;
    return s;
  }

  function makeButton(label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    const stop = (e) => e.stopPropagation();
    b.addEventListener('pointerdown', stop);
    b.addEventListener('keydown', stop);
    return b;
  }

  function createHost() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText =
      'position:fixed;left:0;right:0;height:' + STRIP_H + 'px;z-index:20;' +
      'pointer-events:none;display:none;margin:0;padding:0;border:0;';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.appendChild(styleEl(
      ':host{all:initial}' +
      'canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block}' +
      '.chip{position:absolute;top:4px;right:8px;display:flex;gap:4px;pointer-events:auto}' +
      'button{font:11px/1 Roboto,system-ui,sans-serif;color:rgba(255,255,255,.75);' +
      'background:rgba(8,8,14,.55);border:1px solid rgba(255,255,255,.15);' +
      'border-radius:3px;padding:3px 6px;cursor:pointer;opacity:.55}' +
      'button:hover,button:focus-visible{opacity:1;color:#fff}'
    ));
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d');
    shadow.appendChild(canvas);

    const chip = document.createElement('div');
    chip.className = 'chip';
    modeBtn = makeButton('Change visualizer mode');
    gradBtn = makeButton('Change visualizer color gradient');
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
    chip.appendChild(modeBtn);
    chip.appendChild(gradBtn);
    shadow.appendChild(chip);

    (document.body || document.documentElement).appendChild(host);
    updateLabels();

    if (typeof ResizeObserver === 'function') {
      resizeObs = new ResizeObserver(resizeCanvas);
      resizeObs.observe(host);
    }
    resizeCanvas();
    applyMount();
  }

  function removeHost() {
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    if (host) host.remove();
    host = shadow = canvas = ctx = modeBtn = gradBtn = null;
    visible = false;
  }

  function updateLabels() {
    if (!modeBtn) return;
    modeBtn.textContent = settings.mode;
    const g = Core.GRADIENTS[Core.gradientIndex(settings.gradient)];
    gradBtn.textContent = g ? g.name : String(settings.gradient);
  }

  function resizeCanvas() {
    if (!canvas || !host) return;
    dpr = window.devicePixelRatio || 1;
    cssW = Math.max(1, Math.floor(host.clientWidth || window.innerWidth));
    cssH = STRIP_H;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    if (visible) draw();
  }

  // ---- mount ----
  function findAboveBarTop() {
    const slider = document.querySelector(SLIDER_SEL);
    if (!slider) return null;
    let el = slider.parentElement;
    while (el && el !== document.documentElement) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') return el.getBoundingClientRect().top;
      el = el.parentElement;
    }
    el = slider.parentElement;
    while (el && el !== document.documentElement) {
      if (Math.abs(el.getBoundingClientRect().bottom - window.innerHeight) <= 4) {
        return el.getBoundingClientRect().top;
      }
      el = el.parentElement;
    }
    return null;
  }

  function applyMount() {
    if (!host) return;
    let mount = settings.mount;
    let top = null;
    if (mount === 'above-bar') {
      top = findAboveBarTop();
      if (top === null) mount = 'bottom';
    }
    if (mount === 'top') {
      host.style.top = '0'; host.style.bottom = 'auto';
    } else if (mount === 'above-bar') {
      host.style.top = 'auto';
      host.style.bottom = Math.max(0, Math.round(window.innerHeight - top)) + 'px';
    } else {
      host.style.top = 'auto'; host.style.bottom = '0';
    }
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
    clearInterval(mountTimer);
    mountTimer = 0;
    if (!settings.enabled) {
      cancelAnimationFrame(rafId);
      rafId = 0;
      removeHost();
      return;
    }
    createHost();
    updateLabels();
    applyMount();
    mountTimer = setInterval(applyMount, 1000);
    if (visible) { startLoop(); }
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
      playing = false;
      hide();
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
    if (!visible) show();
  }

  // ---- visibility / loop ----
  function show() {
    if (!host) return;
    visible = true;
    host.style.display = 'block';
    resizeCanvas();
    startLoop();
  }

  function hide() {
    visible = false;
    cancelAnimationFrame(rafId);
    rafId = 0;
    if (host) host.style.display = 'none';
  }

  function startLoop() {
    if (!rafId && visible) rafId = requestAnimationFrame(tick);
  }

  function tick(now) {
    rafId = 0;
    if (!visible || !host) return;
    if (!playing || performance.now() - lastFrameAt > STALE_MS) { hide(); return; }
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
    ctx.fillStyle = 'rgba(' + Core.BG_COLOR[0] + ',' + Core.BG_COLOR[1] + ',' + Core.BG_COLOR[2] + ',0.85)';
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
  window.addEventListener('resize', () => { resizeCanvas(); applyMount(); });

  try {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes || !changes[Core.SETTINGS_KEY]) return;
      applySettings((changes[Core.SETTINGS_KEY].newValue) || {});
    });
  } catch (e) { /* storage unavailable: run with defaults */ }

  storageGet().then((stored) => {
    applySettings((stored && stored[Core.SETTINGS_KEY]) || {});
  });
})();
