import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt, renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createPromptConfigs } from '../../engine/schema.mjs'
import { wireLayers } from '../../engine/layers.mjs'
import { setSessionVar } from '../../engine/session-vars.mjs'

async function harness(t) {
  const root = new Context()
  const home = mkdtempSync(join(process.cwd(), 'pt-official-vars-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    try {
      await root.fiber.dispose()
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
  })
  await root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  return {
    root,
    async mount(specs, prepare = () => {}) {
      const key = {}
      const warnings = []
      let scope
      await root.plugin(Object.assign((inner) => {
        scope = createScope(inner, key)
        const configs = createPromptConfigs(specs)
        prepare(scope.ctx, configs)
        wireLayers(scope.ctx, configs, (message) => warnings.push(message))
      }, { inject: ['systemPrompt'] }))
      return { ...scope, key, warnings }
    },
    assemble(scope, session) {
      return root.systemPrompt.assemble({ scope: scope.key, agent: { session, options: {} } })
    },
  }
}

function sessionWith(text = 'LATEST', id = 'main') {
  return {
    id,
    header: { cwd: process.cwd(), delegationDepth: 0 },
    snapshotEvents: () => [{ type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } }],
  }
}

test('官方同 scope：局部同名变量分别绑定，大小写事实只注册一次，等价绑定复用', async (t) => {
  const h = await harness(t)
  const scope = await h.mount([
    { id: 'a', layer: 'system-section', text: 'A={{tone}} {{lastusermessage}}/{{lastUserMessage}}', variables: { tone: 'A', unused: '不注册' } },
    { id: 'a2', layer: 'system-section', text: 'A2={{tone}}', variables: { tone: 'A', unused: '不注册' } },
    { id: 'b', layer: 'runtime-context', text: 'B={{tone}}', variables: { tone: 'B' } },
  ])
  const assembly = await h.assemble(scope, sessionWith())
  assert.equal(renderPrompt(assembly), 'A=A LATEST/LATEST\n\nA2=A')
  assert.deepEqual(renderContextSections(assembly), [{ name: 'b', text: 'B=B' }])
  assert.equal(assembly.variables.lastusermessage, 'LATEST')
  assert.equal(Object.hasOwn(assembly.variables, 'unused'), false)
  assert.equal(Object.keys(assembly.variables).length, 3, '两个 tone 绑定和一个运行时事实')
  assert.deepEqual(scope.warnings, [])
})

test('官方 assembly：嵌套内容值和会话覆盖值先解析再清洗；循环引用不让组装失败', async (t) => {
  const h = await harness(t)
  const scope = await h.mount([{ id: 'nested', layer: 'system-section', text: '{{body}}', variables: { body: 'A{{tone}}{{missing}}', tone: 'B' } }])
  const session = sessionWith()
  assert.equal(renderPrompt(await h.assemble(scope, session)), 'AB')
  setSessionVar(session, 'body', 'S{{tone}}/{{missing}}')
  assert.equal(renderPrompt(await h.assemble(scope, session)), 'SB/')
  setSessionVar(session, 'body', '{{body}}OK')
  assert.ok(renderPrompt(await h.assemble(scope, session)).endsWith('OK'))
  assert.ok(scope.warnings.some(w => w.includes('missing')))
})

test('官方 assembly：空白引用规范化，随机每次重算，兄弟scope和disposer不串', async (t) => {
  const h = await harness(t)
  const a = await h.mount([{ id: 'random', layer: 'system-section', text: '{{time}}/{{ time }}/{{random::A::B}}/{{random::A::B}}' }])
  const b = await h.mount([{ id: 'random', layer: 'system-section', text: 'OTHER' }])
  const session = sessionWith()
  let index = 0
  t.mock.method(Math, 'random', () => [0, 0.99, 0.99, 0][index++ % 4])
  assert.match(renderPrompt(await h.assemble(a, session)), /\/A\/B$/)
  assert.match(renderPrompt(await h.assemble(a, session)), /\/B\/A$/)
  assert.equal(renderPrompt(await h.assemble(b, session)), 'OTHER')
  await a.dispose()
  assert.equal(renderPrompt(await h.assemble(a, session)), '')
  assert.equal(renderPrompt(await h.assemble(b, session)), 'OTHER')
})

test('ST 模板经过真实官方 assembly 求值；两个插入点同一步只执行一次赋值', async (t) => {
  const h = await harness(t)
  const scope = await h.mount([
    { id: 'set', order: 0, layer: 'system-section', text: '{{incvar::n}}', params: { stMacros: true } },
    { id: 'get', order: 1, layer: 'runtime-context', text: '{{getvar::n}}', params: { stMacros: true } },
  ])
  const session = sessionWith()
  let step = 1
  session.snapshotEvents = () => [{ type: step === 1 ? 'turn/start' : 'step/end', seq: step, data: { turn: 1, step: step - 1 } }]
  const first = await h.assemble(scope, session)
  assert.equal(renderPrompt(first), '1')
  assert.deepEqual(renderContextSections(first), [{ name: 'get', text: '1' }])
  assert.equal(renderPrompt(await h.assemble(scope, session)), '1')
  step++
  assert.equal(renderPrompt(await h.assemble(scope, session)), '2')
  const child = sessionWith('CHILD', 'child')
  child.header.delegationDepth = 1
  assert.equal(renderPrompt(await h.assemble(scope, child)), '1')
})
