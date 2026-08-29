import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../../src/client/PromptWorkspace.module.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('../../src/client/sidebar-entry.ts', import.meta.url), 'utf8')

test('sidebar entry follows the task-board and memory-system layout contract', () => {
  assert.match(source, /stroke-width', '1\.5'/)
  assert.match(source, /dataset\.dshPlugin = 'prompt-tool'/)
  assert.match(source, /dataset\.dshPart = 'sidebar-entry'/)

  assert.match(css, /\.entry\s*\{[^}]*min-height:\s*36px;[^}]*gap:\s*10px;[^}]*padding:\s*0 10px;/s)
  assert.match(css, /\.entryIcon\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/s)
  assert.match(css, /\.entryIcon svg\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;/s)
  assert.match(css, /\.entry:hover\s*\{[^}]*--dsw-alias-interactive-bg-hover/s)
  assert.match(css, /\.entry\[data-active\]\s*\{[^}]*--dsw-alias-interactive-bg-active/s)

  const collapsed = css.match(/\[data-dsh-frame\]\[data-sidebar-collapsed\] \.entry\s*\{([^}]*)\}/s)?.[1] ?? ''
  assert.match(collapsed, /width:\s*36px/)
  assert.match(collapsed, /min-height:\s*36px/)
  assert.match(collapsed, /margin:\s*0 auto 12px/)
  assert.match(collapsed, /border-radius:\s*50%/)
})
