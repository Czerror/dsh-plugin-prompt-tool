import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { assertModuleDirectory } from './module-install.ts'

export interface ModuleToolTarget {
  id: string
  root: string
  dir: string
}

export interface ModuleToolHost {
  target: (exec: ToolExecution) => ModuleToolTarget
  rebuild: (id: string) => Promise<void>
}

/**
 * 工具目标来自执行 Agent 的**已启用规则模块**：这个 Agent 实际装了哪几层规则。
 *
 * 不再查询宿主 `agentPresets.composedPreset()`——模块与官方预设已解耦，会话绑定哪个
 * 官方预设与本插件的写入目标无关（那正是「装的是 A 的提示词、工具却写进 B」的成因）。
 * 装了多层时取启用表里的第一个，与配装顺序同源。
 *
 * 人设来源不在其中：它由 `personaSources` 独立引用、可以指向未启用的模块，正文写入走
 * persona 端点并显式携带模块 id，因此「这套人设从哪来」不经过本函数。
 *
 * 目标 id 只来自装配记录（宿主 `agent/created` 事件建立），**不取自工具参数或模型输出**；
 * 落点仍由 `assertModuleDirectory` 做存在性、链接与身份校验。
 */
export function resolveModuleToolTarget(
  exec: ToolExecution, root: string, moduleIdsOf: (sessionId: string) => readonly string[],
): ModuleToolTarget {
  const agent = exec.agent
  const id = agent === undefined ? undefined : moduleIdsOf(agent.id)[0]
  if (id === undefined) throw new Error('当前会话没有已启用的规则模块：请先在模块页启用至少一个模块')
  return { id, root, dir: assertModuleDirectory(root, id) }
}
