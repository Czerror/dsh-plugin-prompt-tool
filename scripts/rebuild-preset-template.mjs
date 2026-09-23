#!/usr/bin/env node
/** 从共享参数目录、九层契约和真实模板重建根 preset.yml；YAML 统一使用 Document API。 */
import { readFileSync, readdirSync, writeFileSync, renameSync, rmSync, openSync, closeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Document, parseDocument } from 'yaml'
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS } from '../src/shared/engine-params.ts'
import { ENGINE_PARAM_LAYERS } from '../src/host/preset-layer-settings.ts'
import { PARAMS_ZH } from '../src/client/locales-params.ts'
import { LAYER_CONTRACTS, LAYER_FIELD_POLICIES, LAYER_LABELS, LAYER_ORDER, createPromptConfigs } from '../engine/schema.mjs'

const root = new URL('../', import.meta.url)
const output = new URL('preset.yml', root)
const doc = new Document({
  id: 'my-preset', name: '我的预设', description: '九层配置与全部共享参数参考；所有示例规则默认关闭。',
  version: '1.0.0', engineCompat: '>=0.7.2', modules: ['prompt-config-engine'], layerSettings: {},
  variables: {}, customTools: [], promptConfigs: [],
})
doc.commentBefore = ` dsh-plugin-prompt-tool — 全参数 preset.yml 模板（自动生成）
 生成来源：scripts/rebuild-preset-template.mjs + ENGINE_PARAM_DEFINITIONS + engine/schema.mjs + templates/
 重建：pnpm rebuild:preset-template；检查：pnpm rebuild:preset-template -- --check
 复制到 DSH_HOME/.agent-presets/<id>/preset.yml，id 与目录名保持一致。
 真实提示词规则与共享参数分属两个所有者：promptConfigs[].params / layerSettings.<层名>.<键>。
 共享设置只内嵌真实配置卡；空层不自动创建 UI 卡或提示词规则。
 九层是独立官方扩展点，没有插件定义的跨层执行顺序。详见 docs/injection-point-contracts.md。
 默认不启用锚定或模型增强；下方参考参数全部为注释，按需启用。
 指令文件正文和指令策略不放在本文件；不得将用户 AGENTS.md/CLAUDE.md 正文复制进来。`
doc.get('modules', true).commentBefore = ` 仅启用提示词引擎。其他能力保持 opt-in；写入其已登记参数后会自动补齐装配。
 官方与本地可用模块：${['engine/compositions/library/', 'engine/compositions/source/local/'].flatMap(dir => readdirSync(new URL(dir, root)).filter(name => name.endsWith('.yml')).map(name => name.slice(0, -4))).join(', ')}
 人设使用顶层 persona；不存在 persona、code-presentation、cot-drip 等已撤销模块别名。`
doc.get('layerSettings', true).commentBefore = ' 唯一共享参数磁盘位置。按下方参考取消所需注释，不要复制旧 params/model/subagentModel 段。'
doc.get('variables', true).commentBefore = ' 预设内容变量；与共享参数、每条规则的 variables 都是独立命名空间。空字符串是合法占位值。'
doc.get('customTools', true).commentBefore = ' 自定义模型工具列表；结构示例见 templates/tools。工具权限和执行器通过既有专用编辑器配置。'
const specs = readdirSync(new URL('templates/', root)).filter(name => name.endsWith('.yml')).sort().map(file => {
  const template = parseDocument(readFileSync(new URL(`templates/${file}`, root), 'utf8'))
  if (template.errors.length) throw template.errors[0]
  const spec = template.toJS()
  spec.enabled = false
  const contract = LAYER_CONTRACTS[spec.layer]
  spec.params ??= {}
  for (const [key, rule] of Object.entries(contract.params)) {
    if (spec.params[key] !== undefined) continue
    spec.params[key] = rule.type === 'boolean' ? false : rule.type === 'object' ? {} : rule.values?.[0] ?? ''
  }
  if (spec.layer === 'agent-request') spec.params.patch = { provider: 'provider-id', model: 'model-id', reasoningEffort: 'high', temperature: 0.3, maxTokens: 4096, stop: ['END'] }
  if (spec.layer === 'subagent-end') spec.text = '子代理已结束。请检查其结果，验证后再回复用户。'
  const node = doc.createNode(spec)
  const fields = Object.entries(LAYER_FIELD_POLICIES[spec.layer]).filter(([key, enabled]) => enabled && key !== 'placeholder').map(([key]) => key === 'merge' ? 'mergeMode' : key)
  node.commentBefore = ` ${file} — ${LAYER_LABELS[spec.layer].detail}
 本层通用字段：${fields.join(', ')}；未列字段不可从其他层直接照搬。
 本层支持策略：${contract.strategies.join(', ')}；匹配对象：${contract.subjects.join(', ') || '不支持'}。
 ${Object.entries(contract.params).map(([key, rule]) => `params.${key}: ${rule.values?.join(' | ') ?? rule.type}`).join('；') || '无额外层专属 params；策略字段仍按所选策略解释。'}`
  return node
})
specs.push(doc.createNode({ id: 'example-world-book', name: '世界书条件条目', enabled: false, layer: 'pre-step', strategy: 'world-book',
  text: '这里是触发后注入的背景知识。', params: { constant: false, keys: ['项目'], secondaryKeys: ['规范'], selectiveLogic: 0, caseSensitive: false, wholeWords: false, useRegex: false } }))
doc.set('promptConfigs', doc.createNode(specs))
doc.get('promptConfigs', true).commentBefore = ` 每条都是真实规则示例，默认 enabled:false。启用前填写正文/行为；未填写内容的文本层不注入。
 id 必填且唯一；name 可选；configKind: ordered | anchor；order 只在同一入口比较。
 group + exclusive 控制互斥；text 与 texts 为正文来源；策略专属 params 只属于本条。
 pre-step 可声明 position/dedupe/promotion/audience/modelScope/mergeMode/role(user)/sourceKind/form/summary/identity。
 identity 只允许 {field: plugin, value: 唯一值}；templateFile 可选，须在预设目录内，内嵌正文优先。
 match: {keys:[关键字], secondaryKeys:[], logic:any|all|not|notAny, caseSensitive:false, wholeWords:false, useRegex:false}。
 useRegex 缺省自动识别 /pattern/flags，true 强制正则，false 强制字面；subject 必须是本层支持的对象。
 工具参数不可改写；toolResult 条件只作用于后置阶段。结束层 inject-main 不改写子代理结果、不唤醒空闲主会话。`

const reference = new Document({ layerSettings: Object.fromEntries(LAYER_ORDER.map(layer => [layer, {}])) })
const notes = {
  guideEnabled: '仅 true 启用；缺省关闭，与 firstTurnAnchor 独立',
  maxDepth: '0 禁止委派；provider-managed 交给 provider；正整数限制深度；空继承',
  modelTemperature: '有限数；空继承宿主，不写入请求 patch',
  modelMaxTokens: '正整数；空继承宿主',
  subagentTemperature: '子代理采样最终通过 agent-request 生效',
  subagentMaxTokens: '正整数；空继承宿主',
}
for (const layer of LAYER_ORDER) reference.getIn(['layerSettings', layer], true).commentBefore = ` ${LAYER_LABELS[layer].title}：共享参数，不属于该层某一条提示词规则。`
for (const key of ENGINE_PARAM_KEYS) {
  const rule = ENGINE_PARAM_DEFINITIONS[key]
  const path = ['layerSettings', ENGINE_PARAM_LAYERS[key], key]
  reference.setIn(path, reference.createNode(rule.defaultValue ?? false))
  reference.getIn(path, true).comment = ` ${PARAMS_ZH[`param.${key}`]}；${rule.kind}${rule.options ? `；${rule.options.join(' | ')}` : ''}${notes[key] ? `；${notes[key]}` : ''}`
}
const assets = new Document({
  persona: { prefix: 'You are a helpful assistant.', suffix: 'Working directory: {{cwd}}.', complete: false, includeRuntimeContext: true },
  content: { presetText: '填写预设内容资产；由显式启用的规则消费。' },
  moduleConfigs: { 'tool-web': { fetch: true } },
  subagentToolPolicy: { defaultProfile: 'default', ceiling: { allow: ['read'], deny: [] }, profiles: [{ id: 'default', name: '只读', allow: ['read'], deny: [], modelSelectable: true }], modelExpansion: { enabled: false, allow: [], maxAdditionalTools: 0, requireApproval: true } },
})
const commented = value => value.toString().trimEnd().split('\n').map(line => `# ${line}`).join('\n')
const text = doc.toString() + `\n# BEGIN SHARED PARAMETER REFERENCE\n# 以下穷举全部登记键；值是编辑器示例，不承诺等于模块运行时默认值。\n# '' / [] 保存时删键；false / 0 保留。按需合并到上方 layerSettings，勿保留重复顶层键。\n${commented(reference)}\n# END SHARED PARAMETER REFERENCE\n\n# 其他领域资产参考（按需合并；moduleConfigs 低于已声明共享参数，不能绕过权限）\n${commented(assets)}\n`
createPromptConfigs(parseDocument(text).toJS().promptConfigs)
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== text) throw new Error('根 preset.yml 已偏离参数契约，请运行 pnpm rebuild:preset-template')
} else {
  const temporary = fileURLToPath(output) + '.tmp'
  const fd = openSync(temporary, 'wx')
  try {
    try { writeFileSync(fd, text, 'utf8') } finally { closeSync(fd) }
    renameSync(temporary, output)
  }
  finally { rmSync(temporary, { force: true }) }
}
console.log(`preset.yml: ${ENGINE_PARAM_KEYS.length} 个共享参数，${LAYER_ORDER.length} 层，${specs.length} 条默认关闭的规则示例`)
