/**
 * 预设 id 安全化：判据纯函数 + 内置预设 id 的文件系统探测。
 *
 * 背景（读宿主源码得到的事实）：agent-presets 的发现根顺序是「shipped（内置）根 → 配置根 → 用户根」，
 * 靠前的根赢同名 id，因此用户预设根里与内置同名的目录永远不会被挂载，其上的注入与定制静默失效
 * （deepseek-harness/packages/preset/agent-presets/src/preset.ts:55-64；安装包注释原话
 * "a user directory named like a shipped preset is shadowed by it"）。
 *
 * 本模块只借用其他根的 **id 名** 做避让（列目录名），不读取其预设内容——插件仍然只从用户预设根
 * 与包内模板读取定义（docs/architecture-params.md「分层」一节的不变量）。
 * 探测失败、目录缺失或宿主布局变化一律降级为空集，行为退回「不避让」的旧语义。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SAFE_PRESET_PREFIX } from '../shared/preset-ids.ts'
import { DSH_HOME } from './paths.ts'

/** 会解析到「非用户预设根」的预设 id 集合（正常即宿主内置预设）。 */
export type OccupiedPresetIds = ReadonlySet<string>

/** 空占用集合：探测不可用时的降级值，语义等于「不避让」（旧行为）。 */
export const EMPTY_OCCUPIED_PRESET_IDS: OccupiedPresetIds = new Set()

/**
 * 官方语义上的保留 id：这些名字属于宿主/上游预设，用户目录用它们会与官方撞名。
 * 其中 `cordis` 就是官方的「创造模式」（`presets/cordis/preset.yml` 的 `name: 创造模式`），
 * `creative` 是同源模板的上游名（插件包内模板即此形态）——本部署尚未安装它，但上游随时可能发布，
 * 因此与运行时探测结果一起并入占用集合（探测漏项由本表兜住）。
 */
export const SHIPPED_PRESET_ID_RESERVATIONS: ReadonlySet<string> = new Set([
  'cordis',
  'minimal',
  'ptc',
  'standard',
  'creative',
])

/**
 * 合并占用集合：保留名表 ∪ 各来源（磁盘探测 / 宿主服务），忽略未提供的来源。
 * @param sources - 依次并入的集合；undefined 表示该来源不可用。
 * @returns 新的并集（调用方持有，不被修改）。
 */
export function mergeOccupiedPresetIds(...sources: Array<ReadonlySet<string> | undefined>): OccupiedPresetIds {
  const merged = new Set<string>(SHIPPED_PRESET_ID_RESERVATIONS)
  for (const source of sources) {
    if (source === undefined) continue
    for (const id of source) merged.add(id)
  }
  return merged
}

/**
 * 与内置预设重名时改用的安全 id。
 * @param id - 期望的预设 id（模板名或用户目录名）。
 * @param occupied - 被其他根占用的 id 集合；空集 = 不避让。
 * @returns 可安全用作用户目录名的 id。
 */
export function safePresetId(id: string, occupied: OccupiedPresetIds): string {
  return occupied.has(id) ? `${SAFE_PRESET_PREFIX}${id}` : id
}

/**
 * 安全 id 反查包内模板名：模板名与输出目录名分离后，激活 `pt-standard` 仍要渲染包内 `standard` 模板。
 * 包内精确命中优先（允许包内自带同名模板），否则剥一次安全前缀再查，都没有则原样返回
 * （此时由用户目录自我渲染，与历史行为一致）。
 * @param id - 激活预设 id（用户目录名）。
 * @param hasTemplate - 包内是否存在该模板目录的谓词。
 * @returns 用于渲染的模板名。
 */
export function templateNameFor(id: string, hasTemplate: (name: string) => boolean): string {
  if (hasTemplate(id)) return id
  if (id.startsWith(SAFE_PRESET_PREFIX)) {
    const base = id.slice(SAFE_PRESET_PREFIX.length)
    if (base.length > 0 && hasTemplate(base)) return base
  }
  return id
}

/**
 * 写盘前的输出目录校验：命中外层根占用的 id 时 fail loud。
 * 静默写入只会得到一个永不挂载的目录，把缺陷藏到运行时。
 * @param outputId - 即将写入的预设目录名。
 * @param occupied - 被其他根占用的 id 集合。
 */
export function assertOutputIdSafe(outputId: string, occupied: OccupiedPresetIds): void {
  if (!occupied.has(outputId)) return
  throw new Error(
    `preset id ${JSON.stringify(outputId)} 被宿主其他预设根占用（通常是内置预设），该目录永远不会被挂载；`
    + `请改用 ${JSON.stringify(safePresetId(outputId, occupied))}，或在工作台新建一个安全 id 的预设`,
  )
}

/**
 * 文件系统探测内置预设 id：宿主 profile 的 node_modules 里随包分发的 `dsh-agent-presets/presets`。
 * 只读目录名；异常/缺失返回空集。
 * @param home - DSH_HOME（测试可传临时目录）。
 * @returns 内置预设 id 集合。
 */
export function detectShippedPresetIdsFromDisk(home: string = DSH_HOME): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const dir of shippedPresetDirCandidates(home)) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) ids.add(entry.name)
      }
    } catch {
      // 候选路径不存在或不可读：换下一个（不同部署的 profile 布局不同）。
    }
  }
  return ids
}

/** 内置预设目录候选：hoisted profiles/node_modules、各 profile 的 node_modules、pnpm 虚拟目录。 */
function shippedPresetDirCandidates(home: string): string[] {
  const packageDir = join('@deepseek-ai', 'dsh-agent-presets', 'presets')
  const profiles = join(home, 'profiles')
  const candidates = [join(profiles, 'node_modules', packageDir)]
  try {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        candidates.push(join(profiles, entry.name, 'node_modules', packageDir))
      }
    }
  } catch {
    // profiles 目录缺失：仅保留 hoisted 候选。
  }
  const pnpmRoot = join(profiles, 'node_modules', '.pnpm')
  try {
    for (const entry of readdirSync(pnpmRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('@deepseek-ai+dsh-agent-presets@')) {
        candidates.push(join(pnpmRoot, entry.name, 'node_modules', packageDir))
      }
    }
  } catch {
    // 没有 pnpm 虚拟目录：忽略。
  }
  return candidates
}
