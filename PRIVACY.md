# Privacy

**Sound FX & Recorder** processes audio locally inside Chrome.

The extension does not send captured audio, recordings, tab titles, or settings to an external server. It does not contain network client code and does not request host permissions.

The extension uses Chrome APIs for the following local functions:

- tab audio capture
- offscreen Web Audio processing
- local preference storage
- WAV file downloads

Recorded WAV files are saved through Chrome's normal Downloads mechanism. Settings are stored in `chrome.storage.local`.

## 日本語

**Sound FX & Recorder** の音声処理はChrome内でローカルに行われます。

キャプチャした音声、録音ファイル、タブ名、設定内容を外部サーバーへ送信しません。ネットワーク通信を行うコードや、Webサイトへのhost permissionも含みません。

録音したWAVはChrome標準のDownloads機能で保存され、設定は `chrome.storage.local` に保存されます。
