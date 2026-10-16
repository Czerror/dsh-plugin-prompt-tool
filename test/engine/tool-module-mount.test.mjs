// 由 skill-search.test.mjs 与 tool-modules.test.mjs 并入（2026-09-17 测试归一精简）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry, renderSkillContent } from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { apply as applySkillSearch } from '../../engine/skill-search.mjs'
import { toolServiceName } from '../../engine/service-names.mjs'

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
  const byName = new Map(definitions.map((entry) => [entry.name, entry]))
  /** 摘要只保留 frontmatter 字段；正文走 get，与真实 provider 同形。 */
  const summaryOf = (definition) => {
    const { content: _content, ...summary } = definition
    return summary
  }
  const dispose = registry.registerProvider(() => ({
    name: 'test',
    list: async (options) => {
      calls.list.push(options)
      const candidates = definitions.map((entry) => ({
        ...summaryOf(entry),
        rank: 300,
        locator: entry.name,
      }))
      return provider.list ? provider.list(candidates, options) : candidates
    },
    get: async (candidate, options) => {
      calls.get.push(options)
      const definition = byName.get(candidate.name)
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
  assert.deepEqual(search.parameters.required, [])
  assert.equal(load.name, 'skill_load')
  assert.equal(load.output.schema.additionalProperties, false)
})

test('skill_search：query 大小写不敏感 + 完整命中优先于近似命中', async (t) => {
  const { ctx, registered } = makeCtx(t, SKILLS)
  applySkillSearch(ctx)
  const r = await registered[0].execute({ query: 'PDF convert' }, makeExec().exec)
  assert.ok(r.text.includes('pdf-tools'))
  assert.ok(!r.text.includes('image-process'))
})

test('skill_search：空 query 给目录概览；命中超上限时截断并标注总数', async (t) => {
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `skill-${String(i).padStart(2, '0')}`, description: `desc ${i}` }))
  const { ctx, registered } = makeCtx(t, many)
  applySkillSearch(ctx)
  // 空 query 是目录概览（同 tool_search），不再是被截断的全量清单。
  const overview = await registered[0].execute({ query: '' }, makeExec().exec)
  assert.match(overview.text, /Skill catalog groups \(25 skills\): skill\*\(25\)/)
  assert.ok(!overview.text.includes('skill-0'))
  const r = await registered[0].execute({ query: 'desc' }, makeExec().exec)
  assert.ok(r.text.includes('skill-00'))
  assert.ok(r.text.includes('skill-19'))
  assert.ok(!r.text.includes('skill-20'))
  assert.ok(r.text.includes(`(20 of 25)`))
  assert.ok(r.text.includes('truncated at 20'))
})

test('skill_search：无匹配给出引导文案；发现不完整不声称没有技能', async (t) => {
  const { ctx, registered } = makeCtx(t, SKILLS)
  applySkillSearch(ctx)
  const none = await registered[0].execute({ query: 'zzz-none' }, makeExec().exec)
  assert.ok(none.text.includes('No skills match'))
  assert.ok(none.text.includes('does NOT mean the skill is unavailable'))
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
    name, description: 'policy-word', invocation: { modelInvocable, userInvocable },
  })))
  applySkillSearch(ctx)
  const { exec, injected } = makeExec()
  const search = await registered[0].execute({ query: 'policy-word' }, exec)
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

test('技能查找按 scope 隔离候选，scope 释放后候选消失', async (t) => {
  const { ctx, registered, app } = makeCtx(t, [{ name: 'global' }])
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
    // 空 query 是目录概览：main-only 与 global 同为整名（首段无连字符）→ main*(2)，
    // child-only → child*(1)，分组计数仍然证明 scope 隔离。
    // 空 query 是目录概览：main 与 global 同为整名 → main*(1) global(1)；
    // child 再加 child-only → child*(1)。分组计数即可证明 scope 隔离。
    const searched = await registered[0].execute({ query: '' }, view.exec)
    if (key === 'child') {
      assert.match(searched.text, /Skill catalog groups \(3 skills\): child\*\(1\) global\(1\) main\*\(1\)/)
    } else {
      assert.match(searched.text, /Skill catalog groups \(2 skills\): global\(1\) main\*\(1\)/)
      assert.ok(!searched.text.includes('child*'))
    }
    assert.equal(searched.text.includes('child*'), key === 'child')
    await registered[1].execute({ name: 'global' }, view.exec)
    assert.equal(view.injected.length, 1)
  }
  await childScope.dispose()
  // 释放的是 child 层：child-only 的层连同分组一起消失，父链的 main 与全局不受影响。
  const afterDispose = await registered[0].execute({ query: '' }, child.exec)
  assert.match(afterDispose.text, /Skill catalog groups \(2 skills\): global\(1\) main\*\(1\)/)
  assert.ok(!afterDispose.text.includes('child*'))
})

// —— 内置工具模块挂载（原 tool-modules.test.mjs） ——

// 服务名从引擎真值源派生，不再手抄（源级守卫见 service-names.test.mjs）。
const modules = [
  "module-import-tools",
  "module-rule-tools",
  "module-memory-tools",
  "module-variable-tools",
].map(id => [id, toolServiceName(id)])

/** tool-modules 组专用桩 ctx（与上面的 makeCtx 同名不同责，故分开命名）。 */
function makeToolModuleCtx(serviceKey, service) {
  const state = { disposers: [], pending: undefined }
  state.ctx = {
    get: (key) => key === serviceKey ? service : undefined,
    inject: (deps, callback) => {
      assert.deepEqual(deps, [serviceKey])
      state.pending = callback
      if (service !== undefined) callback(state.ctx)
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === "function") state.disposers.push(dispose)
      return dispose
    },
  }
  state.provide = (value) => { service = value; state.pending(state.ctx) }
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

  test(id + "：等待晚到服务后挂载并释放", () => {
    const state = makeToolModuleCtx(serviceKey, undefined)
    mod.apply(state.ctx)
    assert.equal(state.disposers.length, 0)
    let mounts = 0
    state.provide({ mount: () => { mounts++; return () => { mounts-- } } })
    assert.equal(mounts, 1)
    state.disposers[0]()
    assert.equal(mounts, 0)
  })
}
