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
  assert.match(form, /className=\{styles\.fieldSpan3\} label="configKind"/)
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
