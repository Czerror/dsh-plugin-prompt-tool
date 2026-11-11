import { labelOf } from './shared.mjs'

const validFileId = value => typeof value === 'string' && value.trim().length > 0

/** 仅声明当前 Agent 要求关闭的既有 fileId；实际身份由协调器从当前官方消息确认。 */
export function prepareInstructionPolicy(action, plugin) {
  const label = labelOf(action)
  if (action.fileIds !== undefined && (!Array.isArray(action.fileIds) || action.fileIds.some(fileId => !validFileId(fileId)))) {
    throw new TypeError(`${plugin}: ${label}.fileIds must be a string array`)
  }
  const fileIds = [...new Set((action.fileIds ?? []).map(fileId => fileId.trim()))]
  if (fileIds.length === 0 && (typeof action.intro !== 'string' || action.intro.trim().length === 0)) {
    throw new TypeError(`${plugin}: ${label} requires fileIds or a non-empty intro`)
  }
  if (action.intro !== undefined && (typeof action.intro !== 'string' || action.intro.trim().length === 0)) {
    throw new TypeError(`${plugin}: ${label}.intro must be a non-empty string`)
  }
  action.fileIds = fileIds
  return (_ctx, { on }) => on('agent/pre-step', async (_payload, next) => next())
}
