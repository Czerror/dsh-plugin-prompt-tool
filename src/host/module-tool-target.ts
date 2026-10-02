import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { assertModuleDirectory } from './module-install.ts'

export interface PresetToolTarget {
  id: string
  root: string
  dir: string
}

export interface PresetToolHost {
  target: (exec: ToolExecution) => PresetToolTarget
  rebuild: (id: string) => Promise<void>
}

/** 工具目标来自执行 Agent 的官方绑定；工作台编辑选择不参与解析。 */
export function resolveModuleToolTarget(
  ctx: Context, exec: ToolExecution, root: string, owns: (id: string) => boolean,
): PresetToolTarget {
  const registry = ctx.get('agentPresets')
  const id = exec.agent === undefined ? undefined : registry?.composedPreset(exec.agent.ctx)
  if (id === undefined || !owns(id)) throw new Error('会话预设不可写：未绑定本插件管理的用户预设')
  return { id, root, dir: assertModuleDirectory(root, id) }
}

/** 定义已经保存时，不把注册失败伪装成整个写入未发生。 */
export async function rebuildSavedPreset(host: PresetToolHost, id: string): Promise<void> {
  try { await host.rebuild(id) }
  catch (error) { throw new Error(`预设 ${id} 已保存，但重建或注册失败：${String(error)}`, { cause: error }) }
}
