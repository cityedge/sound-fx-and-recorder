# Sound FX & Recorder

A casual retro-style DSP gadget and WAV recorder for Chrome tabs. It captures the audio from the current tab, applies deliberately exaggerated real-time effects, plays the processed audio through your normal output device, and can save the current output as a WAV file.

Chrome 116+ / Manifest V3. Manual installation only; this project is not distributed through the Chrome Web Store.

日本語: Chromeタブの音声に、昔のミニコンポやAVアンプのような少し大げさな疑似サラウンド／リバーブをリアルタイムで加えて遊び、そのままWAV録音できるカジュアルな拡張機能です。

## Features / 機能

- **NORMAL** — no spatial/reverb FX; BASS and TREBLE remain available
- **WIDE** — strong stereo widening
- **SURROUND** — retro pseudo-surround using short asymmetric delays, all-pass phase shifts, and cross-channel phase components
- **ROOM** — short, obvious room ambience
- **HALL** — longer and deeper hall reverb
- **BASS 0–10** — global low-shelf boost, up to about +12 dB around 120 Hz
- **TREBLE 0–10** — global high-shelf boost, up to about +12 dB around 6 kHz
- **BYPASS** — clean unity-gain path that skips spatial FX, EQ, and limiter; also works as a plain tab-audio recorder
- **EFFECT 0–100** — spatial/reverb DSP modes start at 50% by default
- **WAV recording** — 16-bit stereo PCM, recorded after the selected signal path
- **Live changes while recording** — mode, EFFECT, and BYPASS changes are captured in the WAV
- Filename options using tab title and/or timestamp
- Automatic duplicate-name handling through Chrome Downloads
- Optional leading/trailing silence trim
- Optional 10-minute automatic stop
- Per-mode EFFECT-level memory and selectable startup mode

## Installation / インストール

1. Download this repository as a ZIP, or download the release ZIP from GitHub Releases.
2. Extract it to a normal folder.
3. Open `chrome://extensions/` in Chrome.
4. Turn on **Developer mode / デベロッパーモード**.
5. Click **Load unpacked / パッケージ化されていない拡張機能を読み込む**.
6. Select the folder that contains `manifest.json`.

There is no build step. The repository root itself is the unpacked Chrome extension.

## Basic use / 基本操作

1. Open a tab that is playing music, video, or other audio.
2. Open **Sound FX & Recorder** and press **POWER**.
3. Choose NORMAL, WIDE, SURROUND, ROOM, HALL, or BYPASS.
4. Adjust **EFFECT** for spatial/reverb modes and optionally add **BASS** / **TREBLE**.
5. Press **REC** to record the current output to WAV.
6. Press **STOP** to save the WAV. The FX session continues after recording stops.
7. Press **POWER** again to stop processing the tab.

## FX settings / エフェクト設定

- **Startup effect level / 起動時のエフェクト量** — default 50%
- **Remember EFFECT level for each mode / モードごとのEFFECT量を記憶** — default ON
- **Startup mode / 起動時のモード** — Last used, NORMAL, WIDE, SURROUND, ROOM, HALL, or BYPASS

`Last used` remembers BYPASS too. If a POWER session starts in BYPASS, turning BYPASS off switches to WIDE. During normal A/B comparison, for example HALL → BYPASS → BYPASS off, the extension returns to HALL.

## Tone controls / トーンコントロール

**BASS** and **TREBLE** are global 0–10 controls shared by every non-BYPASS mode. Their values are saved automatically and remain unchanged when switching modes. RESET returns both to 0.

- BASS: 0 = flat, 10 ≈ +12 dB low-shelf around 120 Hz
- TREBLE: 0 = flat, 10 ≈ +12 dB high-shelf around 6 kHz
- BYPASS skips both tone controls as well as the spatial/reverb DSP and safety limiter.

日本語: BASS/TREBLEは全モード共通の0～10段階です。モードを切り替えても値を保持し、RESETで0に戻ります。BYPASS時はEQを含むすべてのDSPを迂回します。

## Recording / 録音

The recorder saves the audio that is currently being monitored:

- In NORMAL / WIDE / SURROUND / ROOM / HALL, the current BASS/TREBLE settings are included in the recording.
- NORMAL provides EQ without spatial/reverb processing.
- In BYPASS, the clean tab audio is recorded with all DSP bypassed.
- Recording uses 16-bit stereo PCM WAV at the actual AudioContext sample rate.
- Silence trimming analyzes the selected output path, so ROOM/HALL reverb tails remain when they are above the silence threshold.

## Permissions / 権限

The extension requests only the permissions used by its local workflow:

- `tabCapture` — capture audio from the selected Chrome tab
- `offscreen` — keep the Web Audio processing engine running outside the popup
- `activeTab` — work with the tab explicitly selected by the user
- `storage` — save local preferences and last-used FX settings
- `downloads` — save WAV recordings

No host permissions are requested.

## Privacy / プライバシー

Audio processing and WAV creation are performed locally in Chrome. The extension contains no network client code and does not send captured audio, tab titles, recordings, or settings to an external server. See [PRIVACY.md](PRIVACY.md).

## Project structure

```text
sound-fx-and-recorder/
├─ manifest.json
├─ service-worker.js
├─ offscreen.html
├─ offscreen.js
├─ pcm-recorder-worklet.js
├─ pcm-utils.js
├─ popup.html
├─ popup.js
├─ popup.css
├─ options.html
├─ options.js
├─ options.css
├─ icons/
├─ README.md
├─ CHANGELOG.md
├─ PRIVACY.md
├─ LICENSE
└─ .gitignore
```

## Development

No package manager, bundler, or compile step is required. Edit the source files directly and click **Reload** for the extension on `chrome://extensions/`.

## License

MIT License. See [LICENSE](LICENSE).
