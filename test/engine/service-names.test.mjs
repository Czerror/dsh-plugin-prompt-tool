/**
 * 源级守卫：服务名的真值源在 `engine/service-names.mjs`，扫描面内其余位置不得再写这些字面量。
 *
 * 这是**防下次手抄**的源码扫描，不是行为断言：服务名两侧对得上、四个模块工具外壳按名挂载，
 * 由既有的 `test/engine/tool-module-mount.test.mjs` 按行为覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
/** 唯一允许出现这些字面量的文件（即真值源本身）。 */
const truthSource = 'engine/service-names.mjs'

/** 手抄即违规的五个服务名字面量。 */
const literals = [
  'promptToolPreStep',
  'pt-module-import-tools',
  'pt-module-rule-tools',
  'pt-module-memory-tools',
  'pt-module-variable-tools',
]

/** 扫描面：engine 下的 .mjs（vendor 是分发快照，不改也不扫）与 src 下的全部文件。 */
function scanned(dir, accept) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'vendor') return []
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return scanned(full, accept)
    return accept(entry.name) ? [full] : []
  })
}

const files = [
  ...scanned(join(repoRoot, 'engine'), name => name.endsWith('.mjs')),
  ...scanned(join(repoRoot, 'src'), () => true),
]

test('服务名字面量只允许出现在 engine/service-names.mjs', () => {
  const offenders = []
  for (const file of files) {
    const display = file.slice(repoRoot.length).replaceAll('\\', '/')
    if (display === truthSource) continue
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      for (const literal of literals) {
        if (line.includes(literal)) offenders.push(`${display}:${index + 1} 手抄了 ${literal}`)
      }
    })
  }
  assert.deepEqual(offenders, [],
    `服务名只能在 ${truthSource} 定义，以下位置手抄了字面量：\n${offenders.join('\n')}`)
})
