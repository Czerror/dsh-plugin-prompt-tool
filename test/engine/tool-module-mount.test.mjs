// 由 skill-search.test.mjs 与 tool-modules.test.mjs 并入（2026-09-17 测试归一精简）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry, renderSkillContent } from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { apply as applySkillSearch } from '../../engine/skill-search.mjs'

// —— 技能检索与加载（原 skill-search.test.mjs） ——

/** 只替代工具注册出口；目录裁决、调用策略与定义校验均走真实官方注册表。 */
function makeCtx(t, skills, provider = {}) {
  const registered = []
  const app = new Context()
  const registry = new SkillRegistry(app)
  const definitions = skills.map((skill) => ({
    description: 'test skill', content: 'skill instructions', source: 'custom', provider: 'test',
    invocation: { modelInvocable: true, userInvocable: true }, ...skill,
  }))
  const calls = { list: [], get: [] }
  const dispose = registry.registerProvider(() => ({
    name: 'test',
    list: async (options) => {
      calls.list.push(options)
      const candidates = definitions.map(({ content: _content, ...summary }) => ({ ...summary, rank: 300, locator: summary.name }))
      return provider.list ? provider.list(candidates, options) : candidates
    },
    get: async (candidate, options) => {
      calls.get.push(options)
      const definition = definitions.find((entry) => entry.name === candidate.name)
      return provider.get ? provider.get(definition, options) : definition
    },
  }))
  t.after(dispose)
  return {
    ctx: {
      tools: { register: (tool) => registered.push(tool) },
      skills: registry,
    },
    registered, app, registry, calls, definitions, dispose,
  }
}

const SKILLS = [
  { name: 'pdf-tools', description: 'Convert PDF files to markdown', whenToUse: 'document conversion' },
  { name: 'image-process', description: 'Resize and convert images', whenToUse: 'image editing' },
  { name: 'obsidian-vault', description: 'Search Obsidian vault notes', whenToUse: 'notes' },
]

const makeExec = () => {
  const injected = []
  return {
    exec: {
      agent: {
        session: { header: { cwd: '/ws' } },
        inject: (payload) => injected.push(payload),
      },
    },
    injected,
  }
}

test('apply 注册 skill_search + skill_load 两工具（schema 形状）', (t) => {
  const { ctx, registered } = makeCtx(t, SKILLS)
  applySkillSearch(ctx)
  assert.equal(registered.length, 2)
  const [search, load] = registered
  assert.equal(search.name, 'skill_search')
  assert.equal(search.parameters.type, 'object')
  assert.equal(search.parameters.additionalProperties, false)
  assert.deepEqual(search.parameters.required, ['query'])
  assert.equal(load.name, 'skill_load')
  assert.equal(load.output.schema.additionalProperties, false)
})

test('skill_search：query 大小写不敏感 + 多 token AND 匹配', async (t) => {
  const { ctx, registered } = makeCtx(t, SKILLS)
  applySkillSearch(ctx)
  const r = await registered[0].execute({ query: 'PDF convert' }, makeExec().exec)
  assert.ok(r.text.includes('pdf-tools'))
  assert.ok(!r.text.includes('image-process'))
})

test('skill_search：空 query 返回全部（超 20 截断并标注更多）', async (t) => {
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `skill-${String(i).padStart(2, '0')}`, description: `desc ${i}` }))
  const { ctx, registered } = makeCtx(t, many)
  applySkillSearch(ctx)
  const r = await registered[0].execute({ query: '' }, makeExec().exec)
  assert.ok(r.text.includes('skill-0'))
  assert.ok(r.text.includes('skill-19'))
  assert.ok(!r.text.includes('skill-20'))
  assert.ok(r.text.includes('5 more'))
})

test('skill_search：无匹配给出引导文案；发现不完整不声称没有技能', async (t) => {
  const { ctx, registered } = makeCtx(t, SKILLS)
  applySkillSearch(ctx)
  const none = await registered[0].execute({ query: 'zzz-none' }, makeExec().exec)
  assert.ok(none.text.includes('No skills match'))
  const boom = makeCtx(t, [], { list: async () => { throw new Error('registry down') } })
  applySkillSearch(boom.ctx)
  const down = await boom.registered[0].execute({ query: 'x' }, makeExec().exec)
  assert.match(down.text, /incomplete|unavailable/)
  assert.doesNotMatch(down.text, /No skills match/)
  const unknown = await boom.registered[1].execute({ name: 'missing' }, makeExec().exec)
  assert.match(unknown.text, /incomplete/)
  assert.doesNotMatch(unknown.text, /No skill named/)
  const partial = makeCtx(t, SKILLS, { list: (candidates) => ({ candidates, complete: false }) })
  applySkillSearch(partial.ctx)
  const found = await partial.registered[0].execute({ query: 'pdf' }, makeExec().exec)
  assert.match(found.text, /pdf-tools/)
  assert.match(found.text, /incomplete/)
})

test('skill_load：官方资源与正文包装完整注入，空正文不注入', async (t) => {
  const skills = [
    { name: 'pdf-tools', content: 'Read references/guide.md before scripts/convert.py.', resourceBase: { kind: 'directory', path: 'D:/skills/pdf-tools' } },
    { name: 'empty', content: '' },
  ]
  const { ctx, registered, definitions } = makeCtx(t, skills)
  applySkillSearch(ctx)
  const { exec, injected } = makeExec()
  const ok = await registered[1].execute({ name: 'pdf-tools' }, exec)
  assert.ok(ok.text.includes('Skill "pdf-tools" loaded'))
  assert.equal(injected.length, 1)
  assert.equal(injected[0].source.kind, 'skill-invocation')
  assert.equal(injected[0].content[0].text, renderSkillContent(definitions[0]))
  assert.match(injected[0].content[0].text, /Base directory for this skill: D:\/skills\/pdf-tools/)
  // 无内容 body → 不注入。
  const empty = await registered[1].execute({ name: 'empty' }, exec)
  assert.ok(empty.text.includes('no loadable body'))
  assert.equal(injected.length, 1, '空 body 不产生注入')
})

test('skill_load：不存在 / 无 agent 上下文给出明确文案', async (t) => {
  const { ctx, registered } = makeCtx(t, SKILLS)
  applySkillSearch(ctx)
  const missing = await registered[1].execute({ name: 'nope' }, makeExec().exec)
  assert.ok(missing.text.includes('No skill named "nope"'))
  const noAgent = await registered[1].execute({ name: 'pdf-tools' }, {})
  assert.ok(noAgent.text.includes('requires an agent context'))
  const disappeared = makeCtx(t, SKILLS, { get: async () => undefined })
  applySkillSearch(disappeared.ctx)
  const view = makeExec()
  const stale = await disappeared.registered[1].execute({ name: 'pdf-tools' }, view.exec)
  assert.match(stale.text, /no longer available/)
  assert.equal(view.injected.length, 0)
})

test('skill_search / skill_load：四种调用策略均在模型边界生效，直呼不能绕过', async (t) => {
  const policies = [
    ['both', true, true], ['model-only', true, false],
    ['user-only', false, true], ['disabled', false, false],
  ]
  const { ctx, registered, calls } = makeCtx(t, policies.map(([name, modelInvocable, userInvocable]) => ({
    name, invocation: { modelInvocable, userInvocable },
  })))
  applySkillSearch(ctx)
  const { exec, injected } = makeExec()
  const search = await registered[0].execute({ query: '' }, exec)
  for (const [name, modelInvocable] of policies) {
    assert.equal(search.text.includes(`- ${name}:`), modelInvocable, name)
    const before = injected.length
    const loaded = await registered[1].execute({ name }, exec)
    assert.equal(injected.length - before, modelInvocable ? 1 : 0, name)
    if (!modelInvocable) assert.doesNotMatch(loaded.text, /loaded;/)
  }
  assert.equal(calls.get.length, 2, '被停用的摘要必须在加载正文前拒绝')
})

test('skill_search：中文关键词保持 AND 匹配，不能退化成空查询', async (t) => {
  const { ctx, registered } = makeCtx(t, [
    { name: 'code-review', description: '代码审查与缺陷定位', whenToUse: '中文说明' },
    { name: 'image-edit', description: '图像处理' },
  ])
  applySkillSearch(ctx)
  const result = await registered[0].execute({ query: '代码 中文' }, makeExec().exec)
  assert.match(result.text, /code-review/)
  assert.doesNotMatch(result.text, /image-edit/)
  const missing = await registered[0].execute({ query: '不存在' }, makeExec().exec)
  assert.match(missing.text, /No skills match/)
})

test('skill_load：加载期间策略关闭或请求取消都不能注入', async (t) => {
  for (const mode of ['disabled', 'aborted']) {
    const entered = Promise.withResolvers()
    const finish = Promise.withResolvers()
    const { ctx, registered } = makeCtx(t, [{ name: 'changing' }], {
      get: async (definition) => { entered.resolve(); await finish.promise; return mode === 'disabled'
        ? { ...definition, invocation: { modelInvocable: false, userInvocable: true } }
        : definition },
    })
    applySkillSearch(ctx)
    const { exec, injected } = makeExec()
    const controller = new AbortController()
    exec.signal = controller.signal
    const pending = registered[1].execute({ name: 'changing' }, exec)
    await entered.promise
    if (mode === 'aborted') controller.abort(new Error('cancelled'))
    finish.resolve()
    const result = await pending
    assert.equal(injected.length, 0, mode)
    assert.doesNotMatch(result.text, /loaded;/)
  }
})

test('技能查找传递主/子 scope、cwd 与 signal，scope 释放后候选消失', async (t) => {
  const { ctx, registered, app, calls } = makeCtx(t, [{ name: 'global' }])
  applySkillSearch(ctx)
  const main = makeExec()
  const child = makeExec()
  const mainScope = createScope(app, main.exec.agent)
  const childScope = createScope(app, child.exec.agent, { parent: main.exec.agent })
  t.after(() => childScope.dispose())
  t.after(() => mainScope.dispose())
  mainScope.ctx.skills.register({ name: 'main-only', description: 'main', content: 'main body', source: 'runtime' })
  childScope.ctx.skills.register({ name: 'child-only', description: 'child', content: 'child body', source: 'runtime' })
  for (const [key, view] of [['main', main], ['child', child]]) {
    view.exec.agent.session.header.cwd = `/workspace/${key}`
    view.exec.signal = new AbortController().signal
    const searched = await registered[0].execute({ query: '' }, view.exec)
    assert.match(searched.text, /main-only/)
    assert.equal(searched.text.includes('child-only'), key === 'child')
    await registered[1].execute({ name: 'global' }, view.exec)
    for (const options of [calls.list.at(-1), calls.get.at(-1)]) {
      assert.equal(options.scope, view.exec.agent)
      assert.equal(options.cwd, `/workspace/${key}`)
      assert.equal(options.signal, view.exec.signal)
    }
    assert.equal(view.injected.length, 1)
  }
  await childScope.dispose()
  const afterDispose = await registered[0].execute({ query: 'child-only' }, child.exec)
  assert.match(afterDispose.text, /No skills match/)
})

// —— 内置工具模块挂载（原 tool-modules.test.mjs） ——

const modules = [
  ["character-tools", "pt-character-tools"],
  ["world-book-tools", "pt-world-book-tools"],
  ["session-var-tools", "pt-session-var-tools"],
]

/** tool-modules 组专用桩 ctx（与上面的 makeCtx 同名不同责，故分开命名）。 */
function makeToolModuleCtx(serviceKey, service) {
  const state = { warnings: [], disposers: [] }
  state.ctx = {
    get: (key) => key === serviceKey ? service : undefined,
    logger: { warn: (message) => state.warnings.push(message) },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === "function") state.disposers.push(dispose)
      return dispose
    },
  }
  return state
}

for (const [id, serviceKey] of modules) {
  const mod = await import("../../engine/" + id + ".mjs")
  test(id + "：按模块挂载对应工具服务", () => {
    const calls = []
    const state = makeToolModuleCtx(serviceKey, { mount: (ctx) => { calls.push(ctx); return () => calls.push("disposed") } })
    mod.apply(state.ctx)
    assert.deepEqual(calls, [state.ctx])
    assert.equal(state.disposers.length, 1)
    state.disposers[0]()
    assert.deepEqual(calls, [state.ctx, "disposed"])
  })

  test(id + "：服务缺失时降级", () => {
    const state = makeToolModuleCtx(serviceKey, undefined)
    mod.apply(state.ctx)
    assert.equal(state.disposers.length, 0)
    assert.equal(state.warnings.length, 1)
    assert.match(state.warnings[0], /service unavailable/)
  })
}
