/**
 * 声明面真值源：`module.yml` 的**顶层键名集合**。
 *
 * 判据（用户拍板 2026-10-12）：键整个不存在＝没声明，`customTools: []` 算已声明；
 * 不做内容级语义。解析失败是**错误**，不是「没声明」——调用方照既有错误路径报错，
 * 不得把损坏的定义当成静默可用的空声明。真值源是定义文件本身：每次请求现读，不缓存。
 *
 * **只写在读侧**：没声明就没有内容可读，读拒绝；写一个不存在的节恰恰是创建它，写完它就被声明了，
 * 所以写路径不查声明面（见 `module-subject-gate.ts` 的 `subjectGate`）。
 */
import type { BridgeEndpointKey } from '../shared/bridge-contract.ts'
import { loadModuleDefinition } from './module-storage.ts'

/**
 * 声明面登记表：端点 → 该端点读写的 `module.yml` 节。数组表示「任一存在即算已声明」。
 *
 * 判据＝该端点读写哪个节；**不登记**创建或并入定义本身的端点（`charactersImport`／`moduleMerge`／
 * `moduleUnmerge`）与全局段端点（`bootstrap`／`describe`／`promptConfigs`／`moduleDelete`／`mutate`）。
 * 也不登记 `moduleConfigOrder`：它按全局存储根读写 `config.yml`、主语策略是 `none`，永不过归属门。
 */
export const DECLARED_SECTIONS: Partial<Record<BridgeEndpointKey, readonly string[]>> = {
  customTools: ['customTools'],
  persona: ['persona'],
  subagentToolPolicy: ['subagentToolPolicy'],
  subagentToolPolicyPreview: ['subagentToolPolicy'],
  moduleVariables: ['variables', 'variablesEnabled'],
  paramOverrides: ['params', 'layerSettings'],
  rules: ['rules'],
  moduleCapability: ['modules'],
}

/** 目标模块声明的节名集合；定义不可解析时抛既有错误，绝不返回空集。 */
export function moduleDeclarations(dir: string): Set<string> {
  return new Set(Object.keys(loadModuleDefinition(dir).source))
}

/** 薄封装：某节是否已声明。 */
export const moduleDeclares = (dir: string, section: string): boolean => moduleDeclarations(dir).has(section)
