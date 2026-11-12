# Privacy

**Sound FX & Recorder** processes audio locally inside Chrome.

The extension does not send captured audio, recordings, tab titles, or settings to an external server. It does not contain network client code and does not request host permissions.

The extension uses Chrome APIs for the following local functions:

- tab audio capture
- offscreen Web Audio processing
- local preference storage
- WAV and WebM/Opus downloads
- Temporary disk-backed Opus chunks in Chrome’s origin-private file system (OPFS)

Recordings are saved through Chrome’s normal Downloads mechanism. Opus recording temporarily stores encoded chunks in Chrome-local OPFS, and deletes the temporary file after Chrome reports a completed download. If a download is interrupted, temporary data may remain until cleanup on a later recording (after seven days). Settings are stored in `chrome.storage.local`. No audio is sent to an external server.

## 日本語

**Sound FX & Recorder** の音声処理はChrome内でローカルに行われます。

キャプチャした音声、録音ファイル、タブ名、設定内容を外部サーバーへ送信しません。ネットワーク通信を行うコードや、Webサイトへのhost permissionも含みません。

録音したWAV/WebMはChrome標準のDownloads機能で保存されます。Opus録音中は圧縮データをChrome内のOPFS一時領域へ保存し、ダウンロード完了後に削除します。中断した一時ファイルは後続の録音時に7日経過でクリーンアップされます。設定は `chrome.storage.local` に保存されます。
