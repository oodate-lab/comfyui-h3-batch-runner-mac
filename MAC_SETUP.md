# macOS版セットアップ

## 対応環境

- Apple Silicon MacまたはIntel Mac
- macOS 13以降
- Node.js LTS
- Codex CLI
- Mac上で起動しているComfyUI

## 起動

1. ZIPを展開します。
2. `start_macos.command`を右クリックし、「開く」を選択します。
3. 初回だけmacOSの確認画面で「開く」を押します。
4. ブラウザーで `http://127.0.0.1:3030` が開きます。

ダブルクリックで起動できない場合は、ターミナルで展開先を開き、次を一度実行します。

```bash
chmod +x start_macos.command
./start_macos.command
```

## 必要ソフト

Node.jsがない場合は、Node.js公式インストーラーまたはHomebrewを使用します。

```bash
brew install node
```

Codex CLIを導入し、最初のログインを完了します。

```bash
npm install -g @openai/codex
codex
```

確認用：

```bash
which node
which codex
```

## ComfyUI

WEB画面のComfyUI URLは、同じMac上なら通常 `http://127.0.0.1:8188` です。

「ComfyUI inputフォルダー」には、実際に使用しているComfyUIの`input`フォルダーを絶対パスで指定します。例：

```text
/Users/ユーザー名/ComfyUI/input
```

ComfyUI Desktopなどで保存場所が異なる場合は、Finderで`input`フォルダーを選択し、Optionキーを押しながら右クリックしてパス名をコピーしてください。

## 終了

起動したターミナルで `Control + C` を押します。ターミナルを閉じてもRunnerは終了します。

## トラブルシューティング

- 「開発元を確認できません」：`start_macos.command`を右クリックして「開く」を選択します。
- `permission denied`：`chmod +x start_macos.command`を実行します。
- `node not found`：Node.js LTSを導入後、ターミナルを開き直します。
- `codex not found`：`npm install -g @openai/codex`後、`codex`を一度実行します。
- ComfyUIへ接続できない：ComfyUIがポート8188で起動していることを確認します。
