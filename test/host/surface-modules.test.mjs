// 内置模块 skill-surface / tool-surface：包内分发物的内容契约。
//
// 断言面各自有独立真值源：
//   1. 定义合法性归唯一引擎编译器（compileRules），不复刻规则校验；
//   2. 跨模块契约的真值在对端产物里——tool-surface 的 `allowFrom` 对齐
//      `engine/dev-tool-search.mjs` 的注册名与参数键，skill-surface 的白名单对齐
//      ponytail 与宿主侧实际注入的 source.kind。
//
// 目录内容也是一条契约：包内 `modules/<id>/` 只放 `module.yml`，`rules/` 切片由
// `ensureModuleSlices` 运行时生成（带 `_integrity` 指纹）。`npm pack` 打的是**工作区**
// 文件而不是 git 跟踪文件，所以混进来的切片会真被打进 tgz——这一条直接锁目录内容。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
// @ts-expect-error 定义合法性归唯一引擎编译器，测试直接调它而不是复刻规则。
import { compileRules } from '../../engine/rule-spec.mjs'
// @ts-expect-error 跨模块契约的对端：插件注册侧的公开导出。
import { apply as applyDevToolSearch } from '../../engine/dev-tool-search.mjs'

const modulesDir = fileURLToPath(new URL('../../modules/', import.meta.url))
const loadModule = (id) => parseYaml(readFileSync(join(modulesDir, id, 'module.yml'), 'utf8'), { logLevel: 'silent' })

const skillSurface = loadModule('skill-surface')
const toolSurface = loadModule('tool-surface')
const toolTemplate = parseYaml(
  readFileSync(new URL('../../templates/80-tool-surface.yml', import.meta.url), 'utf8'),
  { logLevel: 'silent' },
)

/** 模板声明的核心常驻集（与 engine/dev-tool-search.mjs 的 RESIDENT 应对应）。 */
const EXPECTED_ALLOW = ['pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'skill_search', 'skill_load', 'dev_tool_search']

const toolRule = toolSurface.rules.find((rule) => rule.id === 'tool-surface-resident')
const narrowTools = toolRule.then.find((action) => action.kind === 'assembly')
const skillRule = skillSurface.rules.find((rule) => rule.id === 'skill-surface-narrowing')
const dropCatalog = skillRule.then.find((action) => action.kind === 'pre-step-filter')

test('内置模块：skill-surface / tool-surface 定义通过引擎权威校验', () => {
  for (const [id, spec] of [['skill-surface', skillSurface], ['tool-surface', toolSurface]]) {
    assert.equal(spec.id, id, `${id}: 定义 id 与目录名一致`)
    // 只 parseYaml 会漏掉引擎侧不变量（真踩过：同规则内两个分支动作重名，YAML 合法、引擎拒绝）。
    assert.doesNotThrow(() => compileRules(spec.rules, { configOrder: spec.configOrder ?? {} }),
      `${id}: module.yml 的 rules 必须被引擎接受`)
  }
})

test('内置模块：包内目录只含 module.yml，运行时切片不随包分发', () => {
  for (const id of ['ponytail', 'skill-surface', 'tool-surface']) {
    assert.deepEqual(readdirSync(join(modulesDir, id)).sort(), ['module.yml'],
      `${id}: rules/ 与 configs/ 都是运行时产物，进工作区就会被打进 npm 包`)
  }
})

test('内置模块 tool-surface：allowFrom 与 dev-tool-search 写入端同名同键（跨模块契约）', () => {
  // 名字或键任一写错，解锁就是**静默无效**（当次请求用完即被裁、无告警）。
  assert.deepEqual(narrowTools.target.tools.allowFrom, { tool: 'dev_tool_search', key: 'toolNames' })
  assert.deepEqual(narrowTools.target.tools.allow, EXPECTED_ALLOW)
  assert.equal(narrowTools.target.tools.requireMatch, true, '缺任一工具必须 fail-open 到完整目录')

  const registered = []
  applyDevToolSearch({ tools: { register: (definition) => { registered.push(definition); return () => {} }, schemas: () => [] } })
  assert.equal(registered[0].name, narrowTools.target.tools.allowFrom.tool, 'allowFrom.tool 必须等于插件注册的工具名')
  const key = narrowTools.target.tools.allowFrom.key
  assert.ok(Object.hasOwn(registered[0].parameters.properties, key), `插件的参数里必须有 ${key}`)
  assert.equal(registered[0].parameters.properties[key].type, 'array')
})

test('内置模块 tool-surface：与 templates/80-tool-surface.yml 同一声明不漂移', () => {
  // 同一行为的两个分发面（内置模块 / 模板）。改一边忘另一边，只会表现为「某个部署收窄没生效」。
  const templateAction = toolTemplate.then.find((action) => action.kind === 'assembly')
  assert.deepEqual(narrowTools.target.tools, templateAction.target.tools)
  assert.deepEqual(toolRule.if, toolTemplate.if, '相位两支必须一致')
})

test('内置模块 skill-surface：只拦 skill-catalog，ponytail 与按需加载的 kind 必须留', () => {
  const sources = dropCatalog.sources
  assert.equal(sources.includes('skill-catalog'), false, '唯一要删的就是全量技能目录')
  for (const kind of [
    'skill-invocation', // skill_load 加载的真实技能正文——删了按需发现就白做
    'plugin:ponytail-subagent-readonly', // 三个 ponytail kind 只在子代理出现
    'plugin:ponytail-subagent-rules',
    'plugin:prompt-config-engine',
    'agent-instructions',
    'runtime-context',
  ]) {
    assert.ok(sources.includes(kind), `白名单漏掉 ${kind} 会静默删掉一段上下文`)
  }
  assert.equal(new Set(sources).size, sources.length, '白名单不得有重复项')
})
