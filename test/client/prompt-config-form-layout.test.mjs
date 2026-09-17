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
import { getEngineMeta } from '../../engine/schema.mjs'
import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const t = makeTranslate()
// 注意：withSsr 内部的 import() 以 **harness 自身**（test/client/support/）为基准解析，
// 所以这里要写 `../../../src/...`（三层回到仓库根）；`read` 仍以本文件为基准。
const { PromptConfigForm, StrategyParamsFields } = await withSsr([
  '../../../src/client/features/prompts/PromptConfigForm.tsx',
  '../../../src/client/features/prompts/PromptConfigFields.tsx',
])

const meta = getEngineMeta()
/** 最小可渲染草稿：pre-step 层的字段策略打开 audience/modelScope/role 等分支。 */
const formProps = (config = {}) => ({
  t,
  meta,
  config: { id: 'layout-probe', layer: 'pre-step', strategy: 'static', text: '', configKind: 'ordered', ...config },
  onPatch() {},
  onPatchPolicy() {},
})
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
