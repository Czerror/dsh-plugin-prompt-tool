import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applySkillSearch } from '../../engine/skill-search.mjs'

/** 捕获注册工具 + mock skills 服务的桩 ctx。 */
function makeCtx(skills) {
  const registered = []
  return {
    ctx: {
      tools: { register: (tool) => registered.push(tool) },
      skills: {
        list: async () => skills ?? [],
        get: async (name) => (skills ?? []).find((s) => s.name === name),
      },
    },
    registered,
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

test('apply 注册 skill_search + skill_load 两工具（schema 形状）', () => {
  const { ctx, registered } = makeCtx(SKILLS)
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

test('skill_search：query 大小写不敏感 + 多 token AND 匹配', async () => {
  const { ctx, registered } = makeCtx(SKILLS)
  applySkillSearch(ctx)
  const r = await registered[0].execute({ query: 'PDF convert' }, makeExec().exec)
  assert.ok(r.text.includes('pdf-tools'))
  assert.ok(!r.text.includes('image-process'))
})

test('skill_search：空 query 返回全部（超 20 截断并标注更多）', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `skill-${i}`, description: `desc ${i}` }))
  const { ctx, registered } = makeCtx(many)
  applySkillSearch(ctx)
  const r = await registered[0].execute({ query: '' }, makeExec().exec)
  assert.ok(r.text.includes('skill-0'))
  assert.ok(r.text.includes('skill-19'))
  assert.ok(!r.text.includes('skill-20'))
  assert.ok(r.text.includes('5 more'))
})

test('skill_search：无匹配给出引导文案；list 抛错降级不抛', async () => {
  const { ctx, registered } = makeCtx(SKILLS)
  applySkillSearch(ctx)
  const none = await registered[0].execute({ query: 'zzz-none' }, makeExec().exec)
  assert.ok(none.text.includes('No skills match'))
  const boom = makeCtx([])
  boom.ctx.skills.list = async () => { throw new Error('registry down') }
  applySkillSearch(boom.ctx)
  const down = await boom.registered[0].execute({ query: 'x' }, makeExec().exec)
  assert.ok(down.text.includes('skill_search unavailable'))
})

test('skill_load：命中注入全文（含数组 content 拼接）+ 返回文案', async () => {
  const skills = [
    { name: 'pdf-tools', content: ['line one', { nested: true }] },
    { name: 'empty', content: '' },
  ]
  const { ctx, registered } = makeCtx(skills)
  applySkillSearch(ctx)
  const { exec, injected } = makeExec()
  const ok = await registered[1].execute({ name: 'pdf-tools' }, exec)
  assert.ok(ok.text.includes('Skill "pdf-tools" loaded'))
  assert.equal(injected.length, 1)
  assert.equal(injected[0].source.kind, 'skill-invocation')
  assert.ok(injected[0].content[0].text.includes('line one'))
  assert.ok(injected[0].content[0].text.includes('nested'))
  // 无内容 body → 不注入。
  const empty = await registered[1].execute({ name: 'empty' }, exec)
  assert.ok(empty.text.includes('no loadable body'))
  assert.equal(injected.length, 1, '空 body 不产生注入')
})

test('skill_load：不存在 / 无 agent 上下文给出明确文案', async () => {
  const { ctx, registered } = makeCtx(SKILLS)
  applySkillSearch(ctx)
  const missing = await registered[1].execute({ name: 'nope' }, makeExec().exec)
  assert.ok(missing.text.includes('No skill named "nope"'))
  const noAgent = await registered[1].execute({ name: 'pdf-tools' }, {})
  assert.ok(noAgent.text.includes('requires an agent context'))
})
