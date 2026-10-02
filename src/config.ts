/** 插件配置、settings 数据模型与默认常量（settings 接口层）。 */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

export const NS = 'prompt-tool' as const

/** 引擎行为参数键：定义见 shared/param-keys.ts（write-preset 合并过滤共用）。 */
export { PARAM_KEYS } from './shared/param-keys.ts'

export interface Config {
  /** 模块运行总闸；保留既有持久键，关闭只撤回运行贡献。 */
  writePreset: Volatile<boolean>
}

// 官方插件配置范式：同名 interface Config 与 Schemastery schema 成对导出，
// 框架在插件加载时校验并填充默认值。
export const Config = z.object({
  writePreset: z.boolean().default(true).volatile(),
})

export interface PromptSettings {
  /** 运行时检测：是否检测到任何模型服务商（不写入 settings）。 */
  modelsAvailable: boolean
  writePreset: boolean
}

/** 运行时只缓存部署设置；模块行为与正文始终从目标定义读取。 */
export type RuntimeOptions = Omit<PromptSettings, 'modelsAvailable'>
