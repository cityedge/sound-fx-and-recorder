# Sound FX & Recorder

A casual retro-style DSP gadget and three-format recorder for Chrome tabs. It captures the audio from the current tab, applies deliberately exaggerated real-time effects, plays the processed audio through your normal output device, and can save the current output as WAV or WebM/Opus.

Chrome 116+ / Manifest V3. Manual installation only; this project is not distributed through the Chrome Web Store.

日本語: Chromeタブの音声に、昔のミニコンポやAVアンプのような少し大げさな疑似サラウンド／リバーブをリアルタイムで加えて遊び、そのままWAVまたはWebM/Opusに録音できるカジュアルな拡張機能です。

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
- **Three recording formats** — WAV (16-bit stereo PCM), Opus Stereo (128 kbps WebM), Opus Mono (64 kbps WebM)
- **Low-memory Opus** — 2-second MediaRecorder chunks written incrementally to private browser-local OPFS storage; no accumulated full-length PCM buffer
- **Live changes while recording** — mode, EFFECT, and BYPASS changes are captured in the recording
- Filename options using tab title and/or timestamp
- Automatic duplicate-name handling through Chrome Downloads
- Optional leading/trailing silence trim
- Optional 10-minute automatic stop **for WAV only**; Opus has no automatic time limit
- Per-mode EFFECT-level memory and selectable startup mode

## Installation / インストール

1. Download this repository as a ZIP, or download the release ZIP from GitHub Releases.
2. Extract it to a normal folder.
3. Open `chrome://extensions/` in Chrome.
4. Turn on **Developer mode / デベロッパーモード**.
5. Click **Load unpacked / パッケージ化されていない拡張機能を読み込む**.
6. Select the **inner `sound-fx-and-recorder` folder** that contains `manifest.json`.

There is no build step. The extension is in `sound-fx-and-recorder/`; the outer folder contains documentation and the optional external converter.

日本語：展開した外側のフォルダではなく、`manifest.json` が入っている内側の **`sound-fx-and-recorder` フォルダ**をChromeに指定してください。

For an existing unpacked installation, keep using the same extension folder on your computer: replace its runtime files with the contents of the new inner folder, then click **Reload**. Moving to another installation folder or removing and reinstalling the extension may not retain the existing extension identity and settings.

日本語：既存の設定を引き継ぐ場合は、これまでChromeに登録していたフォルダへ、新しい内側フォルダの内容を上書きしてReloadしてください。

## Basic use / 基本操作

1. Open a tab that is playing music, video, or other audio.
2. Open **Sound FX & Recorder** and press **POWER**.
3. Choose NORMAL, WIDE, SURROUND, ROOM, HALL, or BYPASS.
4. Adjust **EFFECT** for spatial/reverb modes and optionally add **BASS** / **TREBLE**.
5. Under **Settings → Recording**, choose WAV, Opus Stereo 128 kbps, or Opus Mono 64 kbps.
6. Press **REC** to record the current output.
7. Press **STOP** to save `.wav` or `.webm`. The FX session continues after recording stops.
8. Press **POWER** again to stop processing the tab.

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

Recordings contain the **current monitored signal**. The app never switches BYPASS automatically. With BYPASS enabled, it records the unprocessed tab audio; otherwise the selected FX, BASS and TREBLE are included. REC/STOP does not turn POWER off.

| Format / 形式 | Codec / channels | Estimated size for 1 hour | Typical use |
|---|---|---:|---|
| WAV | 16-bit stereo PCM at AudioContext sample rate (typically 48 kHz) | ~691 MB | Uncompressed music or editing |
| Opus Stereo | 128 kbps stereo, `.webm` | ~58 MB | Music and general listening |
| Opus Mono | 64 kbps mono, `.webm` | ~29 MB | Interviews, lectures, speech recognition |

- The Opus bitrates are encoder **targets**, not strict file-size guarantees. The mono recording branch explicitly combines left and right at 50% each; the monitor remains stereo.
- **WAV** retains the existing optional leading/trailing silence trim (`-55 dB` threshold with padding), 16-bit PCM encoding and user-selectable 10-minute auto-stop. WAV continues to buffer PCM in memory; do **not** rely on it for hour-long recordings on low-memory systems.
- **Opus** uses `MediaRecorder` (`audio/webm;codecs=opus`) and writes 2-second encoded chunks sequentially to browser-private OPFS instead of collecting PCM chunks. There is **no 10-minute limit**, and **no automatic silence trim** for either Opus format (the checkboxes are inactive in Settings when Opus is selected).
- Once STOP is pressed, the temporary Opus file is finalized and offered via Chrome Downloads. The extension monitors download status and removes the temporary file **after Chrome reports download completion**. Cancelled/interrupted files can remain temporarily in OPFS; old temporary files are pruned after 7 days on a subsequent Opus recording.
- In Settings, the chosen format is remembered and applies to the **next** recording; changing it mid-recording does not change the current file.
- For speech recognition, a clean BYPASS recording often works better than a strong surround/reverb setting, but this is entirely under the user's control.
- WebM/Opus support varies among transcription services. Convert externally if the chosen service does not accept `.webm`.
- A browser crash or extension reload during recording can cause loss of an incomplete recording. OPFS storage has browser-managed quotas and is not a backup. Save completed recordings via STOP and verify the download.

日本語：録音形式はWAV（従来どおり）、Opus Stereo 128kbps（音楽向け）、Opus Mono 64kbps（対談・文字起こし向け）の3種類です。Opusは圧縮データを2秒単位でChrome内の一時領域へ書き込み、録音中のPCMメモリ蓄積を回避します。WAVの10分自動停止はオプションのまま、Opusには適用しません。無音トリムはWAVのみで、Opusでは行いません。BYPASSは自動変更されません。

## External converter / 外部変換ツール

`WebM_Opus_Converter.bat` is an optional Windows tool, separate from the Chrome extension. It runs FFmpeg locally and offers:

1. 16-bit PCM WAV, preserving the original channel count and sample rate.
2. MP3 using LAME VBR quality 2.
3. 16 kHz mono WAV for speech transcription.

FFmpeg is **not bundled**. Put `ffmpeg.exe` next to the BAT, or make it available on `PATH`. Drag one or more `.webm` files onto the BAT and choose an output format. When launched without dropped files, it processes `.webm` files in the BAT's own folder. Outputs are saved next to each input; existing output files are skipped, and input files are retained.

日本語：BATは拡張機能から独立したWindows用の任意ツールです。別途 `ffmpeg.exe` をBATと同じ場所に置くか、PATHに登録してください。WebMを複数まとめてドラッグ＆ドロップできます。BATを直接起動すると、BATと同じフォルダにあるWebMを変換します。出力先は入力ファイルと同じフォルダで、既存の出力は上書きせず、元のWebMも削除しません。

## Permissions / 権限

The extension requests only the permissions used by its local workflow:

- `tabCapture` — capture audio from the selected Chrome tab
- `offscreen` — keep the Web Audio processing engine running outside the popup
- `activeTab` — work with the tab explicitly selected by the user
- `storage` — save local preferences and last-used FX settings
- `downloads` — save WAV and WebM/Opus recordings

No host permissions are requested.

## Privacy / プライバシー

Audio processing and audio encoding are performed locally in Chrome. The extension contains no network client code and does not send captured audio, tab titles, recordings, or settings to an external server. See [PRIVACY.md](PRIVACY.md).

## Project structure

```text
repository / release ZIP
├─ sound-fx-and-recorder/       ← select this folder in Chrome
│  ├─ manifest.json
│  ├─ service-worker.js
│  ├─ offscreen.html / offscreen.js
│  ├─ pcm-recorder-worklet.js / pcm-utils.js / opus-recorder.js
│  ├─ popup.html / popup.js / popup.css
│  ├─ options.html / options.js / options.css
│  └─ icons/
├─ WebM_Opus_Converter.bat       ← optional external tool
├─ README.md
├─ CHANGELOG.md
├─ PRIVACY.md
└─ LICENSE
```

The Git repository also contains development-only files (`CODEX_HANDOFF.md`, `scripts/`, `.gitignore`, `.gitattributes`). They are excluded from the release package. GitHub source archives may add an outer folder named after the repository and ref; select the inner extension folder in that case too.

## Development

No package manager, bundler, or compile step is required. v1.2.0 adds `opus-recorder.js` without changing the tuned DSP algorithms. Edit the source files directly and click **Reload** for the extension on `chrome://extensions/`.

To create the release ZIP, run this from a Git checkout with PowerShell 7:

```powershell
pwsh -File scripts/package.ps1
```

The script reads the version from `sound-fx-and-recorder/manifest.json` and writes `output/releases/sound-fx-and-recorder-v<version>.zip`. It packages an explicit list of runtime files, the converter and user documentation. Handoff notes, development scripts and previous ZIPs are not included. Runtime files are copied unchanged.

日本語：配布ZIPは上記コマンドで生成します。引き継ぎ書・開発用ファイルは配布対象に含めません。今回の配置整理ではv1.2.0の録音処理を変更しておらず、Opusの無音トリム対応は今後の開発事項です。

## License

MIT License. See [LICENSE](LICENSE).
