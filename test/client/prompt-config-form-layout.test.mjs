import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
  assert.match(css, /@media \(max-width: 959px\)/)
  assert.doesNotMatch(css, /\.configGrid\s*\{[^}]*display:\s*flex/s)
})

test('placeholder 空结果文本只在 text 行为下显示', () => {
  const fields = read('src/client/features/prompts/PromptConfigFields.tsx')
  assert.match(fields, /emptyBehavior === 'text'\s*&&/)
})

test('模块参数使用简体中文标签与官方聚焦提示', () => {
  const form = read('src/client/features/prompts/PromptConfigForm.tsx')
  const fields = read('src/client/features/prompts/PromptConfigFields.tsx')
  const formField = read('src/client/ui/FormField.tsx')
  const css = read('src/client/features/prompts/prompts.module.css')

  for (const label of ['人设', '独占', '动态抑制']) assert.match(fields, new RegExp(`label="${label}"`))
  assert.match(form, />互斥</)
  assert.doesNotMatch(fields, /label="(?:人设段|complete（|suppressRuntimeContext（)/)
  assert.match(formField, /import \{ Tooltip \} from '@deepseek-ai\/dsh-client-ui-primitives'/)
  assert.match(formField, /hintMode === 'tooltip'/)
  assert.match(css, /--dsw-alias-tooltip-bg:/)
})
