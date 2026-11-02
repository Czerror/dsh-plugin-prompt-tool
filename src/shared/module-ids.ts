/** 模块 id 形状：小写字母或数字开头，其余为小写字母、数字与连字符。**只在本文件内使用。** */
const MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * 形状判据本身（全仓唯一入口）；调用方各自再叠加长度等额外约束。
 *
 * 正则不导出：模块目录扫描（`host/module-catalog.ts`）、写盘身份断言（`host/module-install.ts`）、
 * 桥请求里的目标 id（`shared/bridge-contract.ts` 与 `runtime/settings-bridge.ts`）与客户端
 * 导入校验（`client/ui/ImportDialog.tsx`）都经这里判断。含中文或大写的目录会引发真实故障
 * ——宿主 discovery 会静默跳过它。
 */
export function isModuleId(value: unknown): value is string {
  return typeof value === 'string' && MODULE_ID_PATTERN.test(value)
}
