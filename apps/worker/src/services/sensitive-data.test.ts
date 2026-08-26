import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from './sensitive-data.js';

describe('redactSensitiveText', () => {
  it('removes payment card numbers before storage or AI use', () => {
    const result = redactSensitiveText('カードは 4111 1111 1111 1111 です');
    expect(result.text).not.toContain('4111');
    expect(result.piiTypes).toContain('payment_card');
  });
  it('removes security codes and authentication secrets', () => {
    const result = redactSensitiveText('CVV: 123 パスワード: secret99 認証コード 839201');
    expect(result.text).not.toMatch(/123|secret99|839201/);
    expect(result.containsSensitiveData).toBe(true);
  });
  it('keeps business order numbers', () => {
    expect(redactSensitiveText('注文番号 ABC-1234567890123').text).toContain('ABC-1234567890123');
  });
  it('protects phone numbers but keeps postal addresses available for order handling', () => {
    const result = redactSensitiveText('電話: 090-1234-5678 〒123-4567 東京都千代田区1-2-3');
    expect(result.text).not.toContain('090-1234-5678');
    expect(result.text).toContain('〒123-4567 東京都千代田区1-2-3');
    expect(result.piiTypes).toEqual(expect.arrayContaining(['phone', 'address']));
  });
  it('does not destroy order numbers or text following a postal code', () => {
    const order = redactSensitiveText('注文番号 123-4567 の商品はいつ届きますか？');
    expect(order.text).toBe('注文番号 123-4567 の商品はいつ届きますか？');
    const postal = redactSensitiveText('〒123-4567 東京都千代田区1-2-3 へ送ってください');
    expect(postal.text).toBe('〒123-4567 東京都千代田区1-2-3 へ送ってください');
    expect(postal.piiTypes).toContain('address');
  });
});
