/**
 * 旧布局 → 官方对齐布局的一次性迁移（幂等，可重跑）。
 *
 * 旧布局（三重分裂）：
 *   .agent-presets/prompt-tool/         容器根（薄转发 agent.cordis.yml + 共享 engine/ + <模板>/ 子预设）
 *   ~/.dsh/presets/<id>/preset.yml     用户预设参数副本（不可直接挂载）
 * 新布局（官方对齐）：
 *   .agent-presets/<id>/                每预设一个官方预设目录（agent.cordis.yml 组合本体 + preset.yml）
 *   .agent-presets/.engine/             共享引擎（点前缀，discovery 跳过）
 *
 * 迁移动作：
 *   1) 容器根 engine/ → 预设根 .engine/（rename，未迁移过才执行）；
 *   2) ~/.dsh/presets/*（含 preset.yml 的目录）→ 预设根/<id>/（复制，已存在跳过）；
 *   3) 迁移完成后把旧容器根与旧用户预设目录 rename 为 .bak-<ts> 归档
 *      （保留安全网，不删除；7 天后可人工清理）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export function migrateLegacyLayout(presetRoot: string, legacyUserPresets: string): boolean {
  const legacyContainer = join(presetRoot, 'prompt-tool')
  const sharedEngine = join(presetRoot, '.engine')
  let migrated = false

  // 1) 共享引擎：旧容器根 engine/ → 预设根 .engine/。
  const legacyEngine = join(legacyContainer, 'engine')
  if (existsSync(legacyEngine) && !existsSync(sharedEngine)) {
    try {
      mkdirSync(presetRoot, { recursive: true })
      renameSync(legacyEngine, sharedEngine)
      migrated = true
    } catch {
      // Windows 瞬时锁：下次启动重试（幂等）。
    }
  }

  // 2) 旧用户预设 ~/.dsh/presets/* → 预设根/<id>/（只迁移含 preset.yml 的目录）。
  if (existsSync(legacyUserPresets)) {
    try {
      for (const entry of readdirSync(legacyUserPresets, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        if (!existsSync(join(legacyUserPresets, entry.name, 'preset.yml'))) continue
        const target = join(presetRoot, entry.name)
        if (existsSync(join(target, 'preset.yml'))) continue
        mkdirSync(target, { recursive: true })
        cpSync(join(legacyUserPresets, entry.name), target, { recursive: true, force: true })
        migrated = true
      }
    } catch {
      // 部分失败下次重试；已复制目录幂等跳过。
    }
  }

  // 3) 归档旧目录（全部子预设已复制后才归档旧用户目录）。
  const allUserPresetsCopied = ((): boolean => {
    try {
      return readdirSync(legacyUserPresets, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .every((entry) => !existsSync(join(legacyUserPresets, entry.name, 'preset.yml'))
          || existsSync(join(presetRoot, entry.name, 'preset.yml')))
    } catch {
      return false
    }
  })()
  const stamp = Date.now().toString(36)
  if (existsSync(sharedEngine) && existsSync(legacyContainer)) {
    try {
      renameSync(legacyContainer, join(presetRoot, `prompt-tool.bak-${stamp}`))
      migrated = true
    } catch {
      // 下次启动重试。
    }
  }
  if (allUserPresetsCopied && existsSync(legacyUserPresets)) {
    try {
      renameSync(legacyUserPresets, join(join(legacyUserPresets, '..'), `presets.bak-${stamp}`))
      migrated = true
    } catch {
      // 下次启动重试。
    }
  }
  return migrated
}

/** 旧版 presetDir 配置值（容器根/旧用户目录）归一化为预设根；其余原样。 */
export function normalizePresetRootDir(presetDir: string, presetRoot: string, legacyContainer: string): string {
  if (presetDir === legacyContainer || presetDir === join(presetRoot, 'prompt-tool')) return presetRoot
  if (presetDir.endsWith('/prompt-tool') || presetDir.endsWith('\\prompt-tool')) return presetRoot
  return presetDir
}
