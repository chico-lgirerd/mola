// Mola audio tap: runs inside the YouTube embed frame, taps the <video> audio
// through an AnalyserNode and posts spectrum/wave frames to the zig-zag.fm parent.
(() => {
  'use strict';
  if (window.__molaTapInstalled) return;
  window.__molaTapInstalled = true;

  const PARENT_ORIGIN = 'https://www.zig-zag.fm';
  if (new URLSearchParams(location.search).get('origin') !== PARENT_ORIGIN) return;
  if (window.parent === window) return;

  const { MSG_TYPE, MSG_VERSION, WAVE_POINTS, SETTINGS_KEY, sanitizeSettings, decimate } =
    globalThis.MolaCore;
  const api = globalThis.browser ?? globalThis.chrome;
  const FFT_SIZE = 8192;
  const TICK_MS = 16;

  let enabled = false;
  let ctx = null;
  let analyser = null;
  let spec = null;
  let time = null;
  let current = null;       // video currently tracked
  let timer = null;
  let posting = false;      // true after a playing frame stream started
  let connecting = false;
  const seen = new WeakSet();
  const sources = new WeakMap();   // video -> MediaElementAudioSourceNode
  const failed = new WeakSet();    // videos where createMediaElementSource threw

  // MV3: both browser.* (Firefox) and chrome.* return a promise when no
  // callback is passed (Firefox rejects extra callback arguments).
  function storageGet(key) {
    try {
      return Promise.resolve(api.storage.sync.get(key)).catch(() => undefined);
    } catch (e) { return Promise.resolve(undefined); }
  }

  const isPlaying = (v) => !!v && !v.paused && !v.ended;

  function applySettings(raw) {
    let s;
    try { s = sanitizeSettings(raw); } catch (e) { return; }
    setEnabled(!!(s && s.enabled));
  }

  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    if (!enabled) {
      stopLoop(); // audio graph (if any) keeps passing audio through
    } else if (isPlaying(current)) {
      connect(current);
      startLoop();
    }
  }

  function post(msg) {
    try { window.parent.postMessage({ type: MSG_TYPE, v: MSG_VERSION, ...msg }, PARENT_ORIGIN); }
    catch (e) { /* parent gone */ }
  }

  function stopLoop() {
    if (timer !== null) { clearInterval(timer); timer = null; }
    if (posting) { posting = false; post({ kind: 'state', playing: false }); }
  }

  function startLoop() {
    if (timer !== null || !enabled || !analyser || !isPlaying(current)) return;
    if (!sources.has(current)) return; // not connected yet
    posting = true;
    // setInterval, not rAF: hidden/faded iframes throttle rAF.
    timer = setInterval(tick, TICK_MS);
  }

  function tick() {
    if (!enabled || !isPlaying(current)) { stopLoop(); return; }
    analyser.getFloatFrequencyData(spec);
    analyser.getFloatTimeDomainData(time);
    const wave = new Float32Array(WAVE_POINTS);
    decimate(time, WAVE_POINTS, wave);
    post({
      kind: 'frame', playing: true, sampleRate: ctx.sampleRate, fftSize: FFT_SIZE,
      spectrum: new Float32Array(spec), // copy: spec is reused every tick
      wave,
    });
  }

  // Feed the analyser from video.captureStream(). The captured stream's audio
  // tracks come and go (new MSE source on every track change), so re-attach on
  // each addtrack. No audio track yet just means no viz yet; playback is untouched.
  function tapCaptured(video, capture) {
    const stream = capture.call(video);
    let node = null;
    const attach = () => {
      const tracks = stream.getAudioTracks().filter((t) => t.readyState === 'live');
      if (!tracks.length) return;
      if (node) { try { node.disconnect(); } catch (e) { /* already gone */ } }
      node = ctx.createMediaStreamSource(new MediaStream(tracks));
      node.connect(analyser);
    };
    stream.addEventListener('addtrack', attach);
    attach();
    return stream;
  }

  // Create the context / source only when the context is truly running:
  // routing a media element through a suspended context mutes it.
  async function connect(video) {
    if (!enabled || connecting || sources.has(video) || failed.has(video)) return;
    connecting = true;
    try {
      if (!ctx) {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        ctx.addEventListener('statechange', () => {
          if (ctx.state === 'suspended' && isPlaying(current)) ctx.resume().catch(() => {});
        });
      }
      if (ctx.state !== 'running') {
        // Chrome keeps resume() pending (never rejects) until autoplay is
        // allowed, so cap the wait or `connecting` would stay stuck forever.
        try {
          await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
        } catch (e) { /* needs a user gesture */ }
      }
      if (ctx.state !== 'running') return; // retry on next play / pointerdown / keydown
      if (!enabled || sources.has(video)) return;
      try {
        // Preferred: tap a captured copy of the element's audio. The element keeps
        // playing through its own output, so engaging/disengaging the tap (e.g. when
        // the add-on reloads) never changes what you hear. The analyser is then a
        // dead end. Fallback: reroute the element through the graph.
        if (!analyser) {
          analyser = ctx.createAnalyser();
          analyser.fftSize = FFT_SIZE;
          analyser.smoothingTimeConstant = 0;
          spec = new Float32Array(FFT_SIZE / 2);
          time = new Float32Array(FFT_SIZE);
        }
        const capture = video.captureStream || video.mozCaptureStream;
        let src = null;
        let viaCapture = false;
        if (typeof capture === 'function') {
          try {
            src = tapCaptured(video, capture);
            viaCapture = true;
          } catch (e) {
            console.warn('mola: captureStream failed, falling back to reroute', e && e.name, e && e.message);
          }
        }
        if (!viaCapture) {
          src = ctx.createMediaElementSource(video);
          src.connect(analyser);
          analyser.connect(ctx.destination);
        }
        sources.set(video, src);
        // Diagnostics for level changes when the tap engages (see README).
        console.info('mola: tap connected', {
          volume: video.volume, muted: video.muted, t: video.currentTime,
          via: viaCapture ? 'captureStream' : 'mediaElementSource',
          ctxRate: ctx.sampleRate, ctxState: ctx.state,
        });
        video.addEventListener('volumechange', () => {
          console.info('mola: volumechange', { volume: video.volume, muted: video.muted });
        });
      } catch (e) {
        failed.add(video);
        console.warn('mola: audio tap failed', e && e.name, e && e.message);
        return;
      }
    } finally {
      connecting = false;
    }
    if (video === current && isPlaying(video)) startLoop();
  }

  function onPlay(e) {
    current = e.target;
    if (!enabled) return;
    connect(current);
    startLoop();
  }

  function onStop(e) {
    if (e.target === current) stopLoop();
  }

  function attach(video) {
    if (seen.has(video)) return;
    seen.add(video);
    for (const t of ['play', 'playing']) video.addEventListener(t, onPlay);
    for (const t of ['pause', 'ended']) video.addEventListener(t, onStop);
    if (isPlaying(video)) onPlay({ target: video });
  }

  function scan() {
    const v = document.querySelector('video');
    if (!v) return;
    if (current && current !== v) { stopLoop(); current = v; }
    if (!current) current = v;
    attach(v);
  }

  // Gesture fallback when the AudioContext could not start on play.
  const retry = () => {
    if (enabled && isPlaying(current)) connect(current);
  };
  window.addEventListener('pointerdown', retry, { capture: true, passive: true });
  window.addEventListener('keydown', retry, { capture: true, passive: true });

  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();

  try {
    api.storage.onChanged.addListener((changes, area) => {
      if (area && area !== 'sync') return;
      if (changes && changes[SETTINGS_KEY]) applySettings(changes[SETTINGS_KEY].newValue);
    });
  } catch (e) { /* storage unavailable */ }

  storageGet(SETTINGS_KEY).then((res) => applySettings(res && res[SETTINGS_KEY]));
})();
