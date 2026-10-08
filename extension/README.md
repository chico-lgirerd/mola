# Mola for zig-zag.fm

A mola-style audio visualizer for [zig-zag.fm](https://www.zig-zag.fm). It taps the
audio of the YouTube embed the site plays through (Web Audio) and draws it on top of
the player.

Modes: bars, wave, bezier.
Gradients: dusk, ocean, ember, mono, synth, citrus, lagoon, solaris, tropic.

## Privacy

- No network requests, no analytics, no remote code.
- Only the `storage` permission. No host permissions, no background script.
- Never reads tokens or cookies.
- Audio analysis stays in the browser; nothing is sent anywhere.

## Install in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `extension/manifest.json`.

Requires Firefox 115 or newer.

## Install in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.

## Settings

Open the popup from the toolbar icon:

- enable / disable
- mode (bars, wave, bezier)
- gradient
- bar count
- sensitivity
- mount position

The mode and gradient can also be changed with the small buttons on the visualizer
strip. Keyboard shortcuts are intentionally not used, so they never clash with the
site's own shortcuts.

## Development

```sh
npm test          # node --test tests/*.test.js (no dependencies)
npm run lint      # web-ext lint
npm run build     # web-ext build into dist/
scripts/package.sh  # test + lint + build in one go
```

## How it works

- `content/youtube-tap.js` runs inside the `youtube.com/embed/*` frame, but only when
  the embed was created with `origin=https://www.zig-zag.fm`. It routes the `<video>`
  through `MediaElementSource -> AnalyserNode (fftSize 8192) -> speakers` and, while
  playing, posts `{type:'zz-viz', v:1, kind:'frame', spectrum, wave, ...}` to the
  parent at ~60 Hz (`postMessage` pinned to `https://www.zig-zag.fm`).
- `content/zigzag-viz.js` accepts those messages only from `https://www.youtube.com`
  and from the player iframe's window, then runs mola's math (`lib/mola-core.js`, a
  port of `src/bars.c`, `src/bezier.c` and the drawing math of `src/render.c`) and
  draws on a canvas in a closed shadow root.
- See `PLAN.md` for the protocol, the C-to-JS mapping and the deliberate deviations
  (AnalyserNode FFT instead of mola's own, dB converted back to mola's linear units
  so the default sensitivity 0.05 behaves the same).

## Manual test steps

Firefox (main target):

1. `about:debugging#/runtime/this-firefox` -> **Load Temporary Add-on** ->
   `extension/manifest.json`.
2. Firefox MV3 treats content-script matches as host permissions the user may need to
   grant. Open `about:addons` -> Mola for zig-zag.fm -> **Permissions** and make sure
   access to `www.zig-zag.fm` and `www.youtube.com` is on (or use the toolbar
   extensions button on zig-zag.fm and choose "Always allow").
3. Open https://www.zig-zag.fm, log in, start a track.
   - Expected: a 72 px strip appears directly above the bottom player bar within a
     second of playback, bars moving with the music. Audio keeps playing normally.
4. Pause: the strip disappears after ~1 s. Resume: it comes back.
5. Click the two small buttons at the top-right of the strip: the first cycles
   bars -> wave -> bezier, the second cycles the 9 gradients. The site must not react
   (no play/pause, no navigation). Keyboard shortcuts of the site (e.g. Space) must
   behave exactly as without the extension.
6. Open the popup: change mode, gradient, bar count (try 8 and 256), sensitivity,
   position (above bar / bottom / top). Each change applies live on the open tab.
   Toggle **Enable** off: the strip disappears; audio must keep playing.
7. Skip to the next track, and seek with the slider: viz keeps working.
8. Resize the window / zoom (Ctrl +/-): strip stays full-width and above the bar.
9. Set the OS / `ui.prefersReducedMotion=1` (about:config) reduced-motion preference:
   the strip updates at ~10 fps.
10. Debug: in `about:debugging` -> Inspect the add-on, or the page console filtered on
    `mola:`. In the page console, `window.addEventListener('message', e =>
    e.data?.type === 'zz-viz' && console.log(e.data.kind))` shows whether frames
    arrive at all.

Chrome: load unpacked, then repeat steps 3-9.

## Known limitations / untested

Verified here: unit tests (`npm test`, pure DSP / mapping / gradient / bezier /
settings / protocol code, including an end-to-end synthetic-tone check of the
spectrum path), `web-ext lint` (0 errors / 0 warnings) and `web-ext build`.

Not verified (no access to the live logged-in site or a browser session):

- The whole runtime path: audio tap in the YouTube frame, `postMessage` delivery,
  `event.source` matching in Firefox (Xray wrappers), canvas rendering, mount position
  above the bottom bar, the on-strip buttons, popup UI.
- Autoplay policy: the tap only connects the `<video>` once its `AudioContext` is
  `running` (connecting through a suspended context would mute the video). If the
  browser refuses to start the context in the cross-origin frame, there is no viz
  until a click/key press happens *inside* the YouTube frame (the visible player).
- If YouTube itself ever calls `createMediaElementSource` on the same `<video>`, the
  tap gives up (no viz, audio unaffected).
- Once tapped, the video's audio flows through the extension's `AudioContext` until
  the page reloads; disabling only stops the analysis/posting.
- Selectors (`iframe#youtube-player`, `[role="slider"][aria-label="Playback
  position"]`) depend on zig-zag.fm's current markup; if the bar is not found the
  strip falls back to the bottom of the window.
