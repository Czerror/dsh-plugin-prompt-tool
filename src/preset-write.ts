/** preset 生成目录写入：引擎/anchored 脚本复制与提示词配置模块落盘。 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { buildCordis, buildPromptConfigFiles, loadPromptConfigFiles } from './preset-core.ts'
import type { PromptConfigSpec } from './preset-core.ts'
import { DEFAULT_PRESET_DIR } from './config.ts'

// preset 模板文件：本项目自有快照，运行时不再直读 upstream/ 下的 JS。
const PRESET_TEMPLATE_META = fileURLToPath(new URL('../preset/preset.yml', import.meta.url))
const LOCAL_PRESET_DIR = fileURLToPath(new URL('../preset', import.meta.url))
/** 项目本体：注入引擎与其共享设施，复制到生成目录 engine/。 */
const ENGINE_SCRIPTS = ['prompt-config-engine.mjs', 'shared.mjs', 'compaction-epoch.mjs'] as const
/** anchored 预设配置脚本，复制到生成目录 anchored/。 */
const ANCHORED_SCRIPTS = ['context-gate.mjs', 'tool-bootstrap.mjs', 'router-first-turn.mjs', 'custom-bash.mjs', 'skill-search.mjs', 'run-code-env.mjs'] as const


interface WritePresetOptions {
  anchorFirstTurn: boolean
  anchorText: string
  anchorCustom: boolean
  guideText: string
  guideCustom: boolean
  injectPrompt: boolean
  subagentFlash: boolean
  subagentFlashProvider: string
  subagentFlashModel: string
  bootstrapMaxTokens: number
  usePtcMode: boolean
  /** 写入 agents-instruction.txt 供 prompt-config-engine.mjs 的 instruction-hint 提示词配置读取；不传则使用本地默认 hint。 */
  agentsInstructionText?: string
  presetDir: string
  presetOrder: number
  /** settings 层用户自定义提示词配置（优先级最高）。 */
  promptConfigs: PromptConfigSpec[]
  /** 用户自定义提示词配置目录（优先级低于 promptConfigs）。 */
  promptConfigsDir: string
  /** 目录加载失败等非致命告警回调。 */
  warn?: (message: string) => void
}

// 完整 anchored preset：全部由 preset/ 自有快照组装；动态项（usePtcMode /
// bootstrapMaxTokens / subagentFlash）由 buildCordis 注入。所有提示词注入
// 收敛为 ./prompt-configs 下的 YAML 提示词配置模块，由 prompt-config-engine.mjs 扫描执行；
// 常驻规则提示等附加内容由 instruction-hint 提示词配置在运行时注入。
export function writePreset(prompt: string, options: WritePresetOptions): void {
  // 空路径兜底：旧版 UI 保存的空串 presetDir 不得传入 mkdirSync('')。
  const presetDir = options.presetDir.trim().length > 0 ? options.presetDir : DEFAULT_PRESET_DIR
  mkdirSync(presetDir, { recursive: true })
  const cordisOptions = {
    anchorFirstTurn: options.anchorFirstTurn,
    anchorText: options.anchorText,
    anchorCustom: options.anchorCustom,
    guideText: options.guideText,
    guideCustom: options.guideCustom,
    injectPrompt: options.injectPrompt,
    subagentFlash: options.subagentFlash,
    subagentFlashProvider: options.subagentFlashProvider,
    subagentFlashModel: options.subagentFlashModel,
    bootstrapMaxTokens: options.bootstrapMaxTokens,
    usePtcMode: options.usePtcMode,
  }
  writeFileSync(join(presetDir, 'agent.cordis.yml'), buildCordis(prompt, cordisOptions), 'utf8')
  const meta = readFileSync(PRESET_TEMPLATE_META, 'utf8').replace(/^order:.*$/m, `order: ${options.presetOrder}`)
  writeFileSync(join(presetDir, 'preset.yml'), meta, 'utf8')
  // 项目本体：注入引擎与其共享设施复制到生成目录 engine/。
  const engineDir = join(presetDir, 'engine')
  rmSync(engineDir, { recursive: true, force: true })
  mkdirSync(engineDir, { recursive: true })
  for (const file of ENGINE_SCRIPTS) {
    writeFileSync(join(engineDir, file), readFileSync(join(LOCAL_PRESET_DIR, 'engine', file), 'utf8'), 'utf8')
  }
  // vendored yaml 依赖（完整 YAML 解析，运行期相对 import）。
  cpSync(join(LOCAL_PRESET_DIR, 'engine', 'vendor'), join(engineDir, 'vendor'), { recursive: true, force: true })
  // anchored 预设配置脚本复制到生成目录 anchored/。
  const anchoredDir = join(presetDir, 'anchored')
  mkdirSync(anchoredDir, { recursive: true })
  for (const file of ANCHORED_SCRIPTS) {
    writeFileSync(join(anchoredDir, file), readFileSync(join(LOCAL_PRESET_DIR, 'anchored', file), 'utf8'), 'utf8')
  }
  // 提示词配置文件夹：每个提示词配置一个 yml，文件名数字前缀决定引擎执行顺序。
  // 优先级：默认四条提示词配置 < promptConfigsDir 文件提示词配置 < settings.promptConfigs。
  const promptConfigsDir = join(presetDir, 'prompt-configs')
  rmSync(promptConfigsDir, { recursive: true, force: true })
  mkdirSync(promptConfigsDir, { recursive: true })
  let dirConfigs: PromptConfigSpec[] = []
  if (options.promptConfigsDir.length > 0) {
    try {
      dirConfigs = loadPromptConfigFiles(options.promptConfigsDir)
    } catch (error) {
      options.warn?.(`prompt-tool: failed to load promptConfigsDir ${JSON.stringify(options.promptConfigsDir)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const config of buildPromptConfigFiles(cordisOptions, prompt, dirConfigs, options.promptConfigs)) {
    writeFileSync(join(promptConfigsDir, config.file), config.content, 'utf8')
  }
  // 清理历史平铺脚本与独立模块快照（旧版生成目录残留，新架构不再注册）。
  for (const legacy of ['prompt-injector.mjs', 'near-anchor.mjs', 'router-guide.mjs', 'instruction-hint.mjs', 'turn-anchor.mjs', 'dev-tool-search.mjs', 'prompt-config-engine.mjs', 'shared.mjs', 'compaction-epoch.mjs', 'context-gate.mjs', 'tool-bootstrap.mjs', 'router-first-turn.mjs', 'custom-bash.mjs', 'skill-search.mjs', 'run-code-env.mjs']) {
    rmSync(join(presetDir, legacy), { force: true })
  }
  const agentsInstructionPath = join(presetDir, 'agents-instruction.txt')
  if (options.agentsInstructionText !== undefined) {
    writeFileSync(agentsInstructionPath, options.agentsInstructionText, 'utf8')
  } else {
    rmSync(agentsInstructionPath, { force: true })
  }
}
