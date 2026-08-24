# Changelog

All notable public changes to **Sound FX & Recorder** are documented here.

## [1.1.4] - 2026-08-24

### Changed
- Clarified the Settings label to `Remember EFFECT level for each mode / モードごとのEFFECT量を記憶`.
- No storage behavior or DSP behavior changed; BASS/TREBLE remain global remembered values.

## [1.1.3] - 2026-08-24

### Changed
- The BASS/TREBLE control cell now lights with the same orange active treatment whenever either EQ level is above 0. It turns off only at B0 / T0.
- The top display appends `+EQ` to the active mode name when tone EQ is actually in the audio path, for example `WIDE +EQ` or `HALL +EQ`.
- BYPASS continues to display as `BYPASS` because it skips EQ as well as all other DSP.

## [1.1.2] - 2026-08-24

### Changed
- Increased TREBLE boost range from approximately +8 dB to +12 dB at level 10.
- TREBLE remains a 6 kHz high-shelf filter; only the gain range changed.

## [1.1.1] - 2026-08-24

### Changed
- Expanded the compact BASS/TREBLE controls in the 3×2 DSP panel by using `B` / `T` labels, making both sliders substantially easier to operate.
- Increased BASS maximum boost from approximately +10 dB to +12 dB at 120 Hz.
- TREBLE tuning remains unchanged at up to approximately +8 dB around 6 kHz.

## [1.1.0] - 2026-08-24

### Added

- NORMAL mode for tone-only processing without spatial/reverb FX.
- Global BASS boost control, 0–10, up to approximately +10 dB around 120 Hz.
- Global TREBLE boost control, 0–10, up to approximately +8 dB around 6 kHz.
- 3×2 gadget-style mode/tone control layout.
- NORMAL as a selectable startup mode.
- BASS/TREBLE values are saved automatically and included in post-FX WAV recordings.

### Changed

- BYPASS now explicitly skips spatial/reverb FX, BASS/TREBLE EQ, and the safety limiter.
- RESET returns WIDE / EFFECT 50 / BASS 0 / TREBLE 0.

## [1.0.0] - 2026-08-23

Initial public release.

### Added

- WIDE, SURROUND, ROOM, and HALL real-time DSP modes.
- Clean unity-gain BYPASS mode.
- EFFECT control with a 50% default starting level.
- Post-FX 16-bit stereo PCM WAV recording.
- Clean tab-audio recording while BYPASS is active.
- Recording that continues to capture live DSP/BYPASS changes.
- Tab-title and timestamp filename options.
- Automatic duplicate filename handling.
- Optional leading/trailing silence trim.
- Optional 10-minute automatic recording stop.
- Per-mode EFFECT-level memory.
- Configurable startup mode including BYPASS and Last used.
- English/Japanese UI.
