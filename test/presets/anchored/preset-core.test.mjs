import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { buildCordis } from '../../../lib/preset-core.mjs'

test('buildCordis 生成合法 YAML：prompt-config-engine 指向提示词配置模块目录，且落在 tool-bootstrap 之后', () => {
  const out = buildCordis('PROMPT')
  assert.ok(!out.includes('__SLOTS__'))

  const bootstrap = out.indexOf('- id: tool-bootstrap\n')
  const engine = out.indexOf('- id: prompt-config-engine\n')
  const identity = out.indexOf('# ── identity')
  assert.ok(bootstrap >= 0)
  assert.ok(bootstrap < engine)
  assert.ok(engine < identity)

  const doc = parse(out, { logLevel: 'silent' })
  assert.ok(Array.isArray(doc))
  const row = doc.find((entry) => entry?.id === 'prompt-config-engine')
  assert.ok(row)
  assert.equal(row.name, './engine/prompt-config-engine.mjs')
  assert.equal(row.config.configsDir, '../prompt-configs')
  const rft = doc.find((entry) => entry?.id === 'router-first-turn')
  assert.ok(rft)
  assert.equal(rft.name, './engine/router-first-turn.mjs')
})

test('buildCordis 恒生成 run-code-env 行（PTC env 提示词配置）', () => {
  const out = buildCordis('PROMPT')
  const doc = parse(out, { logLevel: 'silent' })
  const row = doc.find((entry) => entry?.id === 'run-code-env')
  assert.ok(row)
  assert.equal(row.name, './engine/run-code-env.mjs')
  assert.equal(row.config.enabled, true)
  assert.ok(row.config.envKeys.includes('PATH'))
  assert.ok(row.config.envKeys.includes('USERPROFILE'))
})

test('buildCordis 关闭 firstTurnAnchor 时输出与无选项版本一致', () => {
  assert.equal(buildCordis('PROMPT', { firstTurnAnchor: false, firstTurnText: 'X' }), buildCordis('PROMPT'))
})

function findAllRows(doc, ids) {
  const found = []
  const walk = (rows) => {
    for (const row of rows) {
      if (row !== null && typeof row === 'object') {
        if (ids.has(row.id)) found.push(row)
        if (Array.isArray(row.config)) walk(row.config)
      }
    }
  }
  walk(Array.isArray(doc) ? doc : [])
  return found
}

test('buildCordis 设置子代理模型服务商与模型名时给 subagent/subagent_fork 加固定模型路由', () => {
  const out = buildCordis('PROMPT', {
    subagentModelProvider: 'my-provider',
    subagentModelName: 'deepseek-v4-flash-7013',
  })
  const doc = parse(out, { logLevel: 'silent' })
  const rows = findAllRows(doc, new Set(['tool-subagent', 'tool-subagent-fork']))
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.config.agentOptions.provider, 'my-provider')
    assert.equal(row.config.agentOptions.model, 'deepseek-v4-flash-7013')
    assert.match(row.config.persona, /decide the task type \(build or fix\)/)
    assert.match(row.config.persona, /Do not run environment checks/)
    assert.match(row.config.persona, /Think deeply first, then produce\./)
  }
})

test('buildCordis 适配 context-gate：放行 near-anchor/router-guide，子代理不关门', () => {
  const out = buildCordis('PROMPT')
  const doc = parse(out, { logLevel: 'silent' })
  const row = doc.find((entry) => entry?.id === 'context-gate')
  assert.ok(row)
  assert.equal(row.config.includeSubagents, false)
  assert.deepEqual(row.config.allowKinds, ['skill-invocation', 'near-anchor', 'router-guide'])
})

test('buildCordis custom-bash 运行时探测并显式写入超时/输出上限', () => {
  const out = buildCordis('PROMPT')
  assert.ok(!out.includes('bashPath:'))
  const doc = parse(out, { logLevel: 'silent' })
  const row = findAllRows(doc, new Set(['custom-bash']))[0]
  assert.ok(row)
  assert.equal(row.config.timeoutMs, 120000)
  assert.equal(row.config.maxOutputBytes, 64000)
})

test('buildCordis 默认不注入 bootstrapMaxTokens（本项目默认无封顶）', () => {
  const out = buildCordis('PROMPT')
  assert.ok(!out.includes('bootstrapMaxTokens:'))
})

test('buildCordis 按配置注入任意正整数 bootstrapMaxTokens', () => {
  const out = buildCordis('PROMPT', { bootstrapMaxTokens: 2048 })
  const doc = parse(out, { logLevel: 'silent' })
  const row = findAllRows(doc, new Set(['tool-bootstrap']))[0]
  assert.ok(row)
  assert.equal(row.config.bootstrapMaxTokens, 2048)
})

test('buildCordis 未设置模型服务商/模型名时子代理行不出现 agentOptions', () => {
  const out = buildCordis('PROMPT')
  const doc = parse(out, { logLevel: 'silent' })
  const row = findAllRows(doc, new Set(['tool-subagent']))[0]
  assert.ok(row)
  assert.equal(row.config.agentOptions, undefined)
})

test('buildCordis 默认开启使用 PTC 模式', () => {
  const out = buildCordis('PROMPT')
  const doc = parse(out, { logLevel: 'silent' })
  const bootstrap = doc.find((entry) => entry?.id === 'tool-bootstrap')
  const search = doc.find((entry) => entry?.id === 'dev-tool-search')
  assert.ok(bootstrap)
  assert.equal(bootstrap.config.usePtcMode, true)
  assert.equal(search, undefined)
})

test('buildCordis 可显式关闭使用 PTC 模式：恢复原生完整目录', () => {
  const out = buildCordis('PROMPT', { usePtcMode: false })
  const doc = parse(out, { logLevel: 'silent' })
  const bootstrap = doc.find((entry) => entry?.id === 'tool-bootstrap')
  assert.ok(bootstrap)
  assert.equal(bootstrap.config.usePtcMode, false)
})
