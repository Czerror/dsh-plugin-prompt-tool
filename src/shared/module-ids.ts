/**
 * 包内模块与用户副本共用同名 ID；避免与宿主官方预设重名。
 *
 * 内置模块随包分发在仓库根的 `modules/`。旧的内置预设 `pt-*` 已整体退场——它们是官方
 * 预设形态的遗留，重构后不再读取也不再维护；这里指向当前随包分发的内置模块作为兜底。
 */
export const DEFAULT_MODULE_ID = 'ponytail'

/** 模块 id 形状：小写字母或数字开头，其余为小写字母、数字与连字符。**只在本文件内使用。** */
const MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * 形状判据本身（全仓唯一入口）；调用方各自再叠加长度等额外约束。
 *
 * 正则不导出：模块目录扫描（`host/manifest.ts`）、写盘身份断言（`host/module-install.ts`）、
 * 桥请求里的目标 id（`shared/bridge-contract.ts` 与 `runtime/settings-bridge.ts`）与客户端
 * 导入校验（`client/ui/ImportDialog.tsx`）都经这里判断。含中文或大写的目录会引发真实故障
 * ——宿主 discovery 会静默跳过它。
 */
export function isModuleId(value: unknown): value is string {
  return typeof value === 'string' && MODULE_ID_PATTERN.test(value)
}
