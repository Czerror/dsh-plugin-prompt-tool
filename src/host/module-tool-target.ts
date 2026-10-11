import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { assertModuleDirectory } from './module-install.ts'

export interface ModuleToolTarget {
  id: string
  root: string
  dir: string
}

export interface ModuleToolHost {
  /** 模块存储根：导入类工具在这里创建新模块，不需要既有模块作主语。 */
  root: string
  /** 目标模块只来自这次调用声明的 `moduleId`；未声明即无目标，拒绝，不回退任何默认模块。 */
  target: (exec: ToolExecution, moduleId: string | undefined) => ModuleToolTarget
  rebuild: (id: string) => Promise<void>
}

/**
 * 模块工具的主语参数：每次调用显式声明，不传即没有目标。
 *
 * 主语由**这次操作**声明，工具 schema 是静态的、列不出会话里的模块，候选 id 因此进拒绝文案。
 */
export const MODULE_ID_PARAM = {
  type: 'string',
  description: '本次读写的模块 id（模块存储根下 module.yml 所在目录名）。不传即没有目标，直接拒绝——本工具不会替你挑一个模块。',
} as const

/**
 * 工具目标由这次调用显式声明的 `moduleId` 定位（ADR-0014 阶段 4）：未声明即**没有目标**，
 * 按错误拒绝，不回退装配记录首项或包内默认模块。
 *
 * 该 Agent 这次装了哪几层只作拒绝时的候选提示，绝不作为目标；落点由 `assertModuleDirectory`
 * 做存在性、链接与身份校验，任意已安装模块都可读写（编辑通道不查启用，ADR-0011）。
 */
export function resolveModuleToolTarget(
  exec: ToolExecution, root: string, moduleIdsOf: (sessionId: string) => readonly string[], moduleId: string | undefined,
): ModuleToolTarget {
  const id = typeof moduleId === 'string' ? moduleId.trim() : ''
  if (id.length === 0) {
    const agent = exec.agent
    const candidates = agent === undefined ? [] : moduleIdsOf(agent.id)
    throw new Error(candidates.length === 0
      ? '没有声明模块目标：请在 moduleId 参数里指定要读写的模块 id'
      : `没有声明模块目标：请在 moduleId 参数里指定要读写的模块 id（本 Agent 已启用：${candidates.join('、')}）`)
  }
  return { id, root, dir: assertModuleDirectory(root, id) }
}
