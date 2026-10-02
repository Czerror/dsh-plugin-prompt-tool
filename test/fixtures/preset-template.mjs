/**
 * 测试夹具模块模板安装器。
 *
 * 内置 anchored 预设随上游 dsh-anchored-standard 冻结下线后，仍需一份「声明锚定/门控
 * 链路与三条提示词配置」的模板来验证 writePreset / rematerialize / 参数桥的生成契约。
 * 夹具放在 test/fixtures/preset-template/，由本模块复制进测试用的模块根。
 *
 * 安装目标取决于消费方（写两个入口，避免猜路径）：
 *  - writePreset(options.presetDir) 的模板解析根就是 options.presetDir → 用 installFixturePreset(presetDir)；
 *  - resolveModuleDir(template) 的默认根是 $DSH_HOME/.prompt-tool → 用 installFixturePresetInHome(dshHome)。
 */
import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 夹具模板 id（= 目录名 = presetTemplate 取值）。 */
export const FIXTURE_PRESET_ID = 'fixture'

/** 夹具模板源目录（仓库内，含模块定义 module.yml）。 */
export const FIXTURE_PRESET_SRC = fileURLToPath(new URL('./preset-template', import.meta.url))

/**
 * 把夹具模板安装到指定模块根：`<moduleRoot>/fixture`。
 * @param {string} moduleRoot 模块根目录（writePreset 的 presetDir / DSH_HOME 的 .prompt-tool）
 * @returns {string} 安装后的模块目录
 */
export function installFixturePreset(moduleRoot) {
  const target = join(moduleRoot, FIXTURE_PRESET_ID)
  mkdirSync(moduleRoot, { recursive: true })
  cpSync(FIXTURE_PRESET_SRC, target, { recursive: true, force: true })
  return target
}

/**
 * 把夹具模板安装到隔离 DSH_HOME 的模块根：`<dshHome>/.prompt-tool/modules/fixture`。
 * @param {string} dshHome 隔离的 DSH_HOME（测试用临时目录）
 * @returns {string} 安装后的模块目录
 */
export function installFixturePresetInHome(dshHome) {
  return installFixturePreset(join(dshHome, '.prompt-tool', 'modules'))
}
