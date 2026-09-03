import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const uiDir = new URL('../../src/client/ui/', import.meta.url)

test('ui 模块只依赖 React、宿主原子、同层文件与共享样式', () => {
  for (const file of readdirSync(uiDir).filter((name) => /\.(?:ts|tsx)$/.test(name))) {
    const source = readFileSync(new URL(file, uiDir), 'utf8')
    assert.doesNotMatch(source, /from ['"].*\/data\//, `${file} 不得依赖 data`)
    assert.doesNotMatch(source, /from ['"].*\/features\//, `${file} 不得依赖 feature`)
    assert.doesNotMatch(source, /bridgeCall|PromptToolStore/, `${file} 不得读取业务状态或 bridge`)
  }
})
