import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const delegation = readFileSync(new URL('../../src/client/features/subagents/DelegationToolsCard.tsx', import.meta.url), 'utf8')
const modules = readFileSync(new URL('../../src/client/features/modules/EngineModuleList.tsx', import.meta.url), 'utf8')
const customTools = readFileSync(new URL('../../src/client/features/tools/CustomToolsCard.tsx', import.meta.url), 'utf8')
const moduleCapabilities = readFileSync(new URL('../../src/shared/engine-capabilities.ts', import.meta.url), 'utf8')

const card = (name) => {
  const start = modules.indexOf(`<EngineModuleCard name="${name}"`)
  assert.ok(start >= 0, `应存在 ${name} 模块卡`)
  const end = modules.indexOf('</EngineModuleCard>', start)
  assert.ok(end > start, `${name} 模块卡应闭合`)
  return modules.slice(start, end)
}

test('工具与深度卡保留递归深度入口', () => {
  assert.ok(delegation.includes('ariaLabel="递归深度"'), '子代理工具与深度卡应包含递归深度控件')
  assert.ok(delegation.includes('fields.maxDepth'), '递归深度控件应绑定 fields.maxDepth')
})

test('递归深度入口不重复出现', () => {
  const source = delegation + modules
  assert.equal((source.match(/ariaLabel="递归深度"/g) ?? []).length, 1, '递归深度控件应只保留一个入口')
})

test('引擎参数按能力拆成独立模块卡', () => {
  const bootstrap = card('tool-bootstrap')
  const anchor = card('anchor-turn')
  const filter = card('tool-filter')
  const editor = card('str-replace-editor')
  const deliberation = card('deliberation-gate')
  const drip = card('cot-drip')

  assert.ok(card('code-presentation').includes('pt-use-ptc'))
  assert.ok(anchor.includes('fields.anchorTurnText'))
  assert.ok(filter.includes('fields.toolFilterAllow') && filter.includes('fields.toolFilterDeny'))
  assert.ok(editor.includes('fields.strReplaceEditorMaxOutputChars'))
  assert.ok(deliberation.includes('fields.deliberationMinChars'))
  assert.ok(drip.includes('fields.cotDripEvery'))
  assert.ok(!bootstrap.includes('pt-anchor-turn'), 'tool-bootstrap 不再夹带 anchor-turn 参数')
  assert.ok(!modules.includes('<EngineModuleCard name="工具管线"'), '不再保留工具管线聚合卡')
})

test('自定义工具直接显示命令与工具卡，不保留数量聚合外壳', () => {
  assert.ok(customTools.includes('>从模板新建</button>'))
  assert.ok(customTools.includes('新建工具'))
  assert.ok(customTools.includes('<CustomToolCard'))
  assert.ok(!customTools.includes('个自定义工具 · 第三方策略见下方模块卡片'))
  assert.ok(!customTools.includes('无自定义工具；从模板新建或直接添加。'))
})

test('引擎参数 owner 不在委派卡重复编辑', () => {
  assert.doesNotMatch(delegation, /pt-tool-filter-allow|pt-tool-filter-deny|pt-allow-kinds/)
  assert.equal((modules.match(/pt-tool-filter-allow/g) ?? []).length, 1)
  assert.equal((modules.match(/pt-tool-filter-deny/g) ?? []).length, 1)
  assert.equal((modules.match(/pt-allow-kinds/g) ?? []).length, 1)
})

test('模块卡存在性经过 moduleFacts/能力目录，不由参数 truthy 推断', () => {
  assert.match(modules, /isEngineCapabilityPresent\(id, store\.moduleFacts\)/)
  assert.match(modules, /engineCapability\(id\)\?\.displayLayer/)
  assert.doesNotMatch(modules, /visibleCapability\('[^']+',\s*'(?:pre-step|system-section|tool-pipeline)'\)/)
  assert.match(moduleCapabilities, /facts\.sourceMode === 'unknown'/)
  assert.match(moduleCapabilities, /effectiveModules: string\[\] \| null/)
})
