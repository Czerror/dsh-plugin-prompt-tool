import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { PROMPT_TOOL_DICTS, PROMPT_TOOL_NS, registerPromptToolLocale } from '../../src/client/locales.ts'
import { ENGINE_PARAM_KEYS } from '../../src/shared/engine-params.ts'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

/**
 * R1 迁移范围：这些文件的用户可见文案必须归入 prompt-tool 字典。
 * 未列入的文件仍持有硬编码文案：ui 控件的回退文案（MenuSelect/TagInput/DialogSurface/EngineModuleCard），
 * 以及 features/models、data 的状态提示（属模型路由任务的文件边界）；
 * character-card.ts 的 PNG 解析错误不直接面向用户（导入走 host 上传），不在迁移范围。
 */
const MIGRATED_UI_FILES = [
  'src/client/app/workbench/register-workbench.tsx',
  'src/client/app/workbench/SettingsTab.tsx',
  'src/client/app/workbench/WorkbenchOverlay.tsx',
  'src/client/app/workbench/FloatingTrigger.tsx',
  'src/client/app/workspace/WorkspaceFrame.tsx',
  'src/client/app/workspace/WorkspaceNavigation.tsx',
  'src/client/app/workspace/PromptWorkspace.tsx',
  'src/client/app/workspace/workspace-pages.ts',
  'src/client/app/workspace/pages/MainSessionPage.tsx',
  'src/client/app/workspace/pages/SubagentPage.tsx',
  'src/client/app/workspace/pages/ConfigListWithTemplates.tsx',
  'src/client/features/skills/SkillsPage.tsx',
  'src/client/features/skills/SkillRow.tsx',
  'src/client/features/skills/skill-status.ts',
  'src/client/features/presets/PresetsPage.tsx',
  'src/client/features/presets/PresetSwitcher.tsx',
  'src/client/features/characters/CharactersPage.tsx',
  'src/client/features/tools/ToolsPreviewPage.tsx',
  'src/client/features/tools/ToolSurfaceView.tsx',
  'src/client/features/tools/CustomToolsCard.tsx',
  'src/client/features/tools/CustomToolEditor.tsx',
  // cards 分区（子代理工具策略与工具与深度模块卡）。
  'src/client/features/subagents/DelegationToolsCard.tsx',
  'src/client/features/subagents/SubagentToolPolicyCard.tsx',
  // prompts 分区（提示词配置、模板浮层与人设卡）。
  'src/client/features/prompts/PromptConfigsEditor.tsx',
  'src/client/features/prompts/PromptConfigList.tsx',
  'src/client/features/prompts/PromptConfigCard.tsx',
  'src/client/features/prompts/PromptConfigForm.tsx',
  'src/client/features/prompts/PromptConfigNavigation.tsx',
  'src/client/features/prompts/PromptConfigFields.tsx',
  'src/client/features/prompts/useTemplatePicker.ts',
  'src/client/features/prompts/prompt-config-policy.ts',
  'src/client/features/persona/PresetPersonaCard.tsx',
  'src/client/features/triggers/TriggerJsonField.tsx',
  'src/client/features/triggers/TriggerRulesEditor.tsx',
  'src/client/features/triggers/TriggerRuleFields.tsx',
  // ui 共享控件（其余回退文案控件仍在未迁移范围）。
  'src/client/ui/ImportPreviewCard.tsx',
  'src/client/ui/TemplatePicker.tsx',
]

/** 收集一个源文件里所有「用户可见文本」字面量（字符串 / 模板 / JSX 文本；注释天然不算）。 */
function visibleTexts(path, source) {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.ES2024,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const texts = []
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      texts.push(node.text)
    } else if (ts.isTemplateExpression(node)) {
      texts.push(node.head.text)
      for (const span of node.templateSpans) texts.push(span.literal.text)
    } else if (ts.isJsxText(node)) {
      texts.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return texts
}

test('locale 字典：zh 与 en 键集完全一致且无空值', () => {
  const zhKeys = Object.keys(PROMPT_TOOL_DICTS.zh).sort()
  const enKeys = Object.keys(PROMPT_TOOL_DICTS.en).sort()
  assert.ok(zhKeys.length >= 150, `字典规模应覆盖六页与设置（当前 ${zhKeys.length} 键）`)
  assert.deepEqual(enKeys, zhKeys, 'en 必须与 zh 键集完全一致（缺键/多键都是缺陷）')
  for (const key of zhKeys) {
    assert.ok(PROMPT_TOOL_DICTS.zh[key].trim().length > 0, `zh.${key} 不得为空`)
    assert.ok(PROMPT_TOOL_DICTS.en[key].trim().length > 0, `en.${key} 不得为空`)
  }
  assert.notDeepEqual(PROMPT_TOOL_DICTS.zh, PROMPT_TOOL_DICTS.en, 'en 必须是真实译文而非 zh 复制')
})

test('locale 命名空间与 slot 注册一致，注册走官方 register(ns, dicts)', () => {
  assert.equal(PROMPT_TOOL_NS, 'prompt-tool')
  const calls = []
  const locale = {
    register(ns, dicts) {
      calls.push({ ns, dicts })
      return () => {}
    },
  }
  const dispose = registerPromptToolLocale(locale)
  assert.equal(typeof dispose, 'function', 'register 必须返回可释放的 disposer')
  assert.equal(calls.length, 1, '一次注册调用上齐两种语言（官方类型化形式）')
  assert.equal(calls[0].ns, PROMPT_TOOL_NS)
  assert.equal(calls[0].dicts.zh, PROMPT_TOOL_DICTS.zh)
  assert.equal(calls[0].dicts.en, PROMPT_TOOL_DICTS.en)
  // 重挂语义：客户端入口把注册挂在 ctx.effect 上，卸载后 disposer 被官方调用。
  const index = read('src/client/index.ts')
  assert.match(index, /ctx\.effect\(\(\) => registerPromptToolLocale\(ctx\.locale\)\)/)
  assert.match(index, /ctx\.locale\.bind\(LOCALE_NS\)/)
  assert.match(index, /'locale',/, 'client inject 必须等待 locale 服务')
})

test('slot 注册声明 prompt-tool 命名空间，label 用动态取值', () => {
  const source = read('src/client/app/workbench/register-workbench.tsx')
  assert.match(source, /locale: PROMPT_TOOL_NS/, 'slot 注册必须声明字典命名空间')
  assert.match(source, /label: \(\) => face\.t\('tab\.label'\)/, 'label 必须是 thunk（跟随语言切换）')
})

test('关键 UI 文件不再硬编码中文长文案（文案归 prompt-tool 字典）', () => {
  for (const path of MIGRATED_UI_FILES) {
    const hits = visibleTexts(path, read(path)).filter((text) => /[\u4e00-\u9fa5]{5,}/.test(text))
    assert.deepEqual(hits, [], `${path} 仍含硬编码文案：${hits.join(' | ')}`)
  }
})

test('六页定义只存字典键，页面 id 保持稳定契约', () => {
  const source = read('src/client/app/workspace/workspace-pages.ts')
  assert.doesNotMatch(source, /label: '[^']*[\u4e00-\u9fa5]/, '页面定义不得再内联中文 label')
  const ids = [...source.matchAll(/id: '([a-z]+)'/g)].map((match) => match[1])
  assert.deepEqual(ids, ['features', 'subagent', 'tools', 'skills', 'presets', 'characters'])
})

test('shared 参数目录不留文案，每个参数键都有 UI 字典词条（param.<键>）', () => {
  const source = read('src/shared/engine-params.ts')
  assert.doesNotMatch(source, /label:\s*'/, 'shared 参数定义不得再持有显示文案')
  for (const key of ENGINE_PARAM_KEYS) {
    assert.ok(PROMPT_TOOL_DICTS.zh[`param.${key}`], `zh 缺 param.${key}`)
    assert.ok(PROMPT_TOOL_DICTS.en[`param.${key}`], `en 缺 param.${key}`)
  }
})
