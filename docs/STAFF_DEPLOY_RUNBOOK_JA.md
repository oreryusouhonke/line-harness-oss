# LINE Harness 本番デプロイ手順

対象は、承認済みPull Requestが本番基準ブランチへ取り込まれた場合のみ。

## デプロイ前

- [ ] Pull Requestが責任者承認済み
- [ ] `pnpm test` が成功
- [ ] APIキー・トークン・`.env` が差分に含まれていない
- [ ] 新しいmigrationの番号が重複していない
- [ ] Worker、Pages、D1の対象名を再確認した
- [ ] 本番D1をバックアップした

```bash
git switch integration/upstream-v0.22-20260824
git pull --ff-only origin integration/upstream-v0.22-20260824

cd apps/worker
npx wrangler whoami
npx wrangler d1 export line-crm --env production --remote --output line-crm-before-deploy.sql
```

バックアップSQLはGitへ追加しない。

## DB migration

既存テーブル・列を確認してから未適用ファイルだけを実行する。エラーを無視する `|| true` は禁止。

```bash
npx wrangler d1 execute line-crm --env production --remote --file ../../packages/db/migrations/NNN_name.sql
```

## Worker

```bash
cd apps/worker
pnpm build
npx wrangler deploy --name line-harness
npx wrangler triggers deploy --env production --name line-harness
```

Cronは次の2本であることを確認する。

```text
*/5 * * * *
0 */6 * * *
```

## 管理画面

```bash
cd apps/web
$env:NEXT_PUBLIC_API_URL='https://line-harness.kataokamasanori.workers.dev'
pnpm build
npx wrangler pages deploy out --project-name=line-harness-admin-24b9f8e8 --branch=main
```

macOS/Linuxでは環境変数設定部分を次のようにする。

```bash
NEXT_PUBLIC_API_URL='https://line-harness.kataokamasanori.workers.dev' pnpm build
```

## デプロイ後

- [ ] Worker `/health` が200
- [ ] Worker `/api/health` が200
- [ ] 管理画面 `/login` が200
- [ ] 未認証 `/api/chats` が401
- [ ] CloudflareのWorker Version IDとPages Deployment URLを作業ログへ記録
- [ ] ログイン、友だち一覧、チャット一覧を画面で確認

## 障害時

新しい配信処理を止め、CloudflareのDeploymentsから直前のWorker Versionへロールバックする。DBを戻す前に責任者へ連絡し、追加データの消失範囲を確認する。DBバックアップの機械的な全上書きは行わない。

