import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('宿主 CSS 选择器只允许出现在 host-surface.ts', () => {
  const host = read('src/client/host-surface.ts')
  for (const file of ['src/client/workspace-mount.tsx', 'src/client/sidebar-entry.ts']) {
    const source = read(file)
    assert.ok(!source.includes('[class*='), `${file} 不应包含 CSS 类选择器`)
    assert.ok(!source.includes('[data-pane='), `${file} 不应包含 data-pane 选择器`)
    assert.ok(!source.includes('querySelector('), `${file} 不应直接调用 querySelector`)
  }
  assert.ok(host.includes('[class*="centerCol"]'))
  assert.ok(host.includes('[data-pane="conversation"]'))
})
