import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPromptConfigs } from '../../engine/executor.mjs'
import { createPromptConfigs } from '../../engine/schema.mjs'
import { instructionHintMessages, buildInstructionHintText } from '../../engine/instruction-hint.mjs'
import { createEpochPromotion } from '../../engine/compaction-epoch.mjs'
import { compileWhen } from '../../engine/conditions/index.mjs'

async function injected(spec, services = {}) {
  const handlers = new Map()
  const ctx = { get: key => services[key], on: (key, callback) => { handlers.set(key, callback); return () => handlers.delete(key) }, logger: { warn() {} } }
  const dispose = applyPromptConfigs(ctx, createPromptConfigs([{ id: 'probe', ...spec }]))
  const agent = { options: {}, session: { id: 'probe', header: { cwd: '/repo' }, snapshotEvents: () => [] } }
  const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }]
  const result = await handlers.get('agent/pre-step')({ agent, messages }, () => ({ kind: 'enter', messages }))
  dispose()
  return result.messages.slice(1).flatMap(message => message.content.map(block => block.text))
}

test('动态填充器：空正文不输出，显式模板与目录参数决定结果', async () => {
  assert.throws(() => createPromptConfigs([{ id: 'legacy', strategy: 'custom-fallback', text: 'OLD' }]), /migrat|迁移/)
  assert.deepEqual(await injected({ strategy: 'placeholder', fill: 'env-facts' }), [])
  const env = await injected({ strategy: 'placeholder', fill: 'env-facts', text: '{{ENV_FACTS}}' })
  assert.match(env[0], /- CWD=\/repo/)
  assert.doesNotMatch(env[0], /Environment facts:/)
  const services = { skills: { list: async () => Array.from({ length: 25 }, (_, index) => ({ name: 'skill-' + (index + 1), description: 'description-' + (index + 1) })) } }
  assert.deepEqual(await injected({ strategy: 'placeholder', fill: 'skill-catalog' }, services), [])
  assert.deepEqual(await injected({ strategy: 'placeholder', fill: 'skill-catalog', text: '{{SKILLS_TEXT}}' }, services), [])
  const all = await injected({ strategy: 'placeholder', fill: 'skill-catalog', text: '{{SKILLS_TEXT}}', params: { fields: 'name' } }, services)
  assert.equal(all[0].split('\n').length, 25)
  assert.deepEqual(await injected({ strategy: 'placeholder', fill: 'skill-catalog', params: { text: '{{SKILLS_TEXT}}', fields: 'name', limit: 2 } }, services), ['- skill-1\n- skill-2'])
})

test('指令提示：空模板不替换或丢弃官方消息，显式模板仍可转换一次', () => {
  const message = { id: 'official', role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'Instructions from: /repo/AGENTS.md\nbody' }] }
  const state = { instructionHinted: false }
  assert.deepEqual(instructionHintMessages([message], state), [message])
  assert.equal(state.instructionHinted, false)
  assert.deepEqual(instructionHintMessages([message], { instructionHinted: true }), [message])
  assert.deepEqual(instructionHintMessages([message], { instructionHinted: true }, 'test', { messageTemplate: '{{SUFFIX}}' }), [message])
  assert.equal(buildInstructionHintText({ root: '/repo', projectFiles: ['AGENTS.md'] }), '')
  const templates = { messageTemplate: '<hint>{{FILES}} {{SUFFIX}}</hint>', suffixTemplate: 'CUSTOM', projectTemplate: '{{ROOT}}/{{FILES}}' }
  const result = instructionHintMessages([message], state, 'test', templates)
  assert.equal(result[0].content[0].text, '<hint>/repo/AGENTS.md CUSTOM</hint>')
  assert.deepEqual(instructionHintMessages([message], state, 'test', templates), [])
  assert.equal(buildInstructionHintText({ root: '/repo', projectFiles: ['AGENTS.md'] }, 'project', templates), '/repo/AGENTS.md CUSTOM')
})

test('晋升门控：缺少正则不隐式识别锚词，显式正负正则经条件层生效', () => {
  const events = [{ type: 'tool/call', seq: 1 }, { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'reasoning', text: 'We proceed.' }] } } }]
  const session = { id: 'gate', header: {}, snapshotEvents: () => events }
  const agent = { session }
  assert.equal(createEpochPromotion([], { promoteGate: true }).status(agent).promoted, false)
  const when = compileWhen({ phase: { promoted: true, promoteGate: true, reasoningPattern: '\\bready\\b', reasoningNegativePattern: '\\bwait\\b', reasoningFlags: 'i' } })
  assert.equal(when(agent), false)
  const observe = text => { const event = { type: 'assistant/message', seq: events.length + 1, data: { message: { content: [{ type: 'reasoning', text }] } } }; events.push(event); when.observe(session, event) }
  observe('READY, wait')
  assert.equal(when(agent), false)
  observe('READY')
  assert.equal(when(agent), true)
})
