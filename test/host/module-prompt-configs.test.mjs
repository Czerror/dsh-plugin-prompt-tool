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
// 注意：本文件在被测模块之前设置 env 只是**风格**（让 fixture 与断言的根一眼一致）；
// paths.ts 自 2026-10-16 起按调用求值，不再有 import 期冻结，动态 import 也不再是必须。
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
