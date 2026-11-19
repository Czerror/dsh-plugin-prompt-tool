import { bridgeCall } from './bridge-client.ts'
import { createInstructionEditor, type InstructionIngestInput, type createInstructionPolicyState } from './instruction-editor.ts'
import { unsavedInstructionDrafts } from './instruction-drafts.ts'

/** 入口给出本次会话；迟到的读取和写入只更新原编辑器。 */
export function createWorkspaceInstructions(sessionId: string | undefined, notify: (kind: 'ok' | 'error', message: string) => void,
  policyState: ReturnType<typeof createInstructionPolicyState>) {
  const listeners = new Set<() => void>()
  let version = 0
  let loaded = false
  let reading: Promise<void> | undefined
  const changed = () => { version++; listeners.forEach(listener => listener()) }
  const editor = createInstructionEditor({
    sessionId: () => sessionId,
    request: bridgeCall,
    notify, policyState, onChange: changed,
  })
  editor.switchSession(sessionId)
  function ingest(input: InstructionIngestInput) {
    const { stranded } = editor.ingestSnapshot(input)
    if (stranded.length) notify('error', `有 ${stranded.length} 个未保存的指令文件已离开当前授权范围，草稿仍保留。`)
    loaded = input.instructions !== undefined
  }
  return {
    editor, ingest, changed,
    hasDraft: () => unsavedInstructionDrafts(editor.getPool()).length > 0,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot: () => version,
    invalidate() { loaded = false },
    ensure() {
      if (loaded || reading) return reading
      const expectPolicy = editor.getPolicy(), pool = editor.getPool()
      reading = Promise.all([bridgeCall('promptConfigs', { sessionId }), bridgeCall('instructionsPolicy')])
        .then(([result, policyResult]) => {
          if (!result.ok) { notify('error', result.message ?? '读取指令文件失败'); return }
          if (editor.getPool() === pool) ingest({ instructions: result.value.instructions, promptConfigs: result.value, policyResult, expectPolicy })
        }).finally(() => { reading = undefined })
      return reading
    },
  }
}
