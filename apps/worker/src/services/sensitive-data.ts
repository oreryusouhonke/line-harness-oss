export type RedactionResult = {
  text: string;
  piiTypes: string[];
  containsSensitiveData: boolean;
};

export function redactSensitiveText(input: string): RedactionResult {
  let text = String(input || '');
  const types = new Set<string>();

  // Context-specific prohibited secrets first.
  text = text.replace(/(?:セキュリティコード|CVV|CVC)\s*[:：]?\s*\d{3,4}/gi, () => {
    types.add('card_security_code');
    return '[セキュリティコードは削除されました]';
  });
  text = text.replace(/(?:パスワード|暗証番号|認証コード|ワンタイム(?:パスワード|コード)|OTP)\s*[:：]?\s*[A-Za-z0-9!@#$%^&*_-]{4,}/gi, (value) => {
    types.add(/暗証番号/.test(value) ? 'pin' : /認証|ワンタイム|OTP/i.test(value) ? 'auth_code' : 'password');
    return '[認証情報は削除されました]';
  });
  text = text.replace(/(?:マイナンバー|個人番号)\s*[:：]?\s*\d(?:[ -]?\d){11}/g, () => {
    types.add('my_number');
    return '[マイナンバーは削除されました]';
  });
  // 13–19 digit payment-card candidates. Keep order numbers containing letters.
  text = text.replace(/(?<![A-Za-z0-9])(?:\d[ -]?){12,18}\d(?![A-Za-z0-9])/g, (candidate) => {
    const digits = candidate.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return candidate;
    types.add('payment_card');
    return '[カード番号は削除されました]';
  });

  text = text.replace(/(?:電話|TEL|携帯)\s*[:：]?\s*0\d{1,4}[-ー‐ ]?\d{1,4}[-ー‐ ]?\d{3,4}/gi, () => {
    types.add('phone');
    return '[電話番号は保護されました]';
  });
  // 配送・注文対応では住所そのものが必要になるため、本文は置換しない。
  // 個人情報を含むことだけ記録し、既存の保持期限・アクセス管理は維持する。
  const containsPostalCode = /〒\s*\d{3}[-ー‐−]\d{4}/.test(text);
  const containsJapaneseAddress = /(?:東京都|北海道|(?:京都|大阪)府|[^\s、。]{2,3}県)[^\s、。]{1,40}/.test(text);
  if (containsPostalCode || containsJapaneseAddress) types.add('address');

  return { text, piiTypes: [...types], containsSensitiveData: types.size > 0 };
}

function luhn(value: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    let digit = Number(value[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
