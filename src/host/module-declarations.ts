/**
 * 声明面由本地已提交清单保存的顶层键名决定。
 *
 * 判据（用户拍板 2026-10-12）：键整个不存在＝没声明，`customTools: []` 算已声明；
 * 不做内容级语义。解析失败是**错误**，不是「没声明」——调用方照既有错误路径报错，
 * 不得把损坏的状态当成静默可用的空声明。
 *
 * **只写在读侧**：没声明就没有内容可读，读拒绝；写一个不存在的节恰恰是创建它，写完它就被声明了，
 * 所以写路径不查声明面（见 `module-subject-gate.ts` 的 `subjectGate`）。
 */
import type { BridgeEndpointKey } from '../shared/bridge-contract.ts'
import { readModuleDeclaredKeys } from './module-slices.ts'

/**
 * 声明面登记表：端点 → 该端点读写的 `module.yml` 节。数组表示「任一存在即算已声明」。
 *
 * 判据＝该端点读写哪个节；**不登记**创建定义本身的端点（`importModulePackage`）与全局段端点
 * （`bootstrap`／`describe`／`promptConfigs`／`moduleDelete`／`mutate`）。
 * 也不登记 `moduleConfigOrder`：它按全局存储根读写 `config.yml`、主语策略是 `none`，永不过归属门。
 */
export const DECLARED_SECTIONS: Partial<Record<BridgeEndpointKey, readonly string[]>> = {
  customTools: ['customTools'],
  moduleVariables: ['variables', 'variablesEnabled'],
  paramOverrides: ['params', 'layerSettings', 'modules', 'moduleConfigs'],
  rules: ['rules'],
  moduleCapability: ['modules'],
}

/** 目标模块声明的节名集合；定义不可解析时抛既有错误，绝不返回空集。 */
export function moduleDeclarations(dir: string): Set<string> {
  return readModuleDeclaredKeys(dir)
}
