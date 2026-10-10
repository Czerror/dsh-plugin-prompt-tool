// 规则切片的物化契约：writeModule 只消费 canonical rules，配置与部署设置各归其所有者。
//（合并自原 module-prompt-configs.test.mjs：迁移器与 promptConfigs 目录加载退场后，
//  该文件只剩「旧参数经迁移器生成配置」的用例，按测试准入原则删除；保留段原位保留。）
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, parseDocument } from 'yaml'

// 隔离 DSH_HOME：writeModule 的模板解析（resolveModuleDir）用户模块优先——
// 真实用户环境 .prompt-tool/<id> 会遮蔽包内模板，测试必须隔离。
// 注意：paths 模块顶层缓存 MODULES_DIR（join(DSH_HOME, ...)），
// host/index 必须全部在 env 设置后动态 import，否则读到真实用户根。
const home = mkdtempSync(join(tmpdir(), 'pt-prompt-configs-home-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})
const { FIXTURE_MODULE_ID, installFixtureModule } = await import('../fixtures/module-template.mjs')
const { Config, readModulesEnabled } = await import('../../src/config.ts')
const { createPromptConfigs } = await import('../../engine/schema.mjs')
const { writeModule } = await import('../../src/host/write-module.ts')
const { promptConfigToRule } = await import('../../src/host/rule-builder.ts')
// 模板定位契约以打包目录 lib/ 为锚；其余行为直接覆盖当前源码。
const { loadPromptTemplates } = await import('../../lib/index.mjs')
const { loadModuleSpec } = await import('../../src/host/manifest.ts')
const { injectionConfigSpec } = await import('../../engine/rule-spec.mjs')

/** 夹具的 canonical 规则切片；传入 rules 时改写定义，验证 writer 的物化边界。 */
function generatedConfigs(rules) {
  const dir = mkdtempSync(join(tmpdir(), 'pt-wp-configs-'))
  try {
    installFixtureModule(dir)
    const file = join(dir, FIXTURE_MODULE_ID, 'module.yml')
    if (rules !== undefined) {
      const doc = parseDocument(readFileSync(file, 'utf8'))
      doc.set('rules', doc.createNode(rules))
      doc.set('configOrder', doc.createNode(Object.fromEntries(rules.map((rule, index) => [rule.id, index * 10]))))
      writeFileSync(file, doc.toString())
    }
    writeModule({ modulesRoot: dir, moduleId: FIXTURE_MODULE_ID })
    const source = loadModuleSpec(join(dir, FIXTURE_MODULE_ID))
    const specs = source.rules.flatMap(rule => rule.then.filter(action => action.kind === 'inject-text').map(action => ({
      ...injectionConfigSpec(rule, action, source), enabled: rule.enabled !== false,
    })))
    const byId = Object.fromEntries(specs.map((spec) => [spec.id, spec]))
    return { specs, byId, rules: Object.fromEntries(parse(readFileSync(file, 'utf8')).rules.map(rule => [rule.id, rule])) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('writeModule 物化夹具的规则切片：配置 id、层、角色与顺序原样保留', () => {
  const { specs } = generatedConfigs()
  assert.deepEqual(specs.map((spec) => spec.id), ['near-anchor', 'router-guide', 'prompt-injector'])
  for (const spec of specs) {
    assert.equal(spec.layer, 'pre-step')
    assert.equal(spec.configKind, 'ordered')
    assert.equal(typeof spec.order, 'number')
    assert.equal(spec.role, 'user')
  }
})

test('writeModule 保留作者定义的锚句与确认词，不注入引擎默认', () => {
  const anchor = text => promptConfigToRule({
    id: 'prompt-injector', strategy: 'custom-fallback', layer: 'pre-step', position: 'before-all',
    text, params: { firstTurnWord: '' },
  })
  const { byId, rules } = generatedConfigs([anchor('Start your reasoning with the exact sentence: Go now.')])
  assert.equal(byId['prompt-injector'].strategy, 'anchor-notice')
  assert.equal(byId['prompt-injector'].text, 'Start your reasoning with the exact sentence: Go now.')
  assert.equal(byId['prompt-injector'].params.firstTurnWord, '', '确认词无内置默认（默认值归模板/预设）')
  assert.deepEqual(rules['prompt-injector'].if.anchor.keys, [], '未声明确认词时锚定条件不自行猜测关键词')
  assert.equal(typeof rules['prompt-injector'].if.anchor.fallbackAfter, 'number')
  // 显式停用的规则照常物化但保持停用：writer 不替作者选择赢家。
  const disabled = generatedConfigs([{ ...anchor('Go now.'), enabled: false }])
  assert.equal(disabled.byId['prompt-injector'].enabled, false)
})

test('writeModule 保留作者定义的规则条件（模型范围归规则级 if）', () => {
  const rule = promptConfigToRule({ id: 'router-guide', strategy: 'guide-auto', layer: 'pre-step', modelScope: 'flash' })
  const { rules, byId } = generatedConfigs([rule])
  assert.ok((rules['router-guide'].if.all ?? [rules['router-guide'].if]).some(condition => condition.scope?.modelScope === 'flash'))
  assert.equal(byId['router-guide'].strategy, 'guide-auto')
})

test('Config：部署设置仅保留模块运行总闸', () => {
  const config = Config({})
  assert.deepEqual(Object.keys(config), ['modulesEnabled'])
  assert.equal(readModulesEnabled({}), true)
  assert.equal(readModulesEnabled({ modulesEnabled: false }), false)
  assert.throws(() => readModulesEnabled({ modulesEnabled: 1 }), /必须是布尔值/)
})

// —— 模板库（原 templates.test.mjs） ——

test('模板库全部条目通过引擎权威校验（模板即合法配置）', async () => {
  for (const template of loadPromptTemplates()) {
    assert.doesNotThrow(() => createPromptConfigs([template.spec]), template.file)
  }
})
