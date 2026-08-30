import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import FlexPreview from './flex-preview'

describe('FlexPreview', () => {
  it('renders LINE template carousels instead of exposing their JSON', () => {
    const content = JSON.stringify({
      type: 'template',
      altText: 'デザインの作り方を選んでください',
      contents: null,
      template: {
        type: 'carousel',
        columns: [{
          title: '文章や画像で作る',
          text: '文章で相談するか、参考画像を送って作ります。',
          actions: [{ type: 'message', label: 'この方法で作る', text: '文章や画像で作る' }],
        }],
      },
    })

    const html = renderToStaticMarkup(<FlexPreview content={content} />)
    expect(html).toContain('文章や画像で作る')
    expect(html).toContain('この方法で作る')
    expect(html).not.toContain('&quot;type&quot;')
  })
})
