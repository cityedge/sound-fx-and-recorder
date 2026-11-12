# Recording regression tests

These developer-only tests are excluded from release/source ZIPs. The extension itself has no build or package-manager dependency.

`opus-trim-browser.cjs` requires Node.js, Playwright, a Playwright Chromium binary that supports unpacked extensions, FFmpeg and ffprobe. Set `PLAYWRIGHT_MODULE` if Playwright is installed outside this project, and `BROWSER_EXECUTABLE` to the Chromium executable when needed.

```powershell
node tests/opus-trim-browser.cjs
```

The test creates an isolated extension copy/profile under `tests/tmp/opus-trim/`. A test-only injection replaces tabCapture input with a deterministic stereo signal. Production Offscreen, Web Audio DSP, MediaRecorder, OPFS, trim Worker, Chrome storage and Downloads run through their real browser APIs. It checks:

- Stereo/mono Opus trim ON/OFF, WAV regression, internal pauses, entirely silent recordings and short events.
- Chrome and FFmpeg decode duration/channel agreement, and byte-identical compressed packets after trimming.
- Worker failure fallback to the completed original, with a visible warning.
- STOP retaining the active monitor, live BYPASS changes, global EQ/per-mode EFFECT memory and recording-setting snapshots.
- Shared trim checkbox, WAV-only auto-stop, persistence on reload, popup, screenshots and page errors.

`QUICK=1` runs one stereo recording plus UI checks. `STRESS_FILE` adds a separate long-file OPFS analysis/remux check; `ONLY_STRESS=1` skips short recording cases. Stress fixtures are generated media, never user inputs. For example, generate a one-hour Opus file with two seconds of silence at each boundary:

```powershell
ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3596" -af "adelay=2000,apad=pad_dur=2" -ac 2 -c:a libopus -b:a 128k -frame_duration 60 tests/tmp/opus-trim/hour-fixture.webm
$env:STRESS_FILE = (Resolve-Path tests/tmp/opus-trim/hour-fixture.webm).Path
$env:ONLY_STRESS = '1'
$env:QUICK = '1'
node tests/opus-trim-browser.cjs
```

Long-file processing is not equivalent to an hour of live tab capture. Real tabCapture permission flows, listening quality, crash/reload recovery and actual OPFS quota exhaustion still require separate testing. Worker heap observations concern that worker, not the whole Chrome process.
