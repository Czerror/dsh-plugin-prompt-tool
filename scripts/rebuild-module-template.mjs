#!/usr/bin/env node
/** 从共享参数目录、九层契约和真实模板重建根 module.yml；YAML 统一使用 Document API。 */
import { readFileSync, readdirSync, writeFileSync, renameSync, rmSync, openSync, closeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Document, parseDocument } from 'yaml'
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS } from '../src/shared/engine-params.ts'
import { ENGINE_PARAM_LAYERS } from '../src/host/module-layer-settings.ts'
import { PARAMS_ZH } from '../src/client/locales-params.ts'
import { LAYER_CONTRACTS, LAYER_LABELS, LAYER_ORDER } from '../engine/schema.mjs'
import { compileRules } from '../engine/rule-spec.mjs'

const root = new URL('../', import.meta.url)
const output = new URL('module.yml', root)
/** 退役入口不进入参考清单；旧声明需显式转换，运行时不兼容双读。 */
const RETIRED_MODULE_NAMES = new Set(['prompt-config-engine', 'declared-triggers'])
/** 只有本地源目录：官方切块已随「与预设彻底解耦」清理，`library/` 不再存在。 */
const moduleNames = readdirSync(new URL('engine/compositions/source/local/', root))
  .filter(name => name.endsWith('.yml'))
  .map(name => name.slice(0, -4))
  .filter(name => !RETIRED_MODULE_NAMES.has(name))
const doc = new Document({
  id: 'my-module', name: '我的模块', description: '九层配置与全部共享参数参考；所有示例规则默认关闭。',
  version: '1.0.0', engineCompat: '>=0.7.2', modules: ['rule-engine'], layerSettings: {},
  variables: {}, customTools: [], rules: [],
})
doc.commentBefore = ` dsh-plugin-prompt-tool — 全参数 module.yml 模板（自动生成）
 生成来源：scripts/rebuild-module-template.mjs + ENGINE_PARAM_DEFINITIONS + engine/schema.mjs + templates/
 重建：pnpm --dir $Repo rebuild:module-template；检查：pnpm --dir $Repo rebuild:module-template -- --check
 复制到 DSH_HOME/.prompt-tool/modules/<id>/module.yml，id 与目录名保持一致。
 rules 是唯一行为定义：if 判断树 → then 动作数组（另有 else）；提示词正文属于 inject-text 动作。
 共享设置只内嵌真实配置卡；空层不自动创建 UI 卡或提示词规则。
 九层是独立官方扩展点，没有插件定义的跨层执行顺序。详见 docs/injection-point-contracts.md。
 默认不启用锚定或模型增强；下方参考参数全部为注释，按需启用。
 指令文件正文和指令策略不放在本文件；不得将用户 AGENTS.md/CLAUDE.md 正文复制进来。`
doc.get('modules', true).commentBefore = ` 仅启用规则引擎。其他能力保持 opt-in；写入其已登记参数后会自动补齐装配。
 可用模块（engine/compositions 下的文件名）：${moduleNames.join(', ')}
 已退役的引擎名：${[...RETIRED_MODULE_NAMES].join(', ')}；旧定义需显式转换。
 人设使用 persona.main / persona.subagent；未声明字段继承官方值。`
doc.get('layerSettings', true).commentBefore = ' 唯一共享参数磁盘位置。按下方参考取消所需注释，不要复制旧 params/model/subagentModel 段。'
doc.get('variables', true).commentBefore = ` 当前模块的持久变量；同名模块值覆盖全局，空字符串保留，删除才回落全局。
 全局变量位于 DSH_HOME/.prompt-tool/variables.yml，不随模块导出。
 普通规则只引用已有变量；WHO / stateKeys 等需在工作台变量卡手动建立。
 ST 导入会自动登记缺失的裸变量为空占位；动作 config.variables 已退役。`
doc.get('customTools', true).commentBefore = ' 自定义模型工具列表；结构示例见 templates/tools。工具权限和执行器通过既有专用编辑器配置。'
const specs = readdirSync(new URL('templates/', root)).filter(name => name.endsWith('.yml')).sort().map(file => {
  const template = parseDocument(readFileSync(new URL(`templates/${file}`, root), 'utf8'))
  if (template.errors.length) throw template.errors[0]
  const spec = template.toJS()
  spec.enabled = false
  // 顶层 layer 提供注入缺省层与展示归属；取不到时使用动作自己的层。
  const layer = spec.layer ?? spec.then.find(action => action.kind === 'inject-text')?.config?.layer
  const contract = LAYER_CONTRACTS[layer]
  for (const action of spec.then) {
    if (action.kind === 'inject-text') {
      action.config.params ??= {}
      for (const [key, rule] of Object.entries(contract.params)) {
        if (action.config.params[key] !== undefined) continue
        action.config.params[key] = rule.type === 'boolean' ? false : rule.type === 'object' ? {} : rule.values?.[0] ?? ''
      }
    }
    if (action.kind === 'request-params') action.patch = { provider: 'provider-id', model: 'model-id', reasoningEffort: 'high', temperature: 0.3, maxTokens: 4096, stop: ['END'] }
  }
  const node = doc.createNode(spec)
  node.commentBefore = ` ${file} — ${LAYER_LABELS[layer]?.detail ?? '动作自带执行点，顶层 layer 只是展示归属'}
 规则条件放 if，动作放 then；动作执行点由引擎目录验证，不建立跨层全局顺序。
 注入动作内容策略：${contract?.strategies.join(', ') ?? '按动作自身能力'}。`
  return node
})
specs.push(doc.createNode({ id: 'example-context-activation', name: '上下文激活条目', enabled: false, layer: 'pre-step',
  then: [{ id: 'inject', kind: 'inject-text', config: { layer: 'pre-step', strategy: 'context-activation', text: '这里是触发后注入的背景知识。',
    params: { constant: false, keys: ['项目'], secondaryKeys: ['规范'], selectiveLogic: 'AND_ANY', caseSensitive: false, wholeWords: false, useRegex: false, wordBoundary: 'unicode',
      activation: { scan: 'batch', selective: true } } } }] }))
doc.set('rules', doc.createNode(specs))
doc.get('rules', true).commentBefore = ` 每条规则默认 enabled:false；规则与动作的 id 必填、各自唯一。
 if 可组合 all/any/not/notAny；then 中动作在同一执行点按数组相对顺序执行，条件只求值一次。
 动作级分支写成 { if, then, else } 节点嵌在 then / else 里，可继续嵌套；缺必要事实时两支都不执行。
 同模块非空 group 中存在 exclusive:true 时，整组最多一条启用；多启用是编译期拒绝，不按排序选赢家。
 注入正文、内容策略、合并和去重属于 inject-text.config；变量由模块或全局持久表拥有。
 需要原生赋值时显式设置 params.templateEvaluation:true，使用 module.set/get/add/inc/dec 或 global 对应操作。
 config.identity 只允许 {field: plugin, value: 唯一值}；templateFile 相对模块 module.yml 且须在模块目录内。
 guard、complete、suppressRuntimeContext 是固定注册效果：不接受规则级 if，编译器明确拒绝非法组合。`

const reference = new Document({ layerSettings: Object.fromEntries(LAYER_ORDER.map(layer => [layer, {}])) })
const notes = {
  maxDepth: '0 禁止委派；provider-managed 交给 provider；正整数限制深度；空继承',
  modelTemperature: '有限数；空继承宿主，不写入请求 patch',
  modelMaxTokens: '正整数；空继承宿主',
  subagentTemperature: '子代理采样最终通过 agent-request 生效',
  subagentMaxTokens: '正整数；空继承宿主',
}
for (const layer of LAYER_ORDER) reference.getIn(['layerSettings', layer], true).commentBefore = ` ${LAYER_LABELS[layer].title}：共享参数，不属于该层某一条提示词规则。`
const sharedParamKeys = ENGINE_PARAM_KEYS
for (const key of sharedParamKeys) {
  const rule = ENGINE_PARAM_DEFINITIONS[key]
  const path = ['layerSettings', ENGINE_PARAM_LAYERS[key], key]
  reference.setIn(path, reference.createNode(rule.defaultValue ?? false))
  reference.getIn(path, true).comment = ` ${PARAMS_ZH[`param.${key}`]}；${rule.kind}${rule.options ? `；${rule.options.join(' | ')}` : ''}${notes[key] ? `；${notes[key]}` : ''}`
}
const assets = new Document({
  persona: { main: { prefix: 'You are a helpful assistant.', suffix: 'Working directory: {{CWD}}.', complete: false }, subagent: { suffix: '返回可核验的执行结果。' } },
  variablesEnabled: true,
  contextActivationRecursive: false,
  moduleConfigs: { 'instruction-hint': { messageTemplate: 'Instructions from: {{FILES}}' } },
  subagentToolPolicy: { defaultProfile: 'default', ceiling: { allow: ['read'], deny: [] }, profiles: [{ id: 'default', name: '只读', allow: ['read'], deny: [], modelSelectable: true }], modelExpansion: { enabled: false, allow: [], maxAdditionalTools: 0, requireApproval: true } },
})
const commented = value => value.toString().trimEnd().split('\n').map(line => `# ${line}`).join('\n')
const text = doc.toString() + `\n# BEGIN SHARED PARAMETER REFERENCE\n# 以下穷举全部登记键；值是编辑器示例，不承诺等于模块运行时默认值。\n# '' / [] 保存时删键；false / 0 保留。按需合并到上方 layerSettings，勿保留重复顶层键。\n${commented(reference)}\n# END SHARED PARAMETER REFERENCE\n\n# 其他领域资产参考（按需合并；moduleConfigs 低于已声明共享参数，不能绕过权限）\n# persona 的省略字段继承官方；空文本清空，complete:false 解除人设独占。\n# 多模块重复定义同一受众的同一字段会拒绝，不按顺序挑选赢家。\n${commented(assets)}\n`
compileRules(parseDocument(text).toJS().rules)
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== text) throw new Error('根 module.yml 已偏离参数契约，请运行 pnpm rebuild:module-template')
} else {
  const temporary = fileURLToPath(output) + '.tmp'
  const fd = openSync(temporary, 'wx')
  try {
    try { writeFileSync(fd, text, 'utf8') } finally { closeSync(fd) }
    renameSync(temporary, output)
  }
  finally { rmSync(temporary, { force: true }) }
}
console.log(`module.yml: ${sharedParamKeys.length} 个共享参数，${LAYER_ORDER.length} 层，${specs.length} 条默认关闭的规则示例`)
