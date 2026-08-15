import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = join(fileURLToPath(import.meta.url), '..', '..')
const UPSTREAM = process.argv[2] ?? join(HERE, 'vendor', 'dsh-anchored-standard')
const upstreamCordis = join(UPSTREAM, 'preset', 'agent.cordis.yml')
const upstreamBootstrap = join(UPSTREAM, 'preset', 'tool-bootstrap.mjs')
const localCordis = join(HERE, 'preset', 'agent.cordis.yml')
const localBootstrap = join(HERE, 'preset', 'tool-bootstrap.mjs')

const LOCAL_INJECTOR_BLOCK = `
# prompt-tool 附加件：锚定确认后注入 prompt.md。注册在 tool-bootstrap 之后，
# 不参与首轮剥离顺序；tools / 上下文剥离全部由原版 tool-bootstrap 负责
# （首轮 = Minimal 真实 schema：持久 bash + str_replace_editor，无输出 cap），
# 此插件只做一件事——锚定轮结束后（we 确认或兜底）注入一次提示词。
- id: prompt-injector
  name: ./prompt-injector.mjs
  config:
    promptText: |-
      __PROMPT_TOOL_TEXT__
`

const changed = []

const bs = readFileSync(upstreamBootstrap, 'utf8')
const oldBs = readFileSync(localBootstrap, 'utf8')
if (bs !== oldBs) {
  writeFileSync(localBootstrap, bs, 'utf8')
  changed.push('tool-bootstrap.mjs')
}

const up = readFileSync(upstreamCordis, 'utf8').replace(/\r\n/g, '\n')
const idx = up.indexOf('- id: tool-bootstrap\n')
if (idx < 0) { console.error('upstream marker not found, abort'); process.exit(1) }
const end = up.indexOf('\n', up.indexOf('suppressedContextSources:', idx)) + 1
const merged = up.slice(0, end) + LOCAL_INJECTOR_BLOCK + '\n' + up.slice(end)
const oldCordis = readFileSync(localCordis, 'utf8').replace(/\r\n/g, '\n')
if (merged !== oldCordis) {
  writeFileSync(localCordis, merged, 'utf8')
  changed.push('agent.cordis.yml')
}

console.log(changed.length ? 'synced: ' + changed.join('; ') : 'up to date (no upstream changes)')
