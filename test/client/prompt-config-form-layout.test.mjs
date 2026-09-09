import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('模块卡参数按语义分区，并用容器网格限制短字段宽度', () => {
  const form = read('src/client/features/prompts/PromptConfigForm.tsx')
  const css = read('src/client/features/prompts/prompts.module.css')

  for (const title of ['基础信息', '注入规则', '作用范围', '内容', '策略参数', '高级元数据']) {
    assert.match(form, new RegExp(title))
  }
  assert.match(form, /className=\{clsx\(styles\.configGrid, styles\.strategyGrid\)\}/)
  assert.match(form, /className=\{styles\.fieldSpan3\} label="配置类型"/)
  assert.match(form, /className=\{styles\.fieldSpan6\} label="消息受众"/)
  assert.match(form, /<details/)
  assert.match(css, /container-type:\s*inline-size/)
  assert.match(css, /grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(css, /@media \(max-width: 720px\)/)
  assert.doesNotMatch(css, /\.configGrid\s*\{[^}]*display:\s*flex/s)
})

test('placeholder 空结果文本只在 text 行为下显示', () => {
  const fields = read('src/client/features/prompts/PromptConfigFields.tsx')
  assert.match(fields, /emptyBehavior === 'text'\s*&&/)
})

test('模块参数使用简体中文标签与统一说明浮窗', () => {
  const form = read('src/client/features/prompts/PromptConfigForm.tsx')
  const fields = read('src/client/features/prompts/PromptConfigFields.tsx')
  const formField = read('src/client/ui/FormField.tsx')
  const tooltipCss = read('src/client/ui/HintTooltip.module.css')

  // 人设已迁到 preset.yml 顶层 persona 段（PresetPersonaCard），本层只剩普通段名、「独占」与「动态抑制」。
  assert.match(fields, /label="独占"/)
  assert.match(fields, /label="动态抑制"/)
  assert.doesNotMatch(fields, /label="人设"/)
  assert.match(form, />互斥</)
  assert.doesNotMatch(fields, /label="(?:人设段|complete（|suppressRuntimeContext（)/)
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
  assert.match(hintTooltip, /shouldLockFocus\(\{ element: event\.currentTarget/)
  assert.match(hintTooltip, /HOVER_DELAY_MS/)
  assert.match(hintCss, /position:\s*fixed/)
  assert.match(hintCss, /var\(--dsw-alias-tooltip-bg\)/)
  assert.match(read('src/client/ui/FormField.tsx'), /configFieldControlAnchor/)
  assert.doesNotMatch(read('src/client/features/prompts/PromptConfigCard.tsx'), /title=/)
  assert.doesNotMatch(fields, /isPersonaSectionName/)
  const personaCard = read('src/client/features/persona/PresetPersonaCard.tsx')
  assert.match(personaCard, /label="人设前缀"/)
  assert.match(personaCard, /label="人设后缀"/)
  assert.match(personaCard, /bridgeCall\('persona'/)
  assert.match(promptCss, /\.configToggleField\s*\{[^}]*flex-direction:\s*column/s)
})

test('人设卡脱离公共配置分组，在模块列表下置顶显示', () => {
  const editor = read('src/client/features/prompts/PromptConfigsEditor.tsx')
  const page = read('src/client/app/workspace/pages/MainSessionPage.tsx')
  assert.match(editor, /beforeCards\?: ReactNode/)
  assert.match(editor, /beforeCards=\{props\.beforeCards\}/)
  assert.match(page, /beforeCards=\{\s*<PresetPersonaCard/)
})

test('原生元素不再使用浏览器 title 或 data-tip 说明', () => {
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
