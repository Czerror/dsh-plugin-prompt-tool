import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-tui-rules-')
const { registerTuiCommand } = await import('../../src/runtime/tui.ts')

test('TUI 规则开关使用定义与显式互斥；未知身份不写，重建失败不假报成功', async () => {
  const dir = join(moduleRoot, 'tui-rules')
  mkdirSync(dir, { recursive: true })
  const body = id => ({ id, name: id, group: 'mode', exclusive: true, enabled: id === 'first', do: [{ id: 'body', kind: 'inject-text', config: { layer: 'pre-step', text: id } }] })
  const file = join(dir, 'module.yml')
  writeFileSync(file, JSON.stringify({ id: 'tui-rules', modules: [], configOrder: { first: 0, second: 100 }, rules: [body('first'), body('second')] }))
  let handler
  let refreshes = 0
  let rejectRefresh = false
  const ctx = { inject: (_deps, callback) => callback({ commands: { register: command => { handler = command.handler } } }) }
  registerTuiCommand(ctx, 'prompt-tool', () => ({ writePreset: true, skillCatalog: [], activeSkillsDirs: [] }),
    () => ({ available: true, providers: [] }), async () => ({}), () => dir,
    () => assert.fail('规则不能写入旧参数通道'), undefined, async id => {
      assert.equal(id, 'tui-rules'); refreshes++
      if (rejectRefresh) throw new Error('assembly unavailable')
    })
  const initial = readFileSync(file, 'utf8')
  assert.equal((await handler({ rawInput: 'config missing on' })).kind, 'error')
  assert.equal(readFileSync(file, 'utf8'), initial, '未知身份零写入')
  assert.equal(refreshes, 0)
  const activated = await handler({ rawInput: 'config second on' })
  assert.equal(activated.kind, 'success', activated.text)
  const saved = parse(readFileSync(file, 'utf8'))
  assert.deepEqual(saved.rules.map(rule => [rule.id, rule.enabled]), [['first', false], ['second', true]], '启用序号在后的卡也关闭同组前卡')
  assert.deepEqual(saved.configOrder, { first: 0, second: 100 }, '启用互斥不重排')
  assert.deepEqual(saved.rules[1].do, body('second').do, '不覆盖动作数组')
  assert.equal(saved.promptConfigs, undefined)
  assert.equal(refreshes, 1)
  const status = await handler({ rawInput: 'status' })
  assert.match(status.text, /config second.*开/)
  assert.match(status.text, /inject-text/)
  rejectRefresh = true
  const failed = await handler({ rawInput: 'config second off' })
  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /已保存.*重新装配失败/)
  assert.equal(parse(readFileSync(file, 'utf8')).rules[1].enabled, false)
})
