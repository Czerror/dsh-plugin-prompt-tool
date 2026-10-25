import test from 'node:test'
import assert from 'node:assert/strict'
import { renderElement, withSsr } from './support/ssr-render.mjs'

const { PublicationNotice } = await withSsr([
  new URL('../../src/client/ui/PublicationNotice.tsx', import.meta.url).href,
])

test('PublicationNotice：待发布显示错误与重试按钮，非待发布不渲染', () => {
  const pending = renderElement(PublicationNotice, {
    publication: { pending: true, error: '已保存，发布失败' },
    onRetry: () => {},
    pendingLabel: '待发布',
    retryLabel: '重试发布',
  })
  assert.match(pending, /role="alert"/)
  assert.match(pending, /已保存，发布失败/)
  assert.match(pending, /重试发布/)
  assert.equal(renderElement(PublicationNotice, { publication: { pending: false }, pendingLabel: '待发布', retryLabel: '重试发布' }), '')
  assert.equal(renderElement(PublicationNotice, { publication: undefined, pendingLabel: '待发布', retryLabel: '重试发布' }), '')
})
