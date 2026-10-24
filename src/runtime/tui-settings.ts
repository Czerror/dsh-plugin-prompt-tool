/** dsh-tui 设置区块（接缝六）：只描述可编辑字段，渲染、草稿与 revision 栅栏写入由宿主负责。 */
import type { Context } from '@deepseek-ai/cordis'
import { NS } from '../config.ts'

/** 接缝六的最小声明形状：与官方冻结的 TuiSettingsSection 同形。 */
interface TuiSettingsSectionDeclaration {
  ns: string
  title: string
  descriptions?: { zh?: string }
  fields: readonly {
    path: readonly string[]
    label: string
    descriptions?: { zh?: string }
    kind: 'boolean'
  }[]
}

interface TuiSettingsSectionsLike {
  register(section: TuiSettingsSectionDeclaration): () => void
}

/**
 * 实际 settings 命名空间：Config owner 的 Loader 行 id，不是插件名。
 * 接缝六要求区块 ns 与 settings 命名空间一致；取不到行时回退包内常量。
 */
export function settingsNamespace(ctx: Context): string {
  const entry = (ctx.fiber as { entry?: { options?: { id?: string } } }).entry
  return entry?.options?.id ?? NS
}

/**
 * 接缝六的注册方式：inject 等 'tuiSettingsSections'，register 返回的 disposer
 * 挂在注入子 fiber 上——服务重挂时旧注册先撤销，避免同 ns 重复注册。
 * shortcut: 本地形状对齐冻结的接缝六，未引 @deepseek-harness-tui/dsh-tui 类型；
 * 官方形状变更时按 plugin-admission-and-development.md 接缝六人工同步。
 * 区块只覆盖 settings 文档里的模块总开关，模块参数/规则/技能仍走 /prompt-tool。
 */
export function registerTuiSettingsSection(ctx: Context, ns: string): void {
  const host = ctx as unknown as {
    inject(deps: readonly string[], callback: (child: Context & { tuiSettingsSections: TuiSettingsSectionsLike }) => void): unknown
  }
  host.inject(['tuiSettingsSections'], (sctx) => {
    sctx.effect(() => sctx.tuiSettingsSections.register({
      ns,
      title: 'Prompt tool',
      descriptions: { zh: '提示词工具' },
      fields: [{
        path: ['modulesEnabled'],
        label: 'Modules enabled',
        descriptions: { zh: '启用模块' },
        kind: 'boolean',
      }],
    }))
  })
}
