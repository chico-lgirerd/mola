'use strict';
(function () {
  const api = globalThis.browser ?? globalThis.chrome;
  const Core = globalThis.MolaCore;
  const KEY = Core.SETTINGS_KEY;
  const $ = (id) => document.getElementById(id);

  const MODE_LABELS = { bars: 'Bars', wave: 'Waveform', bezier: 'Bezier wave' };
  const S_MIN = 0.005, S_MAX = 1, SL_MAX = 1000;

  const sensToSlider = (v) => Math.round(Math.log(v / S_MIN) / Math.log(S_MAX / S_MIN) * SL_MAX);
  const sliderToSens = (p) => S_MIN * Math.pow(S_MAX / S_MIN, p / SL_MAX);
  const fmtSens = (v) => (v < 0.1 ? v.toFixed(3) : v.toFixed(2));

  let state = Core.sanitizeSettings(Core.DEFAULTS);
  let timer = null;

  // MV3 storage returns promises in both Firefox (browser.*) and Chrome (chrome.*)
  // when no callback is passed; Firefox's browser.* rejects extra callback args.
  function storageGet(key) {
    try {
      return Promise.resolve(api.storage.sync.get(key)).then((r) => (r ? r[key] : undefined), () => undefined);
    } catch (e) { return Promise.resolve(undefined); }
  }

  function storageSet(obj) {
    try {
      Promise.resolve(api.storage.sync.set(obj)).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  function save() {
    clearTimeout(timer);
    timer = null;
    state = Core.sanitizeSettings(state);
    storageSet({ [KEY]: state });
  }
  function saveSoon() {
    clearTimeout(timer);
    timer = setTimeout(save, 150);
  }

  function fillSelect(sel, values, labels) {
    for (const v of values) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = labels[v] || v;
      sel.appendChild(o);
    }
  }

  function buildGradients() {
    const box = $('gradient');
    Core.GRADIENTS.forEach((g) => {
      const label = document.createElement('label');
      label.title = g.name;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'gradient';
      input.value = g.name;
      input.setAttribute('aria-label', g.name);
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = 'linear-gradient(to right, rgb(' + g.lo.join(',') + '), rgb(' + g.hi.join(',') + '))';
      label.append(input, sw);
      box.appendChild(label);
      input.addEventListener('change', () => { if (input.checked) { state.gradient = g.name; save(); } });
    });
  }

  function render() {
    $('enabled').checked = !!state.enabled;
    $('mode').value = state.mode;
    $('bars').value = state.bars;
    $('bars-out').textContent = state.bars;
    $('sensitivity').value = sensToSlider(state.sensitivity);
    $('sensitivity-out').textContent = fmtSens(state.sensitivity);
    for (const r of document.querySelectorAll('input[name=gradient]')) r.checked = r.value === state.gradient;
  }

  async function init() {
    fillSelect($('mode'), Core.MODES, MODE_LABELS);
    buildGradients();

    $('enabled').addEventListener('change', (e) => { state.enabled = e.target.checked; save(); });
    $('mode').addEventListener('change', (e) => { state.mode = e.target.value; save(); });
    $('bars').addEventListener('input', (e) => {
      state.bars = parseInt(e.target.value, 10);
      $('bars-out').textContent = state.bars;
      saveSoon();
    });
    $('sensitivity').addEventListener('input', (e) => {
      state.sensitivity = sliderToSens(Number(e.target.value));
      $('sensitivity-out').textContent = fmtSens(state.sensitivity);
      saveSoon();
    });
    $('reset').addEventListener('click', () => {
      state = Core.sanitizeSettings(Object.assign({}, Core.DEFAULTS));
      render();
      save();
    });

    const stored = await storageGet(KEY);
    state = Core.sanitizeSettings(stored && typeof stored === 'object' ? stored : Core.DEFAULTS);
    render();
  }

  init();
})();
