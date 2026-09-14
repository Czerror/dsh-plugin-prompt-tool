import test from 'node:test'
import assert from 'node:assert/strict'
import { liftContentText, stripContentText } from '../../src/client/data/prompt-config-content.ts'

test('F2：普通卡 text/texts/params.text 原样保留，不被当内容资产剥离', () => {
  const card = {
    id: 'static-1',
    text: 'card body',
    texts: ['first', 'second'],
    params: { text: 'params body', keep: 1 },
  }
  const stripped = stripContentText(card)
  assert.equal(stripped, card)
  assert.equal(stripped.text, 'card body')
  assert.deepEqual(stripped.texts, ['first', 'second'])
  assert.equal(stripped.params.text, 'params body')
  assert.equal(stripped.params.keep, 1)
})

test('F2：内容资产（preset.md 注入卡）仍剥离文件通道正文，其余字段保留', () => {
  const card = {
    id: 'prompt-injector',
    text: 'preset body',
    params: { text: 'preset body', variables: { a: 'b' } },
  }
  const stripped = stripContentText(card)
  assert.equal('text' in stripped, false)
  assert.equal('text' in stripped.params, false)
  assert.deepEqual(stripped.params.variables, { a: 'b' })
  // 输入卡片不被就地修改（保存载荷基于副本）。
  assert.equal(card.text, 'preset body')
  assert.equal(card.params.text, 'preset body')
})

test('F2：草稿提升只把内容资产的 params.text 提到编辑框，普通卡不动', () => {
  const asset = liftContentText({ id: 'prompt-injector', params: { text: 'from file' } })
  assert.equal(asset.text, 'from file')
  const normal = { id: 'static-1', params: { text: 'params body' } }
  assert.equal(liftContentText(normal), normal)
  assert.equal('text' in liftContentText(normal), false)
  const edited = { id: 'prompt-injector', text: 'user edit', params: { text: 'from file' } }
  assert.equal(liftContentText(edited), edited)
})
