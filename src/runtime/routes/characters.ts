/** characters 域端点：角色卡导入（同一模块安装事务）与角色合并/解除合并。 */
import { basename, dirname } from 'node:path'
import { mergeModuleIntoModule, removeMergedModule } from '../../host/characters.ts'
import { userModulesDir } from '../../host/module-dirs.ts'
import { expandModuleSource, installModulePackage, moduleImportPreview } from '../../host/module-package.ts'
import { BRIDGE_ENDPOINTS } from '../../shared/bridge-contract.ts'
import { readBridgeFiles, readImportRequestParams, type BridgeRuntime } from '../bridge-runtime.ts'

export function registerCharacters(runtime: BridgeRuntime): Array<() => void> {
  return [
    // 角色来源沿同一模块安装事务；不再维护独立角色库。
    runtime.register(BRIDGE_ENDPOINTS.charactersImport, { handle: async (tx) => {
      const dir = runtime.gate(tx, 'charactersImport').inspect()
      if (dir === undefined) return
      const record = tx.record
      // 与模块包同一套入口校验：非法 preview/摘要一律 400，且发生在写入之前。
      const request = readImportRequestParams(record)
      if (!request.ok) {
        tx.write(400, { ok: false, code: 'characters-rejected', message: request.message })
        return
      }
      if (runtime.gate(tx, 'charactersImport').authorize() === undefined) return
      try {
        const files = await expandModuleSource(request.params.sourceId === undefined ? readBridgeFiles(record.files) : runtime.assetSources.read(request.params.sourceId))
        if (tx.editDir() !== dir) {
          tx.write(409, { ok: false, code: 'characters-preview-stale', message: '目标模块已切换，请重新预览' })
          return
        }
        const root = userModulesDir()
        // 一次 preview 同时给出候选状态与转换产物：同一个请求不再把同一批文件解析两遍。
        const preview = moduleImportPreview(root, files, request.params)
        if (!('prepared' in preview)) {
          if (!request.params.preview) throw new Error('请先选择内容类型或提示顺序组并重新预览')
          tx.write(200, { ok: true, value: { preview: true, ...preview } })
          return
        }
        const { summary, sourceDigest, previewRevision } = preview
        if (request.params.preview) {
          tx.write(200, { ok: true, value: { preview: true, state: 'ready', name: summary.targetName, summary, sourceDigest, previewRevision, ...(preview.prepared.report === undefined ? {} : { report: preview.prepared.report }) } })
          return
        }
        const result = await installModulePackage(root, files, request.params, { preserveAssets: true })
        runtime.descriptor.invalidate()
        if (!await runtime.finishModuleChange(tx.write, () => runtime.deps.moduleInstalled?.(result.id))) return
        tx.write(200, { ok: true, value: { id: result.id, name: summary.targetName } })
      } catch (error) {
        const code = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'characters-rejected'
        tx.write(code.includes('stale') ? 409 : 400, { ok: false, code, message: error instanceof Error ? error.message : String(error) })
      }
    } }),
    runtime.register(BRIDGE_ENDPOINTS.charactersImportStream, { body: 'none', handle: async (tx) => {
      tx.write(410, { ok: false, code: 'asset-client-upgrade-required', message: '请刷新页面：角色卡需先上传暂存并预览，再确认导入' })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.moduleMerge, { handle: async (tx) => {
      const dir = runtime.gate(tx, 'moduleMerge').inspect()
      if (dir === undefined) return
      const record = tx.record
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      if (id.length === 0) {
        tx.write(400, { ok: false, code: 'characters-rejected', message: '缺少角色卡 id' })
        return
      }
      if (runtime.gate(tx, 'moduleMerge').authorize() === undefined) return
      const result = mergeModuleIntoModule(dirname(dir), basename(dir), id)
      if (!result.ok) {
        tx.write(400, { ok: false, code: 'characters-rejected', message: result.message })
        return
      }
      if (!await runtime.runOverridesChange(tx.write, basename(dir))) return
      tx.write(200, { ok: true, value: { id, count: result.count } })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.moduleUnmerge, { handle: async (tx) => {
      const dir = runtime.gate(tx, 'moduleUnmerge').inspect()
      if (dir === undefined) return
      const record = tx.record
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      if (id.length === 0) {
        tx.write(400, { ok: false, code: 'characters-rejected', message: '缺少角色卡 id' })
        return
      }
      if (runtime.gate(tx, 'moduleUnmerge').authorize() === undefined) return
      const result = removeMergedModule(dirname(dir), basename(dir), id)
      if (!result.ok) {
        tx.write(400, { ok: false, code: 'characters-rejected', message: result.message })
        return
      }
      if (!await runtime.runOverridesChange(tx.write, basename(dir))) return
      tx.write(200, { ok: true, value: { id, count: result.count } })
    } }),
  ]
}
