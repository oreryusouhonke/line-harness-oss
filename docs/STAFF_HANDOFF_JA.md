# LINE Harness スタッフ引き継ぎ書

## 最初に渡されるもの

- GitHub: https://github.com/oreryusouhonke/line-harness-oss
- 本番基準ブランチ: `integration/upstream-v0.22-20260824`
- 本番管理画面: https://line-harness-admin-24b9f8e8.pages.dev
- Workerヘルスチェック: https://line-harness.kataokamasanori.workers.dev/health
- Cloudflareロール: デプロイ担当者のみ `Workers Platform Admin`

パスワード、LINEトークン、APIキー、`.env` は受け取らない・チャットで送らない。秘密値はCloudflare Secretsで管理する。

## 初回セットアップ

```bash
git clone https://github.com/oreryusouhonke/line-harness-oss.git
cd line-harness-oss
git remote add upstream https://github.com/Shudesu/line-harness-oss.git
git fetch --all --prune
git switch integration/upstream-v0.22-20260824
pnpm install --frozen-lockfile
```

## 毎回の作業手順

作業開始前に本番基準ブランチを最新化する。

```bash
git switch integration/upstream-v0.22-20260824
git pull --ff-only origin integration/upstream-v0.22-20260824
git switch -c staff/作業内容
```

変更後は、テストして作業ブランチだけをpushする。

```bash
pnpm test
git add -A
git commit -m "変更内容を具体的に書く"
git push -u origin staff/作業内容
```

GitHubで次の向きのPull Requestを作る。

```text
staff/作業内容
  → integration/upstream-v0.22-20260824
```

責任者の承認前に本番へデプロイしない。

## 絶対にしないこと

- 本番基準ブランチへ直接pushしない
- `git push --force` を使わない
- トークン、パスワード、APIキー、`.env` をcommitしない
- 本番D1へバックアップなしでSQLを実行しない
- migration番号を既存ファイルと重複させない
- `wrangler.toml` に秘密値を書かない
- LINEの一斉配信・シナリオ配信をテスト目的で実行しない

## 競合が出たとき

自己判断でスタッフ側または責任者側の変更を丸ごと消さない。作業ブランチで本番基準ブランチを取り込み、競合箇所ごとに意図を確認する。

```bash
git fetch origin
git switch staff/作業内容
git merge origin/integration/upstream-v0.22-20260824
```

解消方針が分からなければ、競合ファイル名と双方の意図をPull Requestへ記載して責任者へ確認する。

## 権限を失った・退職した場合

責任者はGitHub CollaboratorとCloudflare Memberの両方から対象者を削除する。共有シークレットを見せた可能性がある場合のみ、該当シークレットをローテーションする。

