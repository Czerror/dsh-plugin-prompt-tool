import type { BridgeValueMap } from '../../shared/bridge-contract.ts'
import type { BridgeResult } from './bridge-transport.ts'

export type ConfirmSkillOverwrite = (names: string[]) => Promise<boolean>
type ImportResult = BridgeResult<BridgeValueMap['skillsImport']>

/** 两个导入入口共用确认协议；新增冲突必须再次确认，不保存内容版本。 */
export async function requestSkillImport(
  submit: (overwrite?: string[]) => Promise<ImportResult>,
  confirm?: ConfirmSkillOverwrite,
): Promise<ImportResult> {
  const approved = new Set<string>()
  let result = await submit()
  while (!result.ok && result.code === 'skills-overwrite-required' && result.conflicts?.length) {
    if (confirm === undefined) return result
    if (!await confirm(result.conflicts)) return { ok: false, code: 'skills-import-cancelled' }
    for (const name of result.conflicts) approved.add(name)
    result = await submit([...approved])
  }
  return result
}
