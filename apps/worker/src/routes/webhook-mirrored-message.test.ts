import { describe, expect, it } from 'vitest';
import { mirroredMessageContent } from './webhook.js';

describe('mirroredMessageContent', () => {
  it('stores Flex contents without wrapping the LINE message envelope', () => {
    const contents = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } };
    expect(mirroredMessageContent({ type: 'flex', altText: 'preview', contents })).toEqual({
      messageType: 'flex',
      content: JSON.stringify(contents),
    });
  });

  it('preserves template messages as template history records', () => {
    const template = {
      type: 'carousel',
      columns: [{ title: '文章や画像で作る', text: '作り方を選びます', actions: [] }],
    };
    const result = mirroredMessageContent({ type: 'template', altText: 'デザインの作り方', template });

    expect(result.messageType).toBe('template');
    expect(JSON.parse(result.content)).toEqual({
      type: 'template',
      altText: 'デザインの作り方',
      template,
    });
  });
});
