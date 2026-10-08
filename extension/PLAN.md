# Mola for zig-zag.fm — WebExtension plan

Goal: a Manifest V3 WebExtension (Firefox first, also loads in Chrome) that draws a
real mola-style visualizer on https://www.zig-zag.fm, fed by the actual audio of the
YouTube embed the site plays through.

## File layout

```
extension/
  manifest.json            MV3, gecko id, 2 content scripts, popup, storage permission
  lib/mola-core.js         pure port of src/*.c math (no DOM); globalThis.MolaCore + module.exports
  content/youtube-tap.js   [A] runs in youtube.com/embed/* frames: <video> -> AnalyserNode -> postMessage
  content/zigzag-viz.js    [B] runs on zig-zag.fm top frame: receives frames, draws on <canvas>
  popup/popup.{html,js,css} settings UI (storage.sync)
  icons/icon-{48,96}.png
  tests/*.test.js          node --test, no deps
  scripts/package.sh       npx web-ext lint/build
  package.json             "test": "node --test tests/"  (no dependencies)
  README.md                install, manual test steps, limits
```

Both content scripts load `lib/mola-core.js` first (listed before them in the
manifest `js` array). The popup loads it via `<script>`.

## Message protocol (iframe -> top frame)

Sender A: `window.parent.postMessage(msg, 'https://www.zig-zag.fm')` (targetOrigin
pinned, so nothing is delivered if the parent is any other site).

```
{ type: 'zz-viz', v: 1, kind: 'frame',
  playing: true,
  sampleRate: <AudioContext.sampleRate>,
  fftSize: <analyser.fftSize>,
  spectrum: Float32Array(fftSize/2)   // analyser.getFloatFrequencyData, dBFS
  wave: Float32Array(1024)            // getFloatTimeDomainData decimated by stride
}
{ type: 'zz-viz', v: 1, kind: 'state', playing: false }   // once on pause/ended
```

Typed arrays go through structured clone (no base64: we need the float dB range to
reproduce mola's linear-magnitude math; byte data clips to min/maxDecibels).
Posted at ~60 Hz with `setInterval(16)` (rAF is throttled in hidden/faded iframes),
only while the video is playing.

Receiver B checks: `event.origin === 'https://www.youtube.com'`,
`event.source` equals the `contentWindow` of an `iframe#youtube-player` (or any
youtube embed iframe in the page), `data.type === 'zz-viz' && data.v === 1`, and
array types/lengths are sane (spectrum length power of two <= 16384, wave <= 4096).
Anything else is ignored. No data -> canvas hidden after 1000 ms.

A only activates when its embed URL has `origin=https://www.zig-zag.fm` in the query
string (so it never touches YouTube embeds on other sites), and when the stored
`enabled` setting is true.

## Audio tap (A) rules

- One `AudioContext` per frame, created lazily on first `play`.
- `WeakMap<HTMLVideoElement, MediaElementAudioSourceNode>` — `createMediaElementSource`
  is called at most once per element. MutationObserver picks up replaced `<video>`s.
- Chain: source -> analyser -> ctx.destination (audio keeps playing).
- IMPORTANT: routing a media element through a *suspended* context silences it. So
  the source is only created after `ctx.resume()` resolves with `state === 'running'`;
  otherwise we retry on the next `play` / `pointerdown` / `keydown` in that frame.
  If the context later suspends, try to resume on `statechange`.
- Analyser: fftSize 8192, smoothingTimeConstant 0 (see "deviations").

## Port mapping (C -> lib/mola-core.js)

| C source | JS (MolaCore) | Notes |
|---|---|---|
| main.c `MIN_FREQ`, `MAX_FREQ_CAP`, `max_freq` expr | `MIN_FREQ=40`, `MAX_FREQ_CAP=16000`, `maxFreqFor(sampleRate)` | `cap < nyquist ? cap : nyquist*0.95` |
| main.c defaults | `DEFAULTS` | bars 100, sensitivity 0.05, attack 0.7, release 0.1, gradient dusk, mode bars |
| main.c `parse_gradient` | `gradientIndex(nameOrIndex)` | case-insensitive name or integer index, -1 if bad |
| main.c SPACE cycle | `MODES=['bars','wave','bezier']`, `nextMode(m)` | |
| bars.c `bars_init` | `buildBarRanges(numBars, fftSize, sampleRate, minFreq, maxFreq)` -> `{count, lo:Int32Array, hi:Int32Array}` | identical clamping incl. `next_free_bin` |
| bars.c `bars_update` | `updateBars(ranges, smoothed, magnitudes, sensitivity, attack, release)` | in place on Float32Array; peak, sqrt, gain, clamp, attack/release |
| fft.c (`fft_forward`, Hann) | not ported: AnalyserNode does the FFT (Blackman window, 1/N scaling). `dbToMolaMagnitudes(db, out)` converts back to mola's units: `10^(dB/20) * 16384 * (0.5/0.42)` (mola FFT size x Hann/Blackman coherent-gain ratio); non-finite -> 0 | keeps `sensitivity=0.05` meaningful |
| render.c `GRADIENTS` | `GRADIENTS` (9 entries, exact RGB), `BG_COLOR=[8,8,14]` | |
| render.c `lerp_color` | `lerpColor(grad, t)` -> `[r,g,b]` | clamp t, truncate like `(Uint8)` cast |
| render.c `render_draw_bars` | `barRects(values, w, h)` -> `[{x,y,w,h,v}]` | gap 2, height 0.95, rect `(int)` truncation, `+1` height |
| render.c `render_draw_waveform` | `waveformPoints(samples, w, h)` -> Float32Array `[x0,y0,...]` | mid=h/2 (int), 0.9 scale, color = gradient `hi` |
| bezier.c `catmull_to_bezier`, `bezier_eval` | `catmullToBezier(...)`, `bezierEval(...)` | return arrays |
| render.c `render_draw_bezier` geometry | `bezierCurve(values, w, h)` -> Float32Array(w) of y per column; `bezierLevel(y, h)` -> v | 7-tap kernel, steps clamp 8..80, column resampling; fill alpha 90/255 + 2px line drawn by B |
| — | `DEFAULTS`, `sanitizeSettings(obj)`, `MOUNTS`, `SETTINGS_KEY='molaSettings'` | storage schema shared by popup + B |
| — | `isValidFrame(data)`, `MSG_TYPE='zz-viz'`, `MSG_VERSION=1`, `WAVE_POINTS=1024` | protocol validator used by B (origin/source checks stay in B) |

Canvas drawing in B: background `rgba(8,8,14,0.85)`; bars via `fillRect` with
`lerpColor`; wave via polyline in `hi`; bezier via per-column 1px fill at alpha 90/255
and per-column line segments (2 px), exactly as render.c. Canvas is DPR-scaled,
geometry computed in CSS px.

## Deviations from the C app (deliberate)

1. FFT from AnalyserNode (Blackman, 8192 pts) instead of mola's Hann 16384. 8192
   gives ~5.9 Hz bins at 48 kHz, so `buildBarRanges` keeps its log spacing (2048 would
   force ~60 of 100 bars into consecutive single bins because of `next_free_bin`).
2. `smoothingTimeConstant = 0`: mola has no spectral smoothing; its smoothing is the
   attack/release in `bars_update`, which we port. Double smoothing would be laggy.
3. Waveform: 1024 decimated samples of the 8192-sample window (mola draws 16384).
4. Keys: no global key handlers (SPACE/G would hijack site shortcuts). Instead a
   small on-canvas control (mode / gradient buttons) + the popup.
5. prefers-reduced-motion: render throttled to ~10 fps.

## Settings (storage.sync, key `molaSettings`)

`{ enabled: true, mode: 'bars'|'wave'|'bezier', gradient: <name>, bars: 8..256 (100),
sensitivity: 0.005..1 (0.05), mount: 'above-bar'|'bottom'|'top' }`, sanitized via
`sanitizeSettings`. B listens to `storage.onChanged` and applies live.

Mount `above-bar`: canvas `position:fixed`, height 72 px, full width, bottom edge on
the top of the bottom bar (found as the nearest fixed/sticky ancestor of
`[role="slider"][aria-label="Playback position"]`, re-measured on resize + every 1 s);
falls back to `bottom` if not found. `pointer-events:none` except the control chip.
z-index 20 (below the z-30 player wrapper).

## Test approach

- `tests/core.test.js` (node --test): bar ranges (monotonic, non-overlapping, within
  `[1, fftSize/2]`, a hand-computed case from the C formula), updateBars attack/release
  numbers, clamp, dB conversion (-Infinity -> 0, 0 dB -> scale), gradient table equals
  render.c, lerpColor endpoints/truncation, barRects geometry, waveformPoints,
  catmull/bezier endpoints, bezierCurve flat input -> flat line, length = w,
  sanitizeSettings.
- `tests/protocol.test.js`: message validator (`isValidFrame`) accepts good frames,
  rejects wrong type/version/oversized arrays.
- `npx web-ext lint` on `extension/`.
- Not automatable here: real playback on the logged-in site; manual steps in README.

## Task split

| Task | Owner | Files |
|---|---|---|
| Plan, review vs C sources, commits, final verification | Orchestrator (Opus) | PLAN.md |
| T1 core port + core/protocol tests | Sonnet (medium) | lib/mola-core.js, tests/*.test.js |
| T2 audio tap | Sonnet (medium) | content/youtube-tap.js |
| T3 top-frame renderer/mount/controls | Sonnet (medium) | content/zigzag-viz.js |
| T4 popup | Sonnet (medium) | popup/* |
| T5 manifest, icons, package.json, package script, README | Haiku | manifest.json, icons/*, package.json, scripts/*, README.md |

Tasks run in parallel against the API frozen above; none edits another's files.
