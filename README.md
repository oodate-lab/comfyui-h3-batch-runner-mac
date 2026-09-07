# ComfyUI H3 Dual Mode Director

同じWEB画面から次の2モードを切り替えられます。

- アニメモード：大まかな物語から脚本、芝居、日本語台詞、声優演技、H3ネイティブ音声を生成。字幕・外部音声は使用しません。
- MV生成モード：楽曲のテーマからMV構成、歌唱・振付、カメラを生成し、WEB画面でSRT歌詞、リリックデザイン、連番MP3を合成します。

モードを切り替えると入力欄、生成ボタン、事前検査、同梱のCodex参照プロンプトが連動して切り替わります。参照画像1～9枚の自動接続とComfyUIワークフロー設定は共通です。

大まかな物語またはMV構想と1～9枚の参照画像から、MiniMax H3 ref2v/ref2va用プロンプトをAIで作り、ComfyUIへクリップ単位で連続投入するWindows／macOS向けローカルコントローラーです。

AIが自動で設計するもの：

- 参照画像に沿ったキャラクター定義と同一性保持
- 日本の2Dアニメーション向けの芝居、ポーズ、表情、カメラ
- 自然な日本語の台詞
- キャラクターに合うオリジナルの声質とプロ声優的な演技指示
- 口の動き、呼吸、間、環境音、効果音、劇伴
- 15秒以下のクリップへの分割と、各クリップのH3六セクションプロンプト

MV生成モードでは、SRTがある区間だけリリックモーションを入れ、歌詞がない区間は字幕・画面文字を禁止します。MP3フォルダーを指定した場合は、連番順の各ファイルを対応クリップの`<Audio 1>`へ参照します。アニメモードではSRTとMP3を無視し、H3のネイティブ音声生成を使います。

## 必要なもの

- Windows 10/11、またはmacOS 13以降
- Node.js LTS
- ComfyUI（通常は `http://127.0.0.1:8188`）
- MiniMax H3 ref2vaのAPI形式ワークフローJSON
- Codex CLI（インストール済み・ログイン済み）

H3公式ref2vaワークフローは、最大9枚の参照画像とネイティブ音声出力に対応する構成を使用してください。

## 起動

### Windows

1. ZIPを新しいフォルダーへ展開します。
2. `start_windows.bat`を実行します。
3. ブラウザーで `http://127.0.0.1:3030` が開きます。

外部npmパッケージは不要です。

### macOS

1. ZIPを展開します。
2. `start_macos.command`を右クリックし、「開く」を選びます。
3. ブラウザーで `http://127.0.0.1:3030` が開きます。

初回に実行できない場合は、ターミナルで`chmod +x start_macos.command`を実行してください。詳しくは`MAC_SETUP.md`を参照してください。

## 使い方

1. 上部で「アニメモード」または「MV生成モード」を選択します。
2. アニメではストーリー、演出、台詞量、声の希望を入力します。MVでは楽曲テーマ、MV演出、パフォーマンス、必要ならSRT・リリックデザイン・連番MP3を指定します。
3. キャラクターや背景の参照画像を1～9枚D&Dします。順番が `<Picture 1>`～`<Picture 9>`になります。
4. PowerShellまたはMacのターミナルで一度 `codex` を起動してChatGPTへログインし、WEB画面の「Codex CLI確認」を押します。
5. 必要ならCodexモデルを指定し、モード別のAI生成ボタンを押します。
6. ComfyUI URL、inputフォルダー、`workflow_api.json`を設定します。
7. 自動検出されたプロンプト・画像入力・Seed、MVではLoad Audioも確認します。
8. 「生成前チェックを実行」で全項目が合格することを確認します。
9. モード別の連続生成ボタンを押します。開始時にも同じ検査を再実行します。

API URLとAPIキーの入力はありません。ローカルサーバーが `codex exec` を非対話モードで起動し、Codex CLIに保存済みのログイン状態を使います。参照画像は一時フォルダーにだけ展開し、生成終了後に削除します。

Codex CLIが未導入の場合：

```powershell
npm install -g @openai/codex
codex
```

RunnerはWindowsのnpm標準フォルダーに加え、macOSのHomebrew、npm global、`~/.local/bin`も自動検索します。

## 参照画像の接続

D&D枚数がそのままH3入力数になります。

- 1枚: `<Picture 1>` → `ref_images.ref_image_0`
- 2枚: `<Picture 1～2>` → `ref_images.ref_image_0～1`
- 9枚: `<Picture 1～9>` → `ref_images.ref_image_0～8`

不足する標準`LoadImage`ノードは、実行用APIワークフロー内へ自動生成し、IMAGE出力0をH3へ直結します。元のJSONファイルは変更しません。

## AI生成スキル

システムがAIへ渡す汎用スキルは次に同梱されています。

- `skills/japanese-anime-ref2va-prompter/SKILL.md`
- `skills/japanese-anime-ref2va-prompter/references/output-schema.md`
- `skills/japanese-anime-ref2va-prompter/references/output-schema.json`
- `skills/japanese-mv-ref2v-prompter/SKILL.md`
- `skills/japanese-mv-ref2v-prompter/references/output-schema.md`
- `skills/japanese-mv-ref2v-prompter/references/output-schema.json`

アニメ用スキルは、芝居・日本語台詞・声優演技・H3ネイティブ音声と画面文字禁止を指示します。MV用スキルは、楽曲展開・歌唱／振付・映像編集を設計し、正確なSRT文字とMP3参照の挿入はWEB画面へ委ねます。両方ともH3六セクションと`<Picture N>`の参照保持を使用します。

## 生成前チェック

ComfyUIへキューを送る前に、WEB画面とサーバーの両方で次を検査します。

- 選択クリップがあり、全クリップにH3六セクションが順番どおり存在する
- このRunnerのCodex CLIで生成・検証されたプロジェクトである
- MP3指定時は各クリップに対応する`<Audio 1>`と音声ファイルがある（未指定時は外部Audio参照なし）
- SRTがない区間の`detailed_description`に正式な字幕・画面文字禁止文がある
- SRTがある区間は指定された歌詞だけを表示し、追加の字幕・文字を禁止している
- 字幕やキャプションを表示する肯定指示が混入していない
- D&Dした1～9枚が`<Picture 1>`から順番どおり参照されている
- 画像枚数と自動生成したLoadImageノード数が一致する
- プロンプト入力が文字列型、画像入力がIMAGE接続、Seedが数値型である
- ComfyUI inputフォルダーと`/system_stats`接続が有効である

チェックに一つでも失敗すると生成は開始しません。JSONを手動で読み込んだ場合も同じ検査対象です。

## Codex CLI

生成には次の形式を使用します。

```text
codex exec --sandbox read-only --skip-git-repo-check \
  --output-schema output-schema.json -o anime-project.json \
  --image picture-1.png --image picture-2.png -
```

プロンプトは標準入力から渡します。WEB画面のモデル欄を空欄にするとCodex CLI側の既定モデルを使用し、入力した場合だけ `--model` で上書きします。CLIの進捗はサーバー側で受け取り、最終JSONだけを読み込んで検証します。

## トラブルシューティング

- `API形式のノードが見つかりません`: ComfyUIで通常保存ではなく「Save (API Format)」を使用します。
- `MiniMax H3 Reference-to-Videoノードを検出できません`: ref2va用ワークフローを読み込んでください。
- `画像入力を自動生成できません`: ComfyUIとH3ノードを更新し、APIワークフローを保存し直します。
- `Codex CLIが見つかりません`: PowerShellで `npm install -g @openai/codex` を実行後、`codex`を一度起動してログインします。必要なら `where.exe codex` の結果を画面へ貼り付けます。
- `Codex CLI実行エラー`: `codex`を起動してログイン状態、モデル名、ネットワーク接続を確認します。
- `AI応答のJSONを解析できません`: Codexが返した最終出力をログで確認し、再生成します。
- 字幕禁止文が別表現または欠落: Runnerが`detailed_description`へ正式な禁止文を必ず自動補完します。字幕表示を求める肯定指示がある場合は停止します。
- `<Picture N>`または日本語台詞タグがない: Picture参照はRunnerが自動補完します。`[JP]`、`[JA]`、`[日本語]`は`[Japanese]`へ正規化します。台詞タグが残っていないクリップは、台詞なしとして警告だけを表示し生成を続けます。
- `audio_vae, received_type(AUDIO) mismatch input_type(VAE)`: v6.0.1以降を使用し、ワークフローを読み込み直してください。MP3は`LoadAudio → ref_audios.ref_audio_0`へ接続し、`audio_vae`のVAE接続は保持されます。
- `Failed to fetch`: `start_windows.bat`の黒い画面を閉じず、`http://127.0.0.1:3030`を使用します。

実行ログはOSの一時フォルダー内 `comfyui-h3-anime-runner/runner.log` に保存されます。
