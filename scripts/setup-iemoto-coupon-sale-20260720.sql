INSERT OR IGNORE INTO tracked_links
  (id, name, original_url, tag_id, scenario_id, intro_template_id, reward_template_id, is_active, click_count, created_at, updated_at)
VALUES
  ('iemoto-rakuten-marathon-202607', '家元：楽天お買い物マラソン 2026-07', 'https://event.rakuten.co.jp/campaign/point-up/marathon/', NULL, NULL, NULL, NULL, 1, 0, datetime('now', '+9 hours'), datetime('now', '+9 hours')),
  ('iemoto-rakuten-five-zero-20260720', '家元：5と0のつく日 2026-07-20', 'https://event.rakuten.co.jp/card/pointday/', NULL, NULL, NULL, NULL, 1, 0, datetime('now', '+9 hours'), datetime('now', '+9 hours')),
  ('iemoto-rakuten-coupon-check', '家元：楽天で使えるクーポン確認', 'https://coupon.rakuten.co.jp/', NULL, NULL, NULL, NULL, 1, 0, datetime('now', '+9 hours'), datetime('now', '+9 hours'));

INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
VALUES (
  'iemoto-coupon-sale-setting-v1',
  'b10764f3-521e-4b0c-81a3-e91a5c9e2c87',
  'coupon_sale_automation',
  '{"version":1,"launchedAt":"2026-07-20T00:00:00+09:00","optimizationEnabled":true,"cards":[{"id":"rakuten-five-zero-20260720","type":"rakuten_campaign","title":"本日は5と0のつく日","description":"楽天カード利用・当日のエントリーなど、楽天の条件を確認してお買い物ください。","buttonLabel":"楽天公式で確認","destinationUrl":"https://event.rakuten.co.jp/card/pointday/","trackedLinkId":"iemoto-rakuten-five-zero-20260720","startsAt":"2026-07-20T00:00:00+09:00","endsAt":"2026-07-21T00:00:00+09:00","priority":20},{"id":"rakuten-marathon-202607","type":"rakuten_campaign","title":"お買い物マラソン開催中","description":"ショップ買いまわりはエントリーと購入条件があります。楽天公式ページでご確認ください。","buttonLabel":"開催内容を見る","destinationUrl":"https://event.rakuten.co.jp/campaign/point-up/marathon/","trackedLinkId":"iemoto-rakuten-marathon-202607","startsAt":"2026-07-19T20:00:00+09:00","endsAt":"2026-07-26T01:59:00+09:00","priority":10},{"id":"rakuten-coupon-check","type":"rakuten_coupon_check","title":"あなたが使える楽天クーポン","description":"対象者や対象商品によって使えるクーポンが異なります。楽天へログインしてご確認ください。","buttonLabel":"使えるクーポンを確認","destinationUrl":"https://coupon.rakuten.co.jp/","trackedLinkId":"iemoto-rakuten-coupon-check","startsAt":"2026-07-20T00:00:00+09:00","endsAt":"2027-01-01T00:00:00+09:00","priority":5}]}' ,
  datetime('now', '+9 hours'),
  datetime('now', '+9 hours')
)
ON CONFLICT(line_account_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
