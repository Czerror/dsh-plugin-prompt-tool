/**
 * 导入预览流程（预设包与角色卡 JSON 共用）：
 * 读取/预览请求 → 等待确认 → 提交 → 成功/失败。
 *
 * 不变量：
 *   - 等待确认时按钮可用，只有提交阶段才禁用（busy 不覆盖整个导入期）；
 *   - 同一份预览只完成一次，连点确认最多一次提交；
 *   - 换文件、换顺序组、目标变化都让旧 ready 失效：重新预览成功前没有可确认的状态；
 *   - 迟到的预览响应按请求序号丢弃，不覆盖更新的状态；
 *   - 提交失败保留文件与预览（再次确认即重试，取消才跳过该文件）；
 *   - 卸载结束等待，不悬挂 Promise，也不继续写下一个文件。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { StConversionReport, StOrderGroupCandidate } from '../../shared/bridge-contract.ts'
import type { ImportOrderCandidates, ImportPreviewState } from '../prompt-tool-types.ts'

export type ImportFlowPhase = 'idle' | 'reading' | 'confirming' | 'submitting'

/** 预览结果：ready 才有凭据；candidates 只表示"先选顺序组"，不宣称已转换。 */
export type ImportPreviewOutcome =
  | { kind: 'ready'; sourceDigest?: string; previewRevision?: string; report?: StConversionReport }
  | { kind: 'candidates'; candidates: StOrderGroupCandidate[]; sourceName?: string }
  | { kind: 'error'; message: string; stale?: boolean }

export interface ImportCommitResult {
  ok: boolean
  stale?: boolean
  message?: string
  /** 成功时的展示信息（端点自定义，如导入后的 id / 角色名）。 */
  label?: string
}

export interface ImportFlowHandlers {
  /** 只读预览（带顺序组时服务端按该组转换并重新计算版本）。 */
  preview: (files: Array<{ path: string; content: string }>, orderCharacterId?: string) => Promise<ImportPreviewOutcome>
  /** 提交：服务端重算版本，不符返回 stale（要求重新预览）。 */
  commit: (preview: ImportPreviewState) => Promise<ImportCommitResult>
  /** 提交成功后的刷新。 */
  onCommitted?: (label?: string) => Promise<void> | void
  /** 失败提示（页面注入 store.showNotice）。 */
  onError: (message: string, stale: boolean) => void
}

type Decision = { kind: 'confirm' } | { kind: 'cancel' } | { kind: 'group'; characterId: string }

export interface ImportPreviewFlow {
  phase: ImportFlowPhase
  /** 有值且 phase !== 'submitting' 时可确认。 */
  preview?: ImportPreviewState
  /** 顺序组候选：确认不可用，用户选组后立即重新预览。 */
  candidates?: ImportOrderCandidates
  /** 跑完一批文件（内部串行，取消只跳过当前文件）。 */
  run: (files: Array<{ path: string; content: string }>) => Promise<void>
  /** 选择顺序组：失效旧 ready 并发起同源预览。 */
  chooseGroup: (characterId: string) => void
  confirm: () => void
  cancel: () => void
}

export function useImportPreviewFlow(handlers: ImportFlowHandlers): ImportPreviewFlow {
  const [phase, setPhase] = useState<ImportFlowPhase>('idle')
  const [preview, setPreview] = useState<ImportPreviewState | undefined>(undefined)
  const [candidates, setCandidates] = useState<ImportOrderCandidates | undefined>(undefined)
  const decisionRef = useRef<((decision: Decision) => void) | undefined>(undefined)
  // 队列互斥用同步标记：两个 onFiles 落在同一 tick 时 state 尚未提交，
  // 只靠 phase 会让第二条队列覆盖 resolver。
  const runningRef = useRef(false)
  const aliveRef = useRef(true)
  const seqRef = useRef(0)
  /** 重预览期间用户改选的顺序组：在途响应返回后立即按它重新预览，旧响应作废。 */
  const pendingGroupRef = useRef<string | undefined>(undefined)
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  useEffect(() => () => {
    aliveRef.current = false
    const resolve = decisionRef.current
    decisionRef.current = undefined
    resolve?.({ kind: 'cancel' })
  }, [])

  const waitDecision = (): Promise<Decision> =>
    new Promise((resolve) => {
      const pending = decisionRef.current
      decisionRef.current = resolve
      // 正常串行下不会有第二个等待；防御性结束上一个，避免悬挂。
      pending?.({ kind: 'cancel' })
    })

  /** 结束当前等待；同一份预览只完成一次（重复点击/迟到调用不生效）。
   *  换组不清空卡片：重预览期间旧 ready 仍在屏幕上，但确认已被置为不可用。 */
  const settle = useCallback((decision: Decision): void => {
    const resolve = decisionRef.current
    if (resolve === undefined) return
    decisionRef.current = undefined
    if (decision.kind !== 'group') {
      setPreview(undefined)
      setCandidates(undefined)
    }
    resolve(decision)
  }, [])

  const run = useCallback(async (files: Array<{ path: string; content: string }>): Promise<void> => {
    if (files.length === 0 || runningRef.current) return
    runningRef.current = true
    const api = (): ImportFlowHandlers => handlersRef.current
    try {
      for (const file of files) {
        if (!aliveRef.current) return
        let order: string | undefined
        let repreview = false
        pendingGroupRef.current = undefined
        // 同一文件换组重预览：保留卡片（内容仍是这一份输入），只把确认置为不可用；
        // 换文件时才清空旧预览，避免把上一个文件的报告留在屏幕上。
        let keepPreview = false
        // 每个文件：预览 → （候选/ready）→ 确认 → 提交；取消或过期即跳过该文件。
        for (;;) {
          setPhase('reading')
          if (!keepPreview) {
            setPreview(undefined)
            setCandidates(undefined)
          }
          keepPreview = false
          const seq = ++seqRef.current
          const outcome = await api().preview([file], order)
          // 重预览期间用户又改了顺序组：丢弃这次响应，立刻按最新选择重新预览。
          if (pendingGroupRef.current !== undefined) {
            order = pendingGroupRef.current
            pendingGroupRef.current = undefined
            keepPreview = true
            continue
          }
          // 乱序响应与卸载后的响应都不得恢复旧状态。
          if (!aliveRef.current || seq !== seqRef.current) return
          if (outcome.kind === 'error') {
            api().onError(outcome.message, outcome.stale === true)
            break
          }
          if (outcome.kind === 'candidates') {
            setPhase('confirming')
            setPreview(undefined)
            setCandidates({
              ...(outcome.sourceName === undefined ? {} : { sourceName: outcome.sourceName }),
              candidates: outcome.candidates,
            })
            const decision = await waitDecision()
            if (!aliveRef.current) return
            if (decision.kind === 'group') {
              order = decision.characterId
              keepPreview = true
              continue
            }
            break
          }
          const state: ImportPreviewState = {
            files: [file],
            sourceDigest: outcome.sourceDigest ?? '',
            ...(outcome.previewRevision === undefined ? {} : { previewRevision: outcome.previewRevision }),
            ...(outcome.report === undefined ? {} : { report: outcome.report }),
            ...(order === undefined ? {} : { groupCharacterId: order }),
          }
          setPhase('confirming')
          setCandidates(undefined)
          setPreview(state)
          const decision = await waitDecision()
          if (!aliveRef.current) return
          if (decision.kind === 'group') {
            order = decision.characterId
            keepPreview = true
            continue
          }
          if (decision.kind === 'cancel') break
          let committed = false
          let commitLabel: string | undefined
          let retryState = state
          for (;;) {
            setPhase('submitting')
            setPreview(undefined)
            const result = await api().commit(retryState)
            if (!aliveRef.current) return
            if (result.ok) {
              committed = true
              commitLabel = result.label
              break
            }
            api().onError(result.message ?? '', result.stale === true)
            if (result.stale === true) break
            // 非过期失败：保留文件与预览，等待用户再次确认（重试）或取消。
            setPhase('confirming')
            setPreview(retryState)
            const retry = await waitDecision()
            if (!aliveRef.current) return
            if (retry.kind === 'cancel') break
            if (retry.kind === 'group') {
              order = retry.characterId
              repreview = true
              break
            }
          }
          if (committed) {
            await api().onCommitted?.(commitLabel)
            break
          }
          if (repreview) {
            repreview = false
            keepPreview = true
            continue
          }
          break
        }
      }
    } finally {
      runningRef.current = false
      if (aliveRef.current) {
        setPhase('idle')
        setPreview(undefined)
        setCandidates(undefined)
      }
    }
  }, [])

  const chooseGroup = useCallback((characterId: string): void => {
    // 重预览进行中（没有等待者）：记下新选择，等在途响应返回后按它重新预览。
    if (decisionRef.current === undefined) {
      pendingGroupRef.current = characterId
      return
    }
    settle({ kind: 'group', characterId })
  }, [settle])
  const confirm = useCallback((): void => { settle({ kind: 'confirm' }) }, [settle])
  const cancel = useCallback((): void => { settle({ kind: 'cancel' }) }, [settle])

  return { phase, preview, candidates, run, chooseGroup, confirm, cancel }
}
