# Sound FX & Recorder — Codex開発引き継ぎ書

**基準版：v1.2.0 / 更新日：2026-11-12 / 対象：Chrome拡張（Manifest V3、Chrome 116以降）**

**更新（2026-11-12）**：拡張本体は配下の `sound-fx-and-recorder/`、文書・外部変換BATはリポジトリ直下。配置整理に続き、ユーザー指示によりOpusにも共通の無音トリムON/OFFを追加し、バージョンは1.2.0を維持した。10分停止はWAV専用、既存DSPと設定記憶は維持。

> **Codexへの最初の指示**：この書類とリポジトリ内の実装コードを最初に確認すること。現段階では、ユーザーからの新しい改修依頼なしにDSPの係数・録音形式・既存設定を変更しない。ここに記載した機能は「仕様」、テスト履歴は「確認済み範囲」であり、未検証項目を検証済みと扱わない。

## 0. まず読むべき要点

1. **v1.2.0が現在の正本**。以前の引き継ぎ書はv1.1.4ベースで、後からOpus仕様を追記したため、古い「WAVのみ」「v1.1.4をCodexへ渡す」といった記述が混在していた。本書はv1.2.0ソースを基準に全体を更新した。
2. カジュアルな**レトロ・オーディオガジェット**。高精度な3D音場再現やDAWを目指さず、わざと大げさなWIDE / SURROUND / ROOM / HALLを楽しむ。**ユーザーが実機で聴いて確定したDSPの音色を無断で変えない**。
3. **3種類の録音形式**：`wav`（16-bit stereo PCM）、`opus-stereo`（WebM/Opus 128 kbps）、`opus-mono`（WebM/Opus 64 kbps）。Opusのビットレートは目標値。初期値はWAV。
4. **WAVとOpusの保存方式は別物**。WAVはPCMをRAMに蓄積して停止時に生成。Opusは`MediaRecorder`で圧縮した約2秒単位のBlobを**順次OPFSへ書き込み**、停止後にWebMをダウンロードする。OpusのPCM全量バッファは作らない。
5. **無音トリムは3形式共通のON/OFF、10分自動停止はWAV専用**。Opus選択時に無効化するのは10分停止だけで、その保存値は保持する。OpusトリムはSTOP後にWorkerで逐次解析し、圧縮パケットを再エンコードせずWebMへ再構成する。
6. **録音でBYPASSを自動適用しない**。RECを押した瞬間に聴いている出力（DSP・EQ込み／BYPASSなら原音）を、そのまま録音する。録音中の操作変更も反映する。
7. **REC/STOPとPOWERは独立**。録音停止後も音声再生とFXは継続。POWERを切る際に録音中なら録音を確定してからキャプチャを解放する。
8. **公開はGitHub配布・手動インストール**。Chrome Web Store登録は現時点で予定なし。ビルド不要、リポジトリ配下の `sound-fx-and-recorder/` がChromeに読み込ませる拡張フォルダ。

## 1. 製品コンセプトと対象ユーザー

- 製品名：**Sound FX & Recorder**。
- Chromeタブで再生されているストリーミングの音声を`chrome.tabCapture`で取り込み、Web Audio APIで加工して通常のスピーカー／ヘッドホンに出力する。
- 音楽リスニングの「オーディオ遊び」と、原音・加工音の録音を両立する。
- 録音の主な用途は、(a)無圧縮音楽録音、(b)一般的な音楽用のステレオOpus、(c)対談・講演・文字起こし向けモノラルOpus。
- 操作感は1980～1990年代のミニコンポ／AVアンプ風。シンプルなボタン・スライダー。細かなEQ周波数、Q、IR定数はユーザー向けUIには露出させない。
- **ダークテーマ、原則日英併記UI**。名称や短いガジェット風表記（WIDE、HALL、B、Tなど）は英語を使用。
- 基本は個人が手動でChromeへ読み込み、GitHubでソース公開する運用。Chrome Web Storeの権限審査等は当面対象外。

## 2. 現在の確定UI・操作仕様

### 2.1 メインパネル

```text
┌───────────────┬───────────────┬───────────────┐
│ NORMAL        │ WIDE          │ SURROUND      │
├───────────────┼───────────────┼───────────────┤
│ ROOM          │ HALL          │ B [────●─] 6  │
│               │               │ T [──●───] 2  │
└───────────────┴───────────────┴───────────────┘
EFFECT  [────────●────────] 50
[BYPASS] [RESET] [REC/STOP]      [POWER]
```

- 3列×2行。右下は2本の**0～10整数**スライダー。狭いセルでも操作できるようラベルは`B`と`T`、アクセシビリティ名・ツールチップはBass/Treble。
- 選択中のFX枠はオレンジ。EQセルは **B > 0 または T > 0** ならオレンジ点灯、B0/T0のときだけ消灯。**BYPASS中でも設定値が非0ならEQ枠は点灯**する。
- 上部モード表示は、通常モードかつB/Tのいずれかが非0のときだけ`WIDE +EQ`、`NORMAL +EQ`などとする。BYPASS中は`BYPASS`（`+EQ`なし）。
- `NORMAL`＝空間FXなし＋任意のBASS/TREBLE。EFFECTスライダーは無効。
- `BYPASS`＝**空間FX・EQ・Limiterを全て迂回**する真の原音経路。RECではその原音を保存する。
- `RESET`＝**WIDE / EFFECT 50 / BASS 0 / TREBLE 0 / BYPASS OFF**。モード別EFFECT記憶ONならWIDEの記憶値は50にするが、他モードの記憶値は保持。
- `POWER`＝現在アクティブなタブの音声をキャプチャしてFX処理の開始／終了。処理対象タブはPOWER ON時に決まり、Chromeで別タブを選んでも自動では切り替わらない。
- `REC`→`STOP`＝現在の設定で録音を開始／保存。`STOP`だけではPOWERを切らない。ポップアップを閉じてもOffscreenで処理を続ける。

### 2.2 起動・記憶の仕様

- `Startup mode`選択肢：`Last used` / NORMAL / WIDE / SURROUND / ROOM / HALL / BYPASS。既定`Last used`。
- `Last used`はBYPASSを含めて記憶する。
- **BYPASS起動 → BYPASS解除 → WIDE**（BYPASSには固有の元モードがないため）。一方、通常のA/B比較では **HALL → BYPASS → 解除 → HALL** のように復帰。
- EFFECTは0～100、基本初期値50。`Remember EFFECT level for each mode / モードごとのEFFECT量を記憶`がONならモード別に記憶。OFFならモード切替時は`startupEffectLevel`を使用。
- **BASS/TREBLEは全FX共通で常に自動記憶**。EFFECTモード別記憶のON/OFFとは無関係。BYPASSにしても値は残り、解除すれば戻る。

## 3. DSPの確定音色とAudio Graph（勝手に再調整しない）

### 3.1 全体の経路

```text
Chrome tab
  └─ chrome.tabCapture.getMediaStreamId → Offscreen getUserMedia
     └─ MediaStreamAudioSourceNode
          ├─ clean branch ─────────────────────────────── bypassGain ──┐
          └─ dryGain (always 1.0) ──┐                                  │
             WIDE wet/delta ────────┤                                  │
             SURROUND wet ──────────┤                                  │
             ROOM wet ──────────────┤── mixBus → BASS → TREBLE →        │
             HALL wet ──────────────┘       DynamicsCompressor →       │
                                            processedGain ─────────────┤
                                                                       ▼
                                                    PCM Recorder AudioWorklet
                                                     ├─ AudioContext.destination
                                                     │   (monitor output)
                                                     ├─ WAV時：PCM送出 → RAM蓄積→WAV
                                                     └─ Opus時：pass-through出力をtap
                                                               → MediaRecorder → OPFS
```

- **DRYは常時ゲイン1.0、選択したFXの差分/WETだけ加算**。昔、WIDE/SURROUNDで原音が二重加算され大音量に、ROOM/HALLでDryをフェードアウトし小音量になった失敗がある。このミックス原則は不変。
- BYPASSは上記FXブランチに加え、BASS/TREBLEとLimiterも完全迂回。POWER OFFとPOWER ON+BYPASSの音量がほぼ揃うことをユーザーが確認済み。
- BYPASS切替・エフェクト量更新には`MIX_RAMP_SECONDS = 0.025`（25ms）の線形ランプを使用。
- 最終段は`DynamicsCompressorNode`で、threshold **-0.8 dB**、knee **0.5**、ratio **16**、attack **0.002 s**、release **0.10 s**。厳密なTrue-Peakリミッターではない。

### 3.2 FXモード

| モード | 方式 | 現行定数・位置づけ |
|---|---|---|
| NORMAL | WETゲイン全て0 | 空間FXなし、BASS/TREBLEのみ適用可能 |
| WIDE | ステレオSide差分のみ加算 | `EFFECT_MAX_GAIN.wide = 1.20`。差分`L=(L−R)/2, R=−(L−R)/2` |
| SURROUND | 数msの左右非対称Delay＋複数All-pass＋逆相クロス差分 | `EFFECT_MAX_GAIN.surround = 1.05`。旧単純クロスディレイではWIDEと差がなく不採用 |
| ROOM | 合成IR Convolution Reverb | `EFFECT_MAX_GAIN.room = 0.80`、IR **1.15秒**、Pre-delay **14ms** |
| HALL | 合成IR Convolution Reverb | `EFFECT_MAX_GAIN.hall = 0.60`、IR **2.70秒**、Pre-delay **21ms**。旧5.4秒／Wet1.20は過剰で不採用 |

実際の各モードのゲインは`EFFECT_MAX_GAIN[mode] × (EFFECT / 100)`。これはWETの「パーセント」ではなく追加信号に掛けるGain係数。`offscreen.js`の`createWideEffect()` / `createSurroundEffect()` / `createConvolutionEffect()` / `createImpulseResponse()` / `applyMixGains()`に詳細実装がある。

### 3.3 EQ

- **BASS：120Hz lowshelf、0～10整数、`gain = 1.2 × BASS` dB。最大+12dB**。
- **TREBLE：6kHz highshelf、0～10整数、`gain = 1.2 × TREBLE` dB。最大+12dB**。
- High-Shelfはベル型ではなく、高域でゲインが一定に近づくシェルフ特性。ユーザーが他のEQと聴き比べた結果、**6kHzは据え置き、+12dBまで強めた設定でOKと判断**。
- EQの出力は共通Limiterへ入り、BYPASSではEQもLimiterも通過しない。EQブースト時のコンプレッサー動作や聴感差には注意。

## 4. v1.2.0で追加した3種類の録音形式

| `recordingFormat` | エンコーダー／チャンネル | 保存拡張子 | 1時間のサイズ概算 | 目的 |
|---|---|---|---:|---|
| `wav` | 16-bit PCM / stereo、サンプルレート=`AudioContext.sampleRate`（典型48kHz） | `.wav` | 48kHz時 約691MB | 無圧縮の音楽録音・編集 |
| `opus-stereo` | MediaRecorder / WebM・Opus / 2ch / **目標128kbps** | `.webm` | 約58MB | 音楽にも使える圧縮録音 |
| `opus-mono` | MediaRecorder / WebM・Opus / 1ch / **目標64kbps** | `.webm` | 約29MB | 対談・講演・文字起こし |

- 再生モニターは全モード**ステレオ**のまま。`opus-mono`のときだけ**録音分岐でL×0.5＋R×0.5**へダウンミックスする。
- Opusの128/64kbpsはMediaRecorderへ渡す`audioBitsPerSecond`の**目標値**。実測値やファイルサイズを厳密保証する値ではない。
- 録音形式は**REC時にSettingsから読み取り、その録音セッションに固定**する。録音中にSettingsを変更しても既に始まった録音の形式は変わらない。
- **録音開始時にBYPASSを自動的に変更してはいけない**（ユーザー明示）。録音内容はその瞬間のモニターと同じ信号。録音中にDSP/EQ/BYPASSを操作した変更も反映される。
- `autoTrim`は3形式共通のON/OFF（既定ON、既存保存値を引き継ぐ）。`autoStop10Min`はWAVのみ（既定ON）で、Opus選択時はそのチェックボックスだけdisabledとし、保存値は保持する。
- 無音トリムは先頭・末尾のみ。途中の無音は残し、有音が見つからない場合は全体を保持する。Opusでは保存済み圧縮音声を少量ずつデコードして判定するため、圧縮前PCMを判定するWAVと境界が完全一致する保証はない。

### 4.1 WAV録音の実装（既存・変更しない）

1. `offscreen.js/startRecording()`が`recordingFormat='wav'`を検出し、PCM Workletに`start-recording`を送る。
2. Workletは入力音声をモニターへパススルーしながら**4096フレーム単位**のFloat32 L/RをOffscreenへ送出。
3. `appendPcm()`が16-bit PCMの`Int16Array`へ変換し、`pcmChunks`へ蓄積。時間とメモリ消費は概ね線形に増大する。
4. 20ms RMSブロックによる無音判定（閾値 **-55dB**、最小有音 **60ms**、前 **250ms**・後 **500ms**パディング）。**WAVの前後のみをトリム**。原音ではなくDSP処理後の信号で判定し、リバーブテールを含める。
5. STOPでは`stop-and-flush`を送り最後のPCMまで回収し、`PCMUtils.makeWavHeader()`等で16-bit stereo RIFF/WAVを組み立てる。
6. `chrome.downloads.download({conflictAction:'uniquify'})`で保存。タブタイトル・日時（任意）をファイル名にできる。Windows禁止文字・予約名対策済み。
7. `autoStop10Min`がONのWAVは10分で録音停止（FXは続く）。OFFにしてもWAVのメモリ消費問題は解消されない。

### 4.2 Opus録音の実装（v1.2.0の中核）

**新規ファイル`opus-recorder.js`の`OpusRecording`が録音エンジン**。PCM Workletは引き続きモニターへ音声を流すが、Opus中はPCMチャンクを収集しない。

1. Offscreenで`new OpusRecording({context: audioContext, outputNode: recorderNode, recordingFormat, filename, onProgress, onUnexpectedStop})`を生成する。
2. `recorderNode`の出力に録音専用のGain/tapと`MediaStreamAudioDestinationNode`を接続。モノラルは専用Splitter・左右Gain 0.5・1ch Mergerで変換。モニターは変更しない。
3. `MediaRecorder.isTypeSupported('audio/webm;codecs=opus')`と`navigator.storage.getDirectory()`（OPFS）を確認する。
4. OPFSの`sfxr-recording-temp/opus-<timestamp>-<uuid>.webm`を`createWritable()`で開く。
5. `MediaRecorder(stream, {mimeType:'audio/webm;codecs=opus', audioBitsPerSecond: 128000 または 64000})`を開始。`start(2000)`で約2秒単位の`dataavailable`を受け取る。
6. **各Blobを`writeChain`のPromise連鎖で順番にOPFSへ`write()`**。長時間分のPCMや全WebMチャンク配列をメモリへためない。ただしエンコード／書込遅延・ブラウザ内部のメモリはゼロにはならず、OPFS容量制限も受ける。
7. STOPでは`MediaRecorder.stop()`の最後の`dataavailable`と`stop`イベントを待ち、全`writeChain`を完了させて`writable.close()`。`fileHandle.getFile()`の`File`を取得する。
8. `autoTrim`がONなら `opus-trim-worker.js` を起動。`webm-opus.js`でディスク上のWebMを逐次読み、AudioDecoderへ最大16パケットずつ渡す。PCMは即座にRMSへ集約し、先頭・末尾の有音ブロック位置だけ保持する。入力のMediaRecorder時刻の小さな揺れはパケットのサンプル時計に揃える。別のOPFS一時ファイルへ対象パケットを逐次書き出し、80msのデコーダー準備区間、OpusHeadのpre-skip、CodecDelay、終端DiscardPaddingを調整する。全録音分のPCM・RMS配列・パケット配列は保持しない。トリム成功時のみ元の一時ファイルを削除する。失敗時は完成済み原本を未トリムで保存し、`recordingWarning`で通知する。
9. `URL.createObjectURL(file)`→Service Workerの`download-recording`→`chrome.downloads.download`へ渡す。STOPボタン操作が成功して録音状態がidleへ戻っても、**ブラウザの実ファイルダウンロード完了とは限らない**。
10. `offscreen.js/monitorOpusDownload()`が約2秒間隔で`get-download-status`を問い合わせ、`complete`を確認するとObjectURLを破棄しOPFS一時ファイルを削除。中断なら一時ファイルを当面保持する。追跡には上限があり、完了を確認できない場合は一時データが残り得る。
11. 次回Opus録音時に`cleanupStaleOpusFiles()`を呼び、**7日より古い拡張所有の一時ファイルだけ**を削除（追跡中の名前は除外）。現在は**途中失敗した録音のユーザー向け復旧UIはない**。

**重要な未検証領域**：OPFS保存容量の不足、Chrome強制終了・拡張Reload中の録音、ダウンロード中断後の回復、1時間前後の連続録音については、実環境での耐久試験が未実施。OPFSへ書く設計だからといってクラッシュ耐性・完全復旧を保証しない。

### 4.3 WAVとOpusの終端処理の違い

- `offscreen.js/startRecording()` / `stopRecording()` / `finishRecording()`で形式を分岐。共通の状態は`idle → recording → processing → idle`。
- WAV：`flushWorklet()`→`saveWav()`。Opus：`OpusRecording.stop()`→`saveOpus()`→**非同期のダウンロード完了監視**。
- `STOP`しても`sessionActive=true`のまま、録音エンジンの一時的な枝のみ片付ける。
- `POWER OFF`中に録音中であれば、録音確定を試みてから`cleanupAudio()`でAudioContextとトラックを解放。保存エラーでもタブが無音状態に取り残されないようcleanupを行う。
- タブのaudio trackが終了した場合も`stopFx('track-ended')`へ進む。

## 5. 実装ファイル・責務

```text
sound-fx-and-recorder/          ← リポジトリ配下の拡張本体。Chromeで読み込むフォルダ
├─ manifest.json               MV3、Chrome 116+、権限とエントリ
├─ service-worker.js           Offscreen確保、状態・録音時間バッジ、Downloads呼出／照会
├─ offscreen.html              pcm-utils.js → opus-recorder.js → offscreen.js を順にロード
├─ offscreen.js                キャプチャ、DSP Audio Graph、録音形式分岐、状態管理、保存
├─ opus-recorder.js            【v1.2.0新規】MediaRecorder→OPFS、モノラル化、停止、掃除
├─ opus-trim-worker.js         Opusの逐次デコード・境界判定・OPFSへのトリム保存
├─ webm-opus.js                小分けのWebM読取・Opusパケットの無再圧縮リマックス
├─ pcm-recorder-worklet.js     PCM収集・非録音時の音声パススルー
├─ pcm-utils.js                WAV生成／無音判定・トリム
├─ popup.html / popup.js / popup.css       3×2 FX/EQ/録音操作UI
├─ options.html / options.js / options.css FX/録音形式/ファイル名などの設定UI
└─ icons/                     16/32/48/128px PNG
```

リポジトリ直下には `README.md`、`CHANGELOG.md`、`PRIVACY.md`、`LICENSE`、外部ツール `WebM_Opus_Converter.bat` を置く。開発用の本書、`.gitignore`、`.gitattributes`、`scripts/package.ps1` も直下側で管理するが、配布ZIPには含めない。

- `manifest.json`：`name: Sound FX & Recorder`, `version: 1.2.0`, `manifest_version: 3`, `minimum_chrome_version: 116`。
- 権限：**`tabCapture`、`offscreen`、`activeTab`、`storage`、`downloads`**。`host_permissions`なし。外部サーバーへ音声送信する実装ではない。必要のない権限・ネットワーク通信を勝手に増やさない。
- `Offscreen Document`はポップアップを閉じても再生／録音処理を継続する。Service Workerは状態取得・ダウンロード・バッジを担当。タブ音声はService Workerが直接DSP処理するのではない。
- 拡張ルート直下に`manifest.json`を置く設計。GitHub ZIP展開後、そのフォルダを`chrome://extensions/`→デベロッパーモード→`パッケージ化されていない拡張機能を読み込む`から指定する。
- Nodeビルドやnpmは不要。素のHTML/CSS/JS。

## 6. 永続設定（`chrome.storage.local`）

| キー | 既定 | 現行意味 |
|---|---|---|
| `startupEffectLevel` | `50` | 初期EFFECT量 |
| `rememberModeLevels` | `true` | 各モードの**EFFECT値のみ**を記憶するか |
| `startupMode` | `'last'` | `'last'/'normal'/'wide'/'surround'/'room'/'hall'/'bypass'` |
| `lastUsedMode` | `'wide'` | 前回モード。BYPASSを含む |
| `effectLevels` | `{}` | モード名→EFFECT（0～100）の記憶マップ |
| `bassLevel` | `0` | 全FX共通のBASS（0～10） |
| `trebleLevel` | `0` | 全FX共通のTREBLE（0～10） |
| **`recordingFormat`** | **`'wav'`** | **v1.2.0追加。`wav` / `opus-stereo` / `opus-mono`** |
| `useTabTitle` | `true` | ダウンロード名にタブ名を使う |
| `useTimestamp` | `false` | ダウンロード名に日時を付ける |
| `autoTrim` | `true` | **3形式共通**の前後無音トリム |
| `autoStop10Min` | `true` | **WAVのみ**の10分停止（OFF可能） |

- 設定は既存キーを変更・削除せず後方互換で扱う。v1.1.4からの移行では`recordingFormat`が未保存なら`wav`として動作する。
- Settingsで録音形式を変更すると、ファイル名プレビューの拡張子（`.wav`/`.webm`）とWAV専用の10分停止チェックボックスの操作可否が変わる。無音トリムは常に操作可能。
- 録音開始時に`popup.js`が設定をスナップショット取得してOffscreenへ送る。録音中にSettingsを変更しても実行中の録音には適用しない。
- EQはFX共通、EFFECT値はモード別。これを統合して勝手にモード別EQにしない。

## 7. メッセージと状態管理

### 7.1 状態の責務

- POWERセッション：`sessionActive`（Offscreen）と現在のタブID・キャプチャstreamを保持。
- 録音状態：`recordingStatus`=`'idle' | 'recording' | 'processing'`。POWERとは独立。
- 現在の録音形式：`recordingSettings.recordingFormat`。WAVとOpusで録音時のコードパスを切替。
- Opus録音インスタンス：`activeOpusRecording`。ダウンロード中の非同期追跡：`pendingOpusDownloads`。
- 録音時間：WAVはPCMフレーム数（トリムON時は推定保存長）、Opusは録音経過時間を表示。3形式とも録音時のバッジ・状態表示を行う。

```text
POWER OFF
  └─ POWER ON → sessionActive / idle
                     ├─ REC (WAV)  → PCM recording ─STOP→ PCM/WAV save ─┐
                     ├─ REC (Opus) → MediaRecorder→OPFS ─STOP→ WebM DL ─┤
                     │                                                 ↓
                     ├───── モード・EFFECT・EQ・BYPASS変更可能 ← idle / FX継続
                     └─ POWER OFF → （録音中ならSTOP相当の確定）→ session終了
```

### 7.2 主なRuntime Message

| 送信元→送信先 | 主な`type` |
|---|---|
| popup → service-worker | `ensure-offscreen`, `get-engine-state` |
| popup → offscreen | `get-state`, `start-fx`, `stop-fx`, `set-mode`, `set-effect-amount`, `set-bass-level`, `set-treble-level`, `set-bypass`, `set-fx-settings`, `start-recording`, `stop-recording` |
| offscreen → service-worker | `engine-state-changed`, `recording-estimated-duration`, `recording-processing`, `recording-stopped`, `engine-error`, **`download-recording`**, **`get-download-status`** |
| offscreen → PCM Worklet | `start-recording`, `stop-and-flush`（WAV時のみ） |
| PCM Worklet → offscreen | `pcm`, `flushed`、`recording-started` |

- `service-worker.js`には旧WAV互換の`download-wav`ハンドラ名も残るが、現行主経路は`download-recording`。
- 録音開始／終了・Offscreen起動の非同期応答ではChromeのメッセージチャネルを保つ実装に注意。
- `stop-recording`で録音状態がidleへ戻っても、OpusのChrome Downloads処理が完了する前の場合がある（§4.2参照）。

## 8. ユーザーによる調整履歴とテストの事実関係

### 8.1 主な開発・聴感経緯

| 版 | 確定までの経緯 |
|---|---|
| 前身 Tab Audio Recorder v0.6.0 | WAV録音・無音トリム・タブ名等の仕組みを流用 |
| v0.1.0–0.1.2 | 当初はBYPASS音量差、FXの原音二重加算、ROOM/HALLのDry減少が問題。完全BYPASS＋DRY固定＋WET加算へ修正 |
| v0.1.3 | WIDEを強め、SURROUNDを短い位相差・All-pass方式へ変更、ROOM/HALLを増強 |
| v0.1.4 | HALLが過剰なので約半減し、4FXすべて実機聴感OK |
| v0.1.5 | 起動モードBYPASS対応、EFFECT初期50%、モード別EFFECT記憶 |
| v1.0.0 | GitHub公開向けパッケージ化、製品名を確定 |
| v1.1.0–v1.1.2 | NORMAL・全モード共通EQ・3×2UI導入。BASS/TREBLEとも最大+12dBへ調整し、ユーザーが音色を承認 |
| v1.1.3–v1.1.4 | EQセル点灯、`+EQ`表示、設定ラベル明確化。既存保存方式は維持 |
| **v1.2.0** | **WAV + Opus Stereo 128kbps + Opus Mono 64kbps。OpusはMediaRecorder→OPFS逐次保存。追更新で無音トリムを3形式共通に拡張し、10分停止はWAV専用。既存DSP係数は変更なし** |

### 8.2 検証済み／未検証（混同しない）

**確認できていること**

- 2026-11-12の追更新では `tests/opus-trim-browser.cjs` により、Chromiumの拡張Offscreen＋実MediaRecorder／OPFS／Worker／Downloadsで短時間録音を検証。ステレオ・モノラルのトリムON/OFF、途中の無音保持、全無音・短い音の全体保持、WAV回帰、STOP後のFX継続、設定画面の保存・復元を確認。入力だけ合成音に置換しており、実タブのtabCapture権限経路・聴感評価は別扱い。
- トリム後の圧縮Opusパケットが元録音の連続部分とバイト一致し、ChromeとFFmpegのデコード時間が一致することを検証。FFmpegで生成した1時間のステレオOpus（前後2秒無音、約58MB）をOPFSへ置き、逐次解析・再保存・全体デコードを約58秒で完了。Worker JSヒープの観測最大値は約12.6MB、backing storageの観測最大値は約62.4MB。この観測はChrome全体のRAM保証ではなく、1時間の実時間録音耐久試験でもない。

- v1.1.4までのDSP・EQ・POWER/BYPASS・操作感はユーザーがChromeで実際に確認済み。v1.2.0ではDSP本体・PCM Workletの調整済み実装を維持している。
- v1.2.0のブラウザ側の短いMediaRecorderテストでWebM/Opusを生成し、ffprobeによる**ステレオ2ch／モノラル1ch**の確認を実施したとの開発記録がある。ただし、そのテストのストレージ部分はメモリモックであり、**実Chrome拡張のOPFS/Downloads経路の完全なテストではなかった**。
- ユーザーはv1.2.0導入後、実際のWebM/OpusファイルをMP3へ変換できたと報告。FFmpeg **2025-09-22**のビルドでは`Error parsing Opus packet header`が一度表示されたが、FFmpegを更新後はエラーが出なくなったと確認。**この症状だけを理由に拡張側WebM生成が破損しているとは判断しない**。どちらのOpusモードのファイルだったかは本会話から断定できない。

**未検証／要回帰試験**

- Opusを**1時間程度連続録音**したときのOPFS書込・ダウンロード・メモリ・安定性。
- Opus録音途中のChrome終了、拡張Reload、OPFS quota不足、書込失敗、保存中断・キャンセル、バックグラウンドでのダウンロード完了監視と一時ファイル掃除。
- 実機での各形式のFX/EQ/BYPASS変更中録音・録音停止後FX継続の全組合せ（コード上の意図は明確だが動作確認を継続する）。
- Opusの`audioBitsPerSecond`は目標であり、実際の出力ビットレートを全録音条件で検証したわけではない。

### 8.3 WebM互換性とFFmpeg補助ツール

- WebM/Opusはブラウザ録音に適する一方、再生ソフトや文字起こしツールによっては対応しないためWAV/MP3への変換が必要な場合がある。
- **外部ツール**として`WebM_Opus_Converter.bat`をリポジトリ直下で管理。用途は(1)16-bit PCM WAV、(2)LAME VBR品質2 MP3、(3)16kHzモノラルWAV。複数WebMドラッグ＆ドロップ／同一フォルダ内一括処理に対応。**配置整理後の配布ZIPには、拡張フォルダの外側に同梱する**。FFmpeg本体は別途用意し、BATと同じ場所またはPATHに置く。
- 代表的なFFmpegコマンド（外部変換。拡張コードにFFmpeg依存はない）：

  ```powershell
  ffmpeg -i "input.webm" -c:a libmp3lame -q:a 2 "output.mp3"
  ffmpeg -i "input.webm" -c:a pcm_s16le "output.wav"
  ffmpeg -i "input.webm" -ar 16000 -ac 1 -c:a pcm_s16le "output_16k_mono.wav"
  ```

- 古いFFmpegでOpus解析警告が出る場合、**最新版へ更新して同じWebMで再確認**する。今回の実例ではFFmpeg更新で改善したため、拡張側のエンコード変更はしていない。

## 9. Codexでの改修・検証手順

1. Gitチェックアウトのルートで `CODEX_HANDOFF.md` → `README.md` → `CHANGELOG.md` を読み、その後 `sound-fx-and-recorder/` 内の `manifest.json` → `popup.js` → `offscreen.js` → `opus-recorder.js` → `service-worker.js` → Worklet/PCMUtilsの順に読む。配布ZIPには本書は含まれない。
2. **最初のターンではコードを変更しない**。ファイル構成とアーキテクチャ、録音時の二経路、未検証事項を把握して報告する。ユーザーが次の作業を指示してから変更を始める。
3. 実装変更は必要最小限。DSP変更指示がない限り、v1.1.4で確定した`offscreen.js`のFX係数・IR・EQ周波数を保存する。Opus追加時の録音経路や設定キーも壊さない。
4. ソース変更後は`node --check`等で全JS構文、JSON、HTML参照先、Manifestの整合性を確認。ビルド不要の配布・インストール方式を維持する。
5. 実機テストは`chrome://extensions/`→Developer mode→Load unpacked→リポジトリ内の `sound-fx-and-recorder/`。変更後はReload。OffscreenとService Workerのコンソールも見る。既存ユーザーが設定を引き継ぐ場合は、従来のインストールフォルダに内側フォルダの内容を上書きし、登録済み拡張をReloadする。
6. **既存ユーザーの`chrome.storage.local`設定を保持したケース**と、新規インストール相当の初期設定ケースの両方で試す。
7. リリース時は `sound-fx-and-recorder/manifest.json` のversion、README/CHANGELOG、本書の基準版を同期する。PowerShell 7で `pwsh -File scripts/package.ps1` を実行し、`output/releases/` にReleases用ZIPを生成する。明示的な対象リストで梱包し、本書・開発用ファイル・旧ZIPは含めない。Chrome Web Store対応は指示がない限り不要。

### 9.1 最低限の回帰チェックリスト

**Audio / UI**

- [ ] POWER OFF ⇔ POWER ON+BYPASSで音量がほぼ揃う。
- [ ] NORMALはEFFECT無効、BASS/TREBLEのみ。4FXは各音色・DRY固定＋WET加算を保つ。
- [ ] B/Tが0-0以外でEQセル点灯、0-0で消灯。BYPASS中でも枠点灯は設定値を示し、上部`+EQ`は表示しない。
- [ ] EQ周波数はBASS120Hz、TREBLE6kHz、各10＝+12dB。モード変更後もEQ値を保持。
- [ ] HALL 2.7秒／ROOM 1.15秒。DSP定数が意図せず変更されていない。
- [ ] BYPASS起動→解除でWIDE、通常のHALL→BYPASS→解除でHALL。
- [ ] EFFECT初期50%、モード別記憶ON/OFF、RESETの動作と既存保存値の互換性。

**WAV録音**

- [ ] 16-bit stereo PCM WAVが再生できる。録音中のFX/EQ/BYPASS変更が反映される。
- [ ] 無音トリムON/OFF、前後パディング、HALLテール保持。
- [ ] 10分停止ONで停止・OFFで継続。自動停止後もPOWERはONのまま。
- [ ] ファイル名・時刻・同名回避・保存処理と、その後の再録音。

**Opus録音**

- [ ] Opus Stereo 128kbpsでWebMを保存し、ffprobeで2ch・Opusと確認。
- [ ] Opus Mono 64kbpsでWebMを保存し、ffprobeで1ch・Opusと確認。聴取用出力はステレオのまま。
- [ ] 両OpusモードでFX/EQ/BYPASS変更が反映され、BYPASSは自動切替されない。
- [ ] Opusでも無音トリムON/OFFが反映され、途中の無音・全無音録音は保持される。10分停止はOpusに適用しない。Settingsの共通値保持と10分停止のみdisabledを確認。
- [ ] 2秒チャンク順次書込・最終チャンク確定・保存後のデコード・連続2回録音。
- [ ] STOP後もFXが継続。ダウンロード完了後にOPFS一時ファイルが削除される。
- [ ] ダウンロード中断や失敗、Chrome終了、ディスク容量不足で**データを黙って失わないか**確認。未完成録音の復旧UIは現状ない。
- [ ] 想定する1時間程度の実時間録音で、RAMがPCM全量相当まで増えないことを確認。

## 10. 現時点の制約と今後の検討余地

- 音声取得対象は**1つのChromeタブ**。OS全体の音声や複数タブ同時録音、DRM制限下での万能な録音機ではない。
- WAVのRAM全量蓄積は未改善。1時間・48kHz/16bit/stereoなら約691MBのPCMデータになり、処理時の追加メモリもあり得る。WAVの10分自動停止OFFはユーザーの責任で運用する仕様。
- OpusはOPFSディスクベースだが、**容量制限・エンコーダー不調・クラッシュ・ダウンロード完了監視の失敗**まで耐障害性を保証するものではない。追加開発をするなら「一時ファイル回収／復旧UI」「長時間ストレステスト」「保存進捗とダウンロード完了表示」が候補。ただしユーザーからの新指示なしに機能を増やす必要はない。
- MediaRecorderのWebM/OpusはMP3やWAVに比べ互換性が限定的。別途FFmpeg補助BATあり。Chrome拡張本体にFFmpegを組み込む必要はない。
- `DynamicsCompressorNode`は完全なクリップ防止装置ではない。B/T両方＋12dBで強い信号を入れた際の挙動は要確認。
- オーディオ品質は実装論だけでは評価できない。聴感テストを伴わず「上品」「自然」にチューニングし直すことは、製品コンセプトにも過去のユーザー評価にも反する。
- `tests/opus-trim-browser.cjs`にPlaywright＋Chromium拡張の自動テストがある。入力だけ合成音へ置換し、Offscreen・MediaRecorder・OPFS・Worker・Downloadsは実APIを使用する。実タブのtabCaptureとユーザー聴感評価は別途必要。CIは未整備で、拡張実行時のビルド・外部依存は追加していない。
- プライバシー：音声・タブタイトル・設定を外部サーバーへ送る仕様ではない。外部送信・外部権限・テレメトリーなどの追加は事前に確認する。

## 11. Codexへの初回プロンプト（そのまま渡せる）

> このリポジトリはChrome拡張 **Sound FX & Recorder v1.2.0（Opus無音トリム追更新版）** です。最初に本書とREADME、CHANGELOG、続いて拡張フォルダの主要JSを確認してください。**録音開始でBYPASSを自動変更しないこと**、**無音トリムは全形式共通ON/OFF、10分停止はWAV専用**、**STOP後もPOWER/FXを継続すること**、**Opusで全量PCMをメモリに蓄積しないこと**を守ってください。DSP係数と既存設定記憶を指示なしに変更せず、UIはダークテーマ・日英併記、公開方法はGitHub手動インストールを維持してください。

---

**引き継ぐ正本**：リポジトリの `sound-fx-and-recorder/` にあるv1.2.0追更新版を基準とする。本書は配布ZIPから除外し、変換BATは外部ツールとして拡張フォルダの外に同梱する。**Opusトリム処理を追加したが、Manifestのバージョン・DSP係数・WAVの既存処理・設定記憶は維持している。**
