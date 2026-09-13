/**
 * 编译期契约：本插件产出的子代理模型路由必须与官方声明一致。
 *
 * 1. `resolveSubagentStartOptions` 的返回值就是官方 {@link SubagentStartRequest}
 *    的 `agentOptions` 字段类型（`AgentOptions`）；
 * 2. 本插件生成的 `tool-subagent` / `tool-subagent-fork` 行 config 必须可赋值给
 *    官方 `@deepseek-ai/dsh-tool-subagent` 的 `Config`（provider/model 成对，
 *    显式选项优先，persona 与 toolFilter 语义由官方实现）；
 * 3. `SubagentModelSelectionSettings` 的 `allowedModels` 是官方设置面，
 *    本插件的路由不写进该设置面（保持宿主 opt-in，不由插件代填）。
 *
 * 该文件只做类型检查（tsconfig.json 的 include 覆盖 test/types），不参与打包与测试发现。
 */
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { PluginSubagentSeam, resolveSubagentStartOptions } from '../../src/index.ts'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { Config as ToolSubagentConfig } from '@deepseek-ai/dsh-tool-subagent'

type StartOptions = NonNullable<SubagentStartRequest['agentOptions']>
type PluginOptions = ReturnType<typeof resolveSubagentStartOptions>

/** 插件产出的路由必须与官方 agentOptions 同型（可赋值且能被官方接受）。 */
type PluginOptionsAssignable = PluginOptions extends StartOptions | undefined ? true : never
export const pluginOptionsAssignable: PluginOptionsAssignable = true

/** 官方 agentOptions 也必须接受插件产出的具体值（方向相反，防止额外必填字段）。 */
type StartOptionsAssignable = StartOptions extends AgentOptions ? true : never
export const startOptionsAssignable: StartOptionsAssignable = true

/** `tool-subagent` 行 config 的本地形状必须被官方 Config 接受（方向相反）。 */
export const defaults: ToolSubagentConfig = {
  provider: 'spawn',
  agentOptions: { provider: 'p', model: 'm' },
  toolFilter: { allow: ['read'] },
  maxDepth: 3,
}
type ToolSubagentConfigAssignable = ToolSubagentConfig extends {
  provider: string
  agentOptions?: AgentOptions
} ? true : never
export const toolSubagentConfigAssignable: ToolSubagentConfigAssignable = true

/** 本插件只读 registry 的 provider 列表，不替换 start / startContinuable 方法。 */
export const seam: PluginSubagentSeam = {
  list: () => [],
  getProvider: () => undefined,
}
