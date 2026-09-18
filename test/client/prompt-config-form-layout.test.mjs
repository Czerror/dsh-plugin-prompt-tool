/**
 * 模块卡表单的分区、标签与说明浮窗契约。
 *
 * 2026-09-17 测试归一精简（U2）：本文件把**可渲染的那部分**静态源码断言升级为
 * SSR 真实渲染断言（`test/client/support/ssr-render.mjs`，内存转译 TSX + 映射 CSS
 * Modules，无需 Edge）。升级后这些断言在"组件不再渲染该分区/标签/details/跨度类"
 * 时会真正失败，而不再只是"源码里还写着 t('form.section.x')"。
 *
 * 仍然保留源码/CSS 契约的两类（SSR 无法覆盖）：
 * 1. **样式层断点**（容器查询、网格列、fallback 媒体查询、flex 禁令）—— SSR 不计算布局；
 * 2. **禁令类断言**（全目录 `title=` / `data-tip=` 扫描）与**实现契约**
 *    （FormField 是否经 HintTooltip 走 tooltip 模式）—— 前者是跨文件扫描，
 *    后者是组件接线事实，渲染结果里都看不到。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { getEngineMeta } from '../../engine/schema.mjs'
import { MATCH_LOGIC } from '../../engine/anchor-match.mjs'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'
import { MATCH_LOGIC_LABEL_KEYS, MATCH_LOGICS, MATCH_REGEX_MODE_LABEL_KEYS, MATCH_REGEX_MODES, normalizeMatch } from '../../src/client/features/prompts/prompt-config-policy.ts'
import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const t = makeTranslate()
// 注意：withSsr 内部的 import() 以 **harness 自身**（test/client/support/）为基准解析，
// 所以这里要写 `../../../src/...`（三层回到仓库根）；`read` 仍以本文件为基准。
const { PromptConfigForm, StrategyParamsFields, MatchFields, OptionField, TagInput } = await withSsr([
  '../../../src/client/features/prompts/PromptConfigForm.tsx',
  '../../../src/client/features/prompts/PromptConfigFields.tsx',
  '../../../src/client/ui/TagInput.tsx',
])

const meta = getEngineMeta()
/** 最小可渲染草稿：pre-step 层的字段策略打开 audience/modelScope/role 等分支。 */
const formProps = (config = {}, extra = {}) => ({
  t,
  meta,
  config: { id: 'layout-probe', layer: 'pre-step', strategy: 'static', text: '', configKind: 'ordered', ...config },
  onPatch() {},
  onPatchPolicy() {},
  ...extra,
})
/** 取函数组件返回的元素树（SSR 只读 props/回调，不声称验证 DOM 事件与重渲染）。 */
const treeOf = (component, props) => {
  let tree
  function Probe() { tree = component(props); return null }
  renderToStaticMarkup(createElement(Probe))
  return tree
}
const findElement = (node, predicate) => {
  if (Array.isArray(node)) return node.map((child) => findElement(child, predicate)).find(Boolean)
  if (!isValidElement(node)) return undefined
  return predicate(node) ? node : findElement(node.props.children, predicate)
}

const strategyProps = (props) => ({
  t,
  strategy: 'placeholder',
  layer: 'pre-step',
  params: {},
  onPatch() {},
  ...props,
})

test('模块卡参数按语义分区，并用容器网格限制短字段宽度', () => {
  const css = read('src/client/features/prompts/prompts.module.css')
  const html = renderElement(PromptConfigForm, formProps())

  // 分区标题与字段标签：从「源码里有这个 t(...) 调用」升级为「渲染结果里真的出现这段文案」。
  for (const section of ['basic', 'rules', 'scope', 'content', 'strategy']) {
    assert.ok(html.includes(t(`form.section.${section}`)), `渲染结果缺分区标题 form.section.${section}`)
  }
  assert.ok(html.includes(t('form.kind.label')), '渲染结果缺「配置类型」字段标签')
  assert.ok(html.includes(t('form.audience.label')), '渲染结果缺「消息受众」字段标签')

  // 高级元数据仍是原生 details + summary（原先只断言源码里有 `<details`）。
  assert.match(html, /<details[^>]*class="[^"]*configAdvanced/)
  assert.ok(html.includes(t('form.advanced.label')), 'details 的 summary 文案未渲染')

  // 策略区是一个 fieldset，并带容器网格三件套类名（原先断言源码里的 clsx(...) 字面量）。
  assert.match(html, /<fieldset[^>]*class="[^"]*configGrid[^"]*strategyGrid[^"]*configFieldset/)

  // 短字段跨度类真实落到渲染结果（原先只断言源码里的 className={styles.fieldSpan3/6}）。
  assert.ok(html.includes('fieldSpan3'), '渲染结果缺 fieldSpan3 跨度')
  assert.ok(html.includes('fieldSpan6'), '渲染结果缺 fieldSpan6 跨度')

  // CSS 契约（SSR 不计算真实布局，容器查询与网格列只能在样式层校验）。
  assert.match(css, /container-type:\s*inline-size/)
  assert.match(css, /grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(css, /@container prompt-form \(max-width: 720px\)/)
  assert.match(css, /@container prompt-form \(max-width: 620px\)/)
  assert.match(css, /@supports not \(container-type: inline-size\)[\s\S]*@media \(max-width: 720px\)/)
  assert.doesNotMatch(css, /\.configGrid\s*\{[^}]*display:\s*flex/s)
})

test('placeholder 空结果文本只在 text 行为下显示', () => {
  const asText = renderElement(StrategyParamsFields, strategyProps({ params: { emptyBehavior: 'text' } }))
  const asSkip = renderElement(StrategyParamsFields, strategyProps({ params: { emptyBehavior: 'skip' } }))
  const asDefault = renderElement(StrategyParamsFields, strategyProps({ params: {} }))

  assert.ok(asText.includes(t('strategyParam.emptyText')), 'emptyBehavior=text 时必须渲染空结果文本输入')
  assert.ok(!asSkip.includes(t('strategyParam.emptyText')), 'emptyBehavior=skip 时不得渲染空结果文本输入')
  assert.ok(!asDefault.includes(t('strategyParam.emptyText')), '缺省（视同 skip）时不得渲染空结果文本输入')
  // 反向保证：两次渲染确实渲染了同一张表单，差异只可能来自 emptyBehavior 分支。
  assert.ok(asText.includes(t('strategyParam.emptyBehavior.label')))
  assert.ok(asSkip.includes(t('strategyParam.emptyBehavior.label')))
})

test('模块参数使用简体中文标签与统一说明浮窗', () => {
  const formField = read('src/client/ui/FormField.tsx')
  const tooltipCss = read('src/client/ui/HintTooltip.module.css')

  // system-section 层的参数标签（原先断言源码里的 label={t(...)} 字面量）。
  const fields = renderElement(StrategyParamsFields, strategyProps({ layer: 'system-section', strategy: 'static' }))
  assert.ok(fields.includes(t('strategyParam.complete.label')), '缺「独占」参数标签')
  assert.ok(fields.includes(t('strategyParam.suppressRuntimeContext.label')), '缺「动态抑制」参数标签')
  assert.ok(!fields.includes('人设'), '渲染结果不得再出现「人设」标签（已迁到顶层 persona 段）')
  assert.ok(!/complete（|suppressRuntimeContext（/.test(fields), '不得回退到「英文键（说明）」式标签')

  // 表单顶层的「独占」开关标签同样以真实渲染为准。
  const form = renderElement(PromptConfigForm, formProps())
  assert.ok(form.includes(t('form.exclusive.label')), '渲染结果缺「独占」字段标签')

  // 实现契约（渲染结果里看不到接线方式，保留源码契约）：FormField 只在 tooltip 模式下
  // 走 HintTooltip，而不是原生 title；说明浮窗样式取自宿主 token。
  assert.match(formField, /import \{ HintTooltip \} from '\.\/HintTooltip\.tsx'/)
  assert.match(formField, /hintMode === 'tooltip'/)
  assert.match(tooltipCss, /var\(--dsw-alias-tooltip-bg\)/)
})

test('说明浮窗只复用宿主视觉，并自行跟随指针或聚焦控件', () => {
  const hintTooltip = read('src/client/ui/HintTooltip.tsx')
  const hintCss = read('src/client/ui/HintTooltip.module.css')
  const fields = read('src/client/features/prompts/PromptConfigFields.tsx')
  const promptCss = read('src/client/features/prompts/prompts.module.css')

  assert.doesNotMatch(hintTooltip, /@deepseek-ai\/dsh-client-ui-primitives/)
  assert.match(hintTooltip, /createPortal\(/)
  assert.match(hintTooltip, /event\.clientX/)
  assert.match(hintTooltip, /getBoundingClientRect\(\)/)
  // 鼠标点击按钮也会聚焦：只在键盘聚焦时锁定说明，失焦后回到悬停延迟。
  assert.match(hintTooltip, /focusTarget\.current = event\.target instanceof HTMLElement \? event\.target : null/)
  assert.match(hintTooltip, /shouldLockFocus\(\{ element: focusTarget\.current \?\? event\.currentTarget/)
  assert.match(hintTooltip, /HOVER_DELAY_MS/)
  assert.match(hintCss, /position:\s*fixed/)
  assert.match(hintCss, /var\(--dsw-alias-tooltip-bg\)/)
  assert.match(read('src/client/ui/FormField.tsx'), /configFieldControlAnchor/)
  assert.doesNotMatch(read('src/client/features/prompts/PromptConfigCard.tsx'), /<(?:button|label|span|div|code|input|textarea)\b[^>]*\btitle=/gs)
  assert.doesNotMatch(fields, /isPersonaSectionName/)
  const personaCard = read('src/client/features/persona/PresetPersonaCard.tsx')
  assert.match(personaCard, /aria-label=\{t\('persona\.prefix\.aria'\)\}/)
  assert.match(personaCard, /aria-label=\{t\('persona\.suffix\.aria'\)\}/)
  assert.match(personaCard, /bridgeCall\('persona'/)
  assert.match(promptCss, /\.configToggleField\s*\{[^}]*flex-direction:\s*column/s)
})

test('人设卡脱离公共配置分组，在模块列表下置顶显示', () => {
  // 保留源码契约：这条断言的对象是**页面组合顺序**（MainSessionPage 把 PresetPersonaCard
  // 放进 PromptConfigsEditor 的 beforeCards 插槽，且排在世界书诊断卡之前）。要改成渲染断言
  // 就得构造 MainSessionPage 的完整 store/fields/session props，成本远高于收益，而现有断言
  // 在顺序被调换时能真实失败 —— 故保留并在此说明理由。
  const editor = read('src/client/features/prompts/PromptConfigsEditor.tsx')
  const page = read('src/client/app/workspace/pages/MainSessionPage.tsx')
  assert.match(editor, /beforeCards\?: ReactNode/)
  assert.match(editor, /beforeCards=\{props\.beforeCards\}/)
  const beforeCards = page.slice(page.indexOf('beforeCards={'), page.indexOf('commonCards='))
  assert.ok(beforeCards.includes('<PresetPersonaCard'), '人设卡仍在卡片区最前')
  assert.ok(beforeCards.indexOf('<PresetPersonaCard') < beforeCards.indexOf('WorldBookDiagnosticsCard'),
    '世界书诊断卡排在人设卡之后')
})

test('原生元素不再使用浏览器 title 或 data-tip 说明', () => {
  // 禁令类断言：跨全目录扫描，不是"某个组件渲染成什么"，SSR 无法替代。
  const root = new URL('../../src/client/', import.meta.url)
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
    return entry.isDirectory() ? files(url) : entry.name.endsWith('.tsx') ? [url] : []
  })
  for (const file of files(root)) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /<(?:button|label|span|div|code|input|textarea|select)\b[^>]*\btitle=/gs, file.pathname)
    assert.doesNotMatch(source, /\bdata-tip=/, file.pathname)
  }
})

/** 条件层清单直接从引擎字段矩阵取：新层/新策略只要引擎放行，这里就跟着要求渲染。 */
const conditionalLayers = meta.layers.filter((layer) => meta.layerFieldPolicies[layer].subject || meta.layerFieldPolicies[layer].match)
const plainLayers = meta.layers.filter((layer) => !meta.layerFieldPolicies[layer].subject && !meta.layerFieldPolicies[layer].match)

test('新层与条件判定字段只在引擎放行的层渲染', () => {
  // 引擎契约兜底：只有这五个层允许 subject/match（其余层声明即挂载期报错）。
  // meta.layers 是引擎排序后的层名清单，这里按同一顺序比较集合。
  assert.deepEqual([...conditionalLayers].sort(), ['pre-step', 'subagent-end', 'subagent-start', 'tool-pipeline', 'turn-stop'])
  for (const layer of conditionalLayers) {
    const html = renderElement(PromptConfigForm, formProps({ layer }))
    assert.ok(html.includes(t('form.subject.label')), `${layer} 应渲染「匹配对象」下拉`)
    assert.ok(html.includes(t('form.match.keys.label')), `${layer} 应渲染「主键」编辑器`)
    assert.ok(html.includes(t('form.match.logic.label')), `${layer} 应渲染组合逻辑下拉`)
  }
  for (const layer of plainLayers) {
    const html = renderElement(PromptConfigForm, formProps({ layer }))
    assert.ok(!html.includes(t('form.subject.label')), `${layer} 不支持 subject，字段必须隐藏`)
    assert.ok(!html.includes(t('form.match.keys.label')), `${layer} 不支持 match，字段必须隐藏`)
  }
  // 三个新层用中文标签渲染，而不是回退成裸层名。
  assert.ok(renderElement(PromptConfigForm, formProps({ layer: 'turn-stop' })).includes(t('layer.turn-stop')))
  assert.ok(renderElement(PromptConfigForm, formProps({ layer: 'subagent-start' })).includes(t('layer.subagent-start')))
  assert.ok(renderElement(PromptConfigForm, formProps({ layer: 'subagent-end' })).includes(t('layer.subagent-end')))
  // 缺省匹配对象按层给出可读说明（层缺省 = 不写 subject 字段）。
  assert.ok(renderElement(PromptConfigForm, formProps({ layer: 'tool-pipeline' })).includes(t('form.subject.defaultHint', { value: t('subject.toolArgs') })))
  assert.ok(renderElement(PromptConfigForm, formProps({ layer: 'subagent-end' })).includes(t('form.subject.defaultHint', { value: t('subject.subagentInfo') })))
  // 指令文件卡：绑定与策略都不承载 subject/match，即使本层放行也不得渲染假入口。
  const fileCard = renderElement(PromptConfigForm, formProps({ layer: 'pre-step', contentStatus: 'ready' }))
  assert.ok(!fileCard.includes(t('form.subject.label')), '指令文件卡不得渲染 subject')
  assert.ok(!fileCard.includes(t('form.match.keys.label')), '指令文件卡不得渲染 match')
  // 只读预设：三个匹配开关与键输入随表单一起禁用，不留「能点但保存不了」的控件。
  // （MatchFields 是嵌套组件，元素树里不展开其返回值，故直接渲染它取 props。）
  const readonlyTree = treeOf(MatchFields, { t, value: { keys: ['报错'] }, disabled: true, onChange: () => {} })
  for (const flag of ['caseSensitive', 'wholeWords', 'useRegex']) {
    assert.equal(findElement(readonlyTree, (node) => node.props?.label === t(`form.match.${flag}.label`))?.props.disabled, true, `${flag} 开关在只读预设下必须禁用`)
  }
  assert.equal(findElement(readonlyTree, (node) => node.type === TagInput && node.props.label === t('form.match.keys.label'))?.props.disabled, true)
})

test('切换注入层清空该层不支持的 subject/match', () => {
  const patches = []
  const tree = treeOf(PromptConfigForm, formProps(
    { layer: 'pre-step', subject: 'toolArgs', match: { keys: ['报错'], logic: 'all' } },
    { onPatch: (patch) => patches.push(patch) },
  ))
  const layerField = findElement(tree, (node) => node.type === OptionField && node.props.label === t('form.layer.label'))
  assert.ok(layerField, '表单必须有注入层下拉')
  // 切到不支持条件判定的层：两项一并清空（旧值留下会让引擎挂载期直接报错）。
  layerField.props.onChange('system-section')
  assert.deepEqual(patches.at(-1), { layer: 'system-section', subject: undefined, match: undefined })
  // 切到支持条件判定的层：原值保留，不误清。
  layerField.props.onChange('turn-stop')
  assert.deepEqual(patches.at(-1), { layer: 'turn-stop' })
})

test('match 草稿：UI 编辑按引擎契约归一，可 JSON 往返', () => {
  const patches = []
  const matchTree = (value) => treeOf(MatchFields, { t, value, onChange: (next) => patches.push(next) })
  // 主键输入：TagInput 以逗号分隔字符串承载，空白键被丢弃。
  findElement(matchTree({ keys: ['报错'], logic: 'all' }), (node) => node.type === TagInput && node.props.label === t('form.match.keys.label'))
    .props.onChange('报错, 超时 ,')
  assert.deepEqual(patches.at(-1), { keys: ['报错', '超时'], logic: 'all' })
  // 开关：只写显式开启的值，缺省不落盘。
  findElement(matchTree({ keys: ['报错'] }), (node) => node.props?.label === t('form.match.caseSensitive.label'))
    .props.onChange(true)
  assert.deepEqual(patches.at(-1), { keys: ['报错'], caseSensitive: true })
  // 清空全部键：整段 match 撤下（引擎要求至少一个非空键）。
  findElement(matchTree({ keys: ['报错'], caseSensitive: true }), (node) => node.type === TagInput && node.props.label === t('form.match.keys.label'))
    .props.onChange('')
  assert.equal(patches.at(-1), undefined)

  const draft = normalizeMatch({ keys: [' 报错 '], secondaryKeys: ['toolResult'], logic: 'notAny', caseSensitive: true, wholeWords: false, useRegex: true })
  assert.deepEqual(draft, { keys: ['报错'], secondaryKeys: ['toolResult'], logic: 'notAny', caseSensitive: true, useRegex: true })
  // 往返序列化：草稿经桥载荷（JSON）往返后逐字段一致，且不再出现缺省项。
  assert.deepEqual(JSON.parse(JSON.stringify(draft)), draft)
  assert.deepEqual(normalizeMatch(JSON.parse(JSON.stringify(draft))), draft)
  // 半成品与非法值都不会写进配置。
  assert.equal(normalizeMatch({ keys: [], logic: 'all', caseSensitive: true }), undefined)
  assert.deepEqual(normalizeMatch({ keys: ['a'], logic: 'bogus' }), { keys: ['a'] })
  assert.deepEqual(normalizeMatch({ keys: ['a'], logic: 'any', useRegex: false }), { keys: ['a'], useRegex: false })
  // useRegex 是三态：false（强制字面）必须原样保留，否则编辑一次就静默变成自动识别。
  assert.deepEqual(normalizeMatch({ keys: ['a'], useRegex: true }), { keys: ['a'], useRegex: true })
  assert.deepEqual(normalizeMatch({ keys: ['a'] }), { keys: ['a'] })
  assert.deepEqual(normalizeMatch({ keys: [], secondaryKeys: ['b'] }), { keys: [], secondaryKeys: ['b'] })
})

test('组合逻辑下拉只提供引擎的四个取值', () => {
  assert.deepEqual([...MATCH_LOGICS], ['any', 'all', 'not', 'notAny'])
  assert.deepEqual([...MATCH_LOGICS].sort(), Object.values(MATCH_LOGIC).sort(), '表单取值必须与引擎 MATCH_LOGIC 同源')
  assert.deepEqual(Object.keys(MATCH_LOGIC_LABEL_KEYS).sort(), [...MATCH_LOGICS].sort(), '每个取值都要有显示键')
  for (const logic of MATCH_LOGICS) {
    assert.ok(PROMPT_TOOL_DICTS.zh[`match.${logic}`], `zh 缺 match.${logic}`)
    assert.ok(PROMPT_TOOL_DICTS.en[`match.${logic}`], `en 缺 match.${logic}`)
  }
  // 逻辑下拉的真实取值来自表单，而不是另抄一份字面量。
  const patches = []
  const tree = treeOf(MatchFields, { t, value: { keys: ['报错'] }, onChange: (next) => patches.push(next) })
  const logicField = findElement(tree, (node) => node.type === OptionField && node.props.label === t('form.match.logic.label'))
  assert.deepEqual(logicField.props.options, MATCH_LOGICS)
  logicField.props.onChange('notAny')
  assert.deepEqual(patches.at(-1), { keys: ['报错'], logic: 'notAny' })
})

test('键匹配方式是三态下拉，强制字面不会被静默改回自动', () => {
  assert.deepEqual([...MATCH_REGEX_MODES], ['auto', 'force', 'literal'])
  assert.deepEqual(Object.keys(MATCH_REGEX_MODE_LABEL_KEYS).sort(), [...MATCH_REGEX_MODES].sort(), '每种模式都要有显示键')
  for (const mode of MATCH_REGEX_MODES) {
    assert.ok(PROMPT_TOOL_DICTS.zh[`form.match.useRegex.${mode}`], `zh 缺 form.match.useRegex.${mode}`)
    assert.ok(PROMPT_TOOL_DICTS.en[`form.match.useRegex.${mode}`], `en 缺 form.match.useRegex.${mode}`)
  }
  const patches = []
  const tree = treeOf(MatchFields, { t, value: { keys: ['报错'], useRegex: false }, onChange: (next) => patches.push(next) })
  const field = findElement(tree, (node) => node.type === OptionField && node.props.label === t('form.match.useRegex.label'))
  assert.deepEqual(field.props.options, MATCH_REGEX_MODES)
  assert.equal(field.props.value, 'literal', '手写的 useRegex:false 必须回显为强制字面')

  field.props.onChange('force')
  assert.deepEqual(patches.at(-1), { keys: ['报错'], useRegex: true })
  field.props.onChange('auto')
  assert.deepEqual(patches.at(-1), { keys: ['报错'] })
  field.props.onChange('literal')
  assert.deepEqual(patches.at(-1), { keys: ['报错'], useRegex: false })
})
