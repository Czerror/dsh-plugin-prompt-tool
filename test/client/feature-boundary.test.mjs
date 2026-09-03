import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const featuresDir = new URL('../../src/client/features/', import.meta.url)
const featureNames = readdirSync(featuresDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
const siblingImport = new RegExp(`from ['"]\\.\\./(${featureNames.join('|')})/`)

test('feature 不直接导入其他 feature 内部实现', () => {
  for (const feature of featureNames) {
    const dir = new URL(`${feature}/`, featuresDir)
    for (const file of readdirSync(dir).filter((name) => /\.(?:ts|tsx)$/.test(name))) {
      const source = readFileSync(new URL(file, dir), 'utf8')
      assert.doesNotMatch(source, siblingImport, `${feature}/${file} 存在跨 feature 内部依赖`)
    }
  }
})

test('客户端根目录只保留入口、共享类型与待拆样式', () => {
  const files = readdirSync(new URL('../../src/client/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(files, ['index.ts', 'prompt-tool-types.ts'])
})
