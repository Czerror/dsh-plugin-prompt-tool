/**
 * 票 05：三协议互斥与主子投递。
 *
 * 接缝 A：真实引擎（SystemPrompt 服务 + createRuleRuntime）读回最终系统段正文，断言三种可观察结果、
 *         每请求单份协议、真实主子受众二选一与顺序；顺序另有独立锚点 fixture，不依赖其它票的资产。
 * 接缝 B：既有模块定义 / 规则事务 / 复制 / 导入导出链，断言默认选中、跨模块显式互斥、关闭不自动恢复、
 *         停用草稿保持与陈旧版本零发布。
 *
 * 期望值来源：规格实施决定 9、10、33 与故事 3/4；内容清单的协议字节数 1066／681／414 与首尾字面锚；
 * 普通／红队主／红队子是互斥组的两名成员（普通默认选中）。不依赖模型措辞、规则 hit 或执行位字符串。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { parse as parseYaml } from 'yaml'
import { compileRules } from '../../engine/rule-spec.mjs'
import { createRuleRuntime } from '../../engine/rule-runtime.mjs'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { rulePromptConfigOptions } = await import('../../src/host/module-slices.ts')
const { readModuleRules, editModuleRules } = await import('../../src/host/module-rules.ts')
const { setModuleEnabled } = await import('../../src/host/config-store.ts')
const { ensureModuleSeed, duplicateUserModule } = await import('../../src/host/module-catalog.ts')
const { moduleImportPreview, installModulePackage, expandModuleSource, exportModulePackage } = await import('../../src/host/module-package.ts')

const REPO = fileURLToPath(new URL('../../modules/', import.meta.url))
/** 内容清单的独立真值：字节数与首尾字面锚来自规格，不从实现反推。 */
const PROTOCOLS = {
  official: { module: 'unrestricted', file: 'official.md', bytes: 1066,
    start: '## Capability selection by task (mandatory)', end: 'this prompt does not remove them.' },
  lead: { module: 'redteam', file: 'redteam-lead.md', bytes: 681,
    start: '## Capability selection by task (redteam lead)', end: 'task-matched skill/MCP instructions are right.' },
  child: { module: 'redteam', file: 'redteam-child.md', bytes: 414,
    start: '## Capability selection by task (redteam executor)', end: 'do not re-delegate.' },
}
const protocolFile = (dir, key) => join(dir, PROTOCOLS[key].module, 'assets', 'protocols', PROTOCOLS[key].file)
const protocolText = (dir, key) => readFileSync(protocolFile(dir, key), 'utf8')
const occurrences = (text, needle) => text.split(needle).length - 1

/** 模块定义 → 编译规则；模块根可以是仓库包内目录，也可以是种子后的用户目录。 */
function compiledRules(root, moduleId) {
  const dir = join(root, moduleId)
  const source = parseYaml(readFileSync(join(dir, 'module.yml'), 'utf8'))
  return compileRules(source.rules, { moduleId, configOrder: source.configOrder ?? {}, variables: source.variables, promptConfigOptions: rulePromptConfigOptions(dir) })
}
const ruleOf = (rules, id) => rules.find(rule => rule.id === id)
/** 规则里所有资产引用：协议是受众分支里的两条动作，引用可能嵌在 then 分支中。 */
function templateFiles(value, found = []) {
  if (Array.isArray(value)) { for (const item of value) templateFiles(item, found) }
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'templateFile' && typeof item === 'string') found.push(item)
      else templateFiles(item, found)
    }
  }
  return found
}

/**
 * 真实引擎投递：规则运行时把文本注册到官方 SystemPrompt 服务，assemble 返回的就是最终请求的系统段。
 * agent.session.header.delegationDepth 是真实主子判据；session 缺席等于身份不可解析。
 */
async function deliver(sources, { depth = 0, session = true, id = 'protocol' } = {}) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  const agent = { id: 'agent-' + id, status: 'idle',
    ...(session ? { session: { id: 'session-' + id, header: { delegationDepth: depth }, snapshotEvents: () => [] } } : {}) }
  const scope = createScope(root, agent)
  agent.ctx = scope.ctx
  const runtime = createRuleRuntime(scope.ctx, { agent })
  try {
    runtime.replace(sources)
    const context = { agent, scope: scopeOf(scope.ctx), signal: new AbortController().signal }
    runtime.prepareAssembly(context)
    const assembled = await scope.ctx.get('systemPrompt').assemble(context)
    return assembled.sections.map(section => section.text ?? '').join('\n\n')
  } finally {
    runtime.dispose()
    await scope.dispose()
    await root.fiber.dispose()
  }
}

test('三份协议内容可编辑且许可完整，普通与红队同属一个跨模块互斥组，普通默认选中', () => {
  for (const [key, spec] of Object.entries(PROTOCOLS)) {
    const text = protocolText(REPO, key)
    assert.equal(Buffer.byteLength(text), spec.bytes, key + ' 精确字节数')
    assert.ok(text.startsWith(spec.start), key + ' 首行字面锚')
    assert.ok(text.endsWith(spec.end), key + ' 末行字面锚')
  }
  // 三份正文分别归各自模块，来源许可与归属留在模块定义首部（不因新增规则被剥离）。
  for (const moduleId of ['unrestricted', 'redteam']) {
    const head = readFileSync(join(REPO, moduleId, 'module.yml'), 'utf8')
    assert.match(head, /MIT License/, moduleId + ' 保留来源许可')
  }

  const official = ruleOf(compiledRules(REPO, 'unrestricted'), 'protocol-official')
  const redteam = ruleOf(compiledRules(REPO, 'redteam'), 'protocol-redteam')
  assert.equal(official.enabled !== false, true, '普通协议默认选中')
  assert.equal(redteam.enabled, false, '红队协议默认不选，只由显式事务启用')
  for (const rule of [official, redteam]) {
    assert.equal(rule.group, 'capability-protocol', '同一互斥组')
    assert.equal(rule.groupScope, 'cross-module', '显式跨模块范围')
    assert.equal(rule.exclusive, true, '互斥由显式启用事务决定')
  }
  // 协议序号必须落在正文与 Boost 之间，否则顺序验收直接失败。
  const order = parseYaml(readFileSync(join(REPO, 'unrestricted', 'module.yml'), 'utf8')).configOrder
  assert.ok(order['default-prompt'] < order['protocol-official'] && order['protocol-official'] < order.boost,
    'configOrder：正文 100 → 协议 150 → Boost 200')
})

test('三种可观察结果：普通对主/子一致，红队主与红队子各一份，任一时刻只有一份协议', async () => {
  const official = protocolText(REPO, 'official'), lead = protocolText(REPO, 'lead'), child = protocolText(REPO, 'child')
  const unrestricted = 'unrestricted', redteam = 'redteam'
  const sources = ({ officialEnabled, redteamEnabled }) => [
    { moduleId: unrestricted, rules: [{ ...ruleOf(compiledRules(REPO, unrestricted), 'protocol-official'), enabled: officialEnabled }] },
    { moduleId: redteam, rules: [{ ...ruleOf(compiledRules(REPO, redteam), 'protocol-redteam'), enabled: redteamEnabled }] },
  ]

  // 默认状态：普通协议对主会话与子代理是同一份内容。
  for (const [label, options] of [['主会话', { depth: 0 }], ['子代理', { depth: 1 }]]) {
    const text = await deliver(sources({ officialEnabled: true, redteamEnabled: false }), options)
    assert.equal(occurrences(text, official), 1, '普通协议在' + label + '投递一次')
    assert.equal(occurrences(text, lead) + occurrences(text, child), 0, '红队协议未选中时不投递')
  }

  // 显式选择红队后：主会话拿红队主协议，真实子代理拿红队子协议。
  const main = await deliver(sources({ officialEnabled: false, redteamEnabled: true }), { depth: 0 })
  assert.equal(occurrences(main, lead), 1, '真实主会话投红队主协议')
  assert.equal(occurrences(main, child), 0)
  assert.equal(occurrences(main, official), 0, '选择红队后普通协议不再投递')
  const delegated = await deliver(sources({ officialEnabled: false, redteamEnabled: true }), { depth: 1 })
  assert.equal(occurrences(delegated, child), 1, '真实子代理投红队子协议')
  assert.equal(occurrences(delegated, lead), 0, '红队内部不再同时投两份')

  // 并行 Agent：同一份规则源同时服务主会话与子代理，各自只拿到自己受众的一份。
  const [parallelMain, parallelChild] = await Promise.all([
    deliver(sources({ officialEnabled: false, redteamEnabled: true }), { depth: 0, id: 'parallel-main' }),
    deliver(sources({ officialEnabled: false, redteamEnabled: true }), { depth: 1, id: 'parallel-child' }),
  ])
  assert.equal(occurrences(parallelMain, lead), 1, '并行主会话拿红队主协议')
  assert.equal(occurrences(parallelMain, child), 0, '并行主会话不串子协议')
  assert.equal(occurrences(parallelChild, child), 1, '并行子代理拿红队子协议')
  assert.equal(occurrences(parallelChild, lead), 0, '并行子代理不串主协议')

  // 身份不可解析：两份红队协议都不投递，也不回退成普通协议。
  const unknown = await deliver(sources({ officialEnabled: false, redteamEnabled: true }), { session: false })
  for (const [key, text] of [['official', official], ['lead', lead], ['child', child]]) {
    assert.equal(occurrences(unknown, text), 0, '身份未知时不猜测受众：' + key)
  }

  // 关闭选中协议：不自动恢复另一分支，请求里没有协议。
  const closed = await deliver(sources({ officialEnabled: false, redteamEnabled: false }), { depth: 0 })
  for (const [key, text] of [['official', official], ['lead', lead], ['child', child]]) {
    assert.equal(occurrences(closed, text), 0, '关闭后没有协议：' + key)
  }
})

test('协议位于主体之后、Boost 之前：独立锚点验证顺序，不依赖其它票的资产', async () => {
  const anchor = { body: 'ANCHOR-BODY-ORDER-100', protocol: 'ANCHOR-PROTOCOL-ORDER-150', boost: 'ANCHOR-BOOST-ORDER-200' }
  const rules = [
    { id: 'body', enabled: true, then: [{ id: 'body', kind: 'inject-text', config: { layer: 'system-section', order: 100, text: anchor.body } }] },
    { id: 'protocol', enabled: true, then: [{ id: 'protocol', kind: 'inject-text', config: { layer: 'system-section', order: 150, text: anchor.protocol } }] },
    { id: 'boost', enabled: true, then: [{ id: 'boost', kind: 'inject-text', config: { layer: 'system-section', order: 200, text: anchor.boost } }] },
  ]
  const compiled = compileRules(rules, { moduleId: 'protocol-anchor', configOrder: { body: 100, protocol: 150, boost: 200 } })
  const text = await deliver([{ moduleId: 'protocol-anchor', rules: compiled }], { id: 'anchor' })
  const at = key => text.indexOf(anchor[key])
  assert.ok(at('body') >= 0 && at('protocol') > at('body') && at('boost') > at('protocol'),
    '顺序锚点：主体 → 协议 → Boost（实际 ' + JSON.stringify([at('body'), at('protocol'), at('boost')]) + '）')
  for (const key of Object.keys(anchor)) assert.equal(occurrences(text, anchor[key]), 1, key + ' 只出现一次')
})

test('显式跨模块互斥事务：启用红队关闭普通，停用模块草稿保持，关闭选中不自动恢复', async () => {
  const { moduleRoot } = isolatedHome('pt-protocol-select-')
  ensureModuleSeed(moduleRoot)
  const unrestrictedDir = join(moduleRoot, 'unrestricted'), redteamDir = join(moduleRoot, 'redteam')
  const selection = dir => Object.fromEntries(readModuleRules(dir).rules
    .filter(rule => rule.group === 'capability-protocol').map(rule => [rule.id, rule.enabled !== false]))

  setModuleEnabled(moduleRoot, 'unrestricted', true)
  setModuleEnabled(moduleRoot, 'redteam', true)
  assert.deepEqual(selection(unrestrictedDir), { 'protocol-official': true }, '普通协议默认选中')
  assert.deepEqual(selection(redteamDir), { 'protocol-redteam': false }, '红队协议默认不选')

  // 07／08 复用的就是这一个事务：读目标模块版本，再以 activateRuleId 显式启用。
  const enableRedteam = () => editModuleRules(redteamDir, { expectedRevisions: readModuleRules(redteamDir).revisions, activateRuleId: 'protocol-redteam' })
  enableRedteam()
  assert.deepEqual(selection(redteamDir), { 'protocol-redteam': true })
  assert.deepEqual(selection(unrestrictedDir), { 'protocol-official': false }, '启用红队时同一事务关闭普通协议')

  // 再选回普通协议：互斥是双向的，红队被显式关闭。
  editModuleRules(unrestrictedDir, { expectedRevisions: readModuleRules(unrestrictedDir).revisions, activateRuleId: 'protocol-official' })
  assert.deepEqual(selection(unrestrictedDir), { 'protocol-official': true })
  assert.deepEqual(selection(redteamDir), { 'protocol-redteam': false }, '选回普通协议时红队被关闭')

  // 关闭选中协议：不自动恢复另一分支。
  enableRedteam()
  const snap = readModuleRules(redteamDir)
  const rule = snap.rules.find(item => item.id === 'protocol-redteam')
  editModuleRules(redteamDir, { expectedRevisions: snap.revisions, edits: [{ previousId: 'protocol-redteam', rule: { ...rule, enabled: false }, settingsChanged: true }] })
  assert.deepEqual(selection(redteamDir), { 'protocol-redteam': false })
  assert.deepEqual(selection(unrestrictedDir), { 'protocol-official': false }, '关闭选中协议不自动恢复普通协议')
  const text = await deliver([
    { moduleId: 'unrestricted', rules: [ruleOf(compiledRules(moduleRoot, 'unrestricted'), 'protocol-official')] },
    { moduleId: 'redteam', rules: [ruleOf(compiledRules(moduleRoot, 'redteam'), 'protocol-redteam')] },
  ], { id: 'closed' })
  for (const key of Object.keys(PROTOCOLS)) assert.equal(occurrences(text, protocolText(REPO, key)), 0, '关闭后请求里没有协议：' + key)

  // 停用模块的草稿不参与：红队模块退出装配后，它的协议开关保持原样。
  setModuleEnabled(moduleRoot, 'redteam', false)
  const draft = readModuleRules(redteamDir)
  const draftRule = draft.rules.find(item => item.id === 'protocol-redteam')
  editModuleRules(redteamDir, { expectedRevisions: draft.revisions, edits: [{ previousId: 'protocol-redteam', rule: { ...draftRule, enabled: true }, settingsChanged: true }] })
  editModuleRules(unrestrictedDir, { expectedRevisions: readModuleRules(unrestrictedDir).revisions, activateRuleId: 'protocol-official' })
  assert.deepEqual(selection(redteamDir), { 'protocol-redteam': true }, '停用模块的草稿不被跨模块事务改写')
  assert.deepEqual(selection(unrestrictedDir), { 'protocol-official': true })
})

test('保存、复制与导入导出后三份协议的选择、引用与资产一致', async () => {
  const { moduleRoot } = isolatedHome('pt-protocol-roundtrip-')
  ensureModuleSeed(moduleRoot)
  const redteamDir = join(moduleRoot, 'redteam')
  // 用户覆盖一份协议正文：编辑保存后再复制／导出，内容与选择一起往返。
  const leadFile = join(redteamDir, 'assets', 'protocols', 'redteam-lead.md')
  mkdirSync(join(redteamDir, 'assets', 'protocols'), { recursive: true })
  writeFileSync(leadFile, 'USER LEAD PROTOCOL')
  editModuleRules(redteamDir, { expectedRevisions: readModuleRules(redteamDir).revisions, activateRuleId: 'protocol-redteam' })
  const saved = readModuleRules(redteamDir)
  assert.equal(ruleOf(saved.rules, 'protocol-redteam').enabled, true, '选择已保存')
  assert.deepEqual(templateFiles(ruleOf(saved.rules, 'protocol-redteam')).sort(),
    ['./assets/protocols/redteam-child.md', './assets/protocols/redteam-lead.md'], '两份正文引用随定义往返')

  const copied = duplicateUserModule('redteam', moduleRoot)
  assert.equal(copied.ok, true, copied.message)
  const copyDir = join(moduleRoot, copied.id)
  assert.equal(ruleOf(readModuleRules(copyDir).rules, 'protocol-redteam').enabled, true, '复制保留选择')
  assert.equal(readFileSync(join(copyDir, 'assets', 'protocols', 'redteam-lead.md'), 'utf8'), 'USER LEAD PROTOCOL', '复制保留用户正文覆盖')
  assert.equal(readFileSync(join(copyDir, 'assets', 'protocols', 'redteam-child.md'), 'utf8'), protocolText(REPO, 'child'), '未编辑的那份逐字节一致')

  const exported = await exportModulePackage(moduleRoot, { id: copied.id, mode: 'zip' })
  const files = await expandModuleSource([{ path: 'protocol.zip', content: exported.content, encoding: 'base64' }])
  assert.deepEqual(files.filter(file => file.path.startsWith('assets/protocols/')).map(file => file.path).sort(),
    ['assets/protocols/redteam-child.md', 'assets/protocols/redteam-lead.md'], '导出包含两份协议资产')
  const restoredId = 'redteam-protocol-exported'
  const preview = moduleImportPreview(moduleRoot, files, { targetId: restoredId })
  await installModulePackage(moduleRoot, files, { targetId: restoredId, overwrite: preview.summary.exists,
    expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision })
  const restored = readModuleRules(join(moduleRoot, restoredId))
  assert.equal(ruleOf(restored.rules, 'protocol-redteam').enabled, true, '导入保留选择')
  assert.equal(readFileSync(join(moduleRoot, restoredId, 'assets', 'protocols', 'redteam-lead.md'), 'utf8'), 'USER LEAD PROTOCOL', '导入后用户正文一致')
  assert.equal(readFileSync(join(moduleRoot, restoredId, 'assets', 'protocols', 'redteam-child.md'), 'utf8'), protocolText(REPO, 'child'), '导入后包内正文一致')
})

test('陈旧版本与冲突零发布：过期版本的选择不写盘', () => {
  const { moduleRoot } = isolatedHome('pt-protocol-conflict-')
  ensureModuleSeed(moduleRoot)
  const redteamDir = join(moduleRoot, 'redteam')
  const stale = readModuleRules(redteamDir).revisions
  // 另一位作者先发布一次选择（设置版本推进），再重放旧版本：必须冲突且零写入。
  editModuleRules(redteamDir, { expectedRevisions: stale, activateRuleId: 'protocol-redteam' })
  const accepted = readFileSync(join(redteamDir, 'module.yml'), 'utf8')
  assert.throws(() => editModuleRules(redteamDir, { expectedRevisions: stale, activateRuleId: 'protocol-redteam' }),
    error => error.status === 409 && error.code === 'rules-conflict', '陈旧版本按冲突拒绝')
  assert.equal(readFileSync(join(redteamDir, 'module.yml'), 'utf8'), accepted, '陈旧版本零写入')
  assert.equal(ruleOf(readModuleRules(redteamDir).rules, 'protocol-redteam').enabled, true, '已发布的选择不被陈旧重放改写')
})
