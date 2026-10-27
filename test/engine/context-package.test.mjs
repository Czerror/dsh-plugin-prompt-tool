import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importHostCapability } from '../../engine/host-package.mjs'

test('可选宿主能力只接受已验证包与版本，并使用宿主的公开包实例', async () => {
  await assert.rejects(importHostCapability('@deepseek-ai/cordis'), /not declared/)
  const module = await importHostCapability('@deepseek-ai/dsh-llm')
  assert.equal(typeof module.createUserMessage, 'function')
  const message = module.createUserMessage({ content: [{ type: 'text', text: 'known' }], source: { kind: 'user' } })
  assert.equal(message.content[0].text, 'known')
})
