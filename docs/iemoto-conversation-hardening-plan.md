# 家元Bot・有人対応 本番安全化計画

## 現状調査（2026-07-20）

### 再利用できる既存機能

- `chats` が会話単位の状態を保持しており、新しい `conversations` テーブルは不要。
- `handling_mode=bot|human`、送信元別メッセージ履歴、Bot停止判定、切替UIは存在する。
- スタッフ認証、ロール、Cookie/Bearer認証、CSRF、APIレート制限が存在する。
- LINE署名検証、本文サイズ制限、複数LINEアカウント解決が存在する。
- D1 `batch()` を利用でき、状態変更とキュー登録を原子的にまとめられる。
- 配信、予約、イベントには既存の冪等性・再実行パターンがあり、設計を流用できる。

### 運用開始前の不足

- `handling_mode` と家元Bot内の `staff_waiting` が二重管理になっている。
- Bot返信とスタッフ返信がLINE APIへ直接送信され、共通送信キューがない。
- AI生成開始後の有人切替で、完成済み回答を世代番号により破棄する仕組みがない。
- 会話更新にversion/expectedVersionがなく、同時操作を409にできない。
- 切替・送信のidempotencyKeyがない。
- LINE webhookEventId単位の永続的な重複排除がない。
- 担当者ロック、期限切れ、送信直前の所有者確認がない。
- 状態遷移履歴・会話操作監査ログがない。
- 営業時間、AI障害、PII保護、連続メッセージ結合は未実装。

### 直接送信が残っている範囲

家元Botだけでなく、auto reply、scenario、form、reminder、event、broadcastなど複数経路がLINE APIを直接呼ぶ。全経路を一度に置換すると回帰リスクが高い。最初は「家元Bot回答・有人返信・切替通知」を共通キューへ統合し、その他のマーケティング配信は後続で統合する。

## 差分設計

- 正本: 既存 `chats.handling_mode` を `control_mode` 相当として維持する。
- 相談進行: `bot_state` を追加し、返信権限と分離する。
- 要対応: `attention_status` を追加し、既存 `status` は互換表示用として当面維持する。
- 担当: 認証主体と同じ `staff_members` を参照する `assigned_staff_id` を追加する。旧 `operator_id` は互換用。
- 競合: `version`、`bot_generation`、3分TTLのロックを追加する。
- 配送: `conversation_outbound_messages` を家元相談系の共通送信キューとする。
- 履歴: transition、audit、operation idempotency、webhook eventテーブルを追加する。

## 移行とロールバック

- migration 049は既存値を削除・変更しないadditive migration。
- 既存会話は `bot/IDLE/NONE/version=1` で開始する。
- 本番反映前にD1バックアップを取得し、migration後に件数・NULL・CHECK制約を検証する。
- アプリのロールバックは旧Worker/Pagesを再デプロイする。旧コードは追加列を無視する。
- SQLite/D1で列削除のために `chats` を再構築するのは高リスクなので行わない。新設テーブルのみ削除可能な論理rollback SQLを用意した。

## 実装順

1. 状態遷移モデルとテーブル駆動テスト。
2. expectedVersion/idempotency付きhandoff/return API。
3. 担当者claim/release/heartbeatと送信ロック。
4. 家元相談系共通送信キューと送信直前ガード。
5. Webhook重複排除とBot generation検査。
6. 管理画面の競合表示、期限超過、未担当、自分担当。
7. 営業時間・通知・AI障害。
8. PIIマスキング・保持期間dry-run・画像/連続文脈。

## 初回着手済み

- additive migration 049と論理rollbackを作成。
- `BOT/HUMAN`とは独立したBot状態・attention・version・generationの状態機械を作成。
- 古いversionの拒否、有人切替による生成中Bot回答の無効化、Bot復帰時IDLEリセットのテストを追加。
- 初回5テスト、Worker typecheck合格。

## 未反映

migration 049と新状態機械はまだ本番DB/本番Workerへ反映しない。API・キュー・Webhookを接続し、回帰テストとバックアップ手順を確認してから段階反映する。

