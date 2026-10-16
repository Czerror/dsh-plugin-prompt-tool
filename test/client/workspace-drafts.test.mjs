import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceDrafts, hasWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'

// 真值源是手算样例：逐槽构造「有/没有未保存输入」，期望值由人来定，不由实现算。
// 这条判据是覆盖导入的最后一道数据保护（ModuleSwitcher 的覆盖导入守卫），此前全仓零测试。
const MOD = 'mod-a'
const OTHER = 'mod-b'
const field = (source, text, error = '') => ({ source, text, error })
const rule = (id, text) => ({ id, then: [{ id: 'x', kind: 'inject-text', config: { text } }] })

/** 每类草稿各造一份「与 saved 不同」的样例；键格式照真实构造点（`${moduleId}:${scope}`、`id:param:<名>`）。 */
function dirtyPool() {
  const drafts = createWorkspaceDrafts()
  drafts.rules.set(MOD, { entries: [{ key: 'rule-0', previousId: 'first', value: rule('first', 'EDITED') }], saved: [rule('first', 'FIRST')], fields: new Map(), loaded: true, validated: true, latest: 0, nextKey: 1 })
  drafts.tools.set(MOD, { tools: [{ id: 'shell' }], saved: [], expanded: new Set(), fields: new Map(), loaded: true, error: '', saving: false })
  drafts.persona.set(MOD, { latest: 0, value: { main: { prefix: 'A' } }, saved: { main: { prefix: 'B' } }, revision: 'r1', declared: true, loaded: true, error: '', saving: false })
  drafts.variables.set(`${MOD}:module`, { scope: 'module', variables: { owner: 'Mia' }, enabled: true, baseline: { scope: 'module', variables: { owner: 'Bob' }, enabled: true, revisions: {} }, loading: false, saving: false, error: '', latest: 0 })
  drafts.fields.set(`${MOD}:param:temperature`, field('0.7', '1.0'))
  return drafts
}

const only = (setup) => { const drafts = createWorkspaceDrafts(); setup(drafts); return drafts }

test('草稿池自答「哪些没保存」：六类草稿各自都算，相同内容不算', () => {
  assert.equal(hasWorkspaceDrafts(createWorkspaceDrafts(), MOD), false, '空池不脏')
  // 逐类单独构造：每一类都必须**自己能**让守卫拦住——少判一类就是静默丢用户输入。
  const cases = [
    ['rules 正文改过', (d) => d.rules.set(MOD, dirtyPool().rules.get(MOD))],
    ['tools 与 saved 不同', (d) => d.tools.set(MOD, dirtyPool().tools.get(MOD))],
    ['persona 与 saved 不同', (d) => d.persona.set(MOD, dirtyPool().persona.get(MOD))],
    ['variables 与 baseline 不同', (d) => d.variables.set(`${MOD}:module`, dirtyPool().variables.get(`${MOD}:module`))],
    ['fields 文本与源不同', (d) => d.fields.set(`${MOD}:param:temperature`, field('0.7', '1.0'))],
    ['fields 有校验错误', (d) => d.fields.set(`${MOD}:param:topP`, field('0.9', '0.9', 'bad'))],
  ]
  for (const [title, setup] of cases) assert.equal(hasWorkspaceDrafts(only(setup), MOD), true, title)
  // 反向：内容一致就不该拦（tools 的 JSON 比较是双向的，键顺序不同不算脏）。
  assert.equal(hasWorkspaceDrafts(only((d) => d.tools.set(MOD, { tools: [{ id: 'shell' }], saved: [{ id: 'shell' }], expanded: new Set(), fields: new Map(), loaded: true, error: '', saving: false })), MOD), false, 'tools 内容一致不脏')
})

test('草稿的主语：无主语不阻塞，别的模块的草稿不阻塞本模块', () => {
  assert.equal(hasWorkspaceDrafts(dirtyPool(), undefined), false, '无主语：草稿无法归属任何模块，既不阻塞也没有可写盘的内容')
  assert.equal(hasWorkspaceDrafts(dirtyPool(), OTHER), false, '只有 `other:param:<名>` 的草稿时，别的模块不该被拦')
  assert.equal(hasWorkspaceDrafts(dirtyPool(), MOD), true, '本模块的草稿照样拦住')
})
