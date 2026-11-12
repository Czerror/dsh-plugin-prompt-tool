import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RewindRequest } from '../../../shared/rewind.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { Button } from '../../ui/Button.tsx'
import { Menu } from '../../ui/Menu.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { bridgeCall } from '../../data/bridge-client.ts'
import { rewindConversation, RewindSubmissionError } from '../../data/rewind.ts'
import type { RewindRecoveryOwner } from '../../data/rewind.ts'

type Props = PropsRuntime<'conversation.input.right'> & { translate: PromptToolTranslate; ensureView: (id: string) => void; recovery: RewindRecoveryOwner }

export function RewindButton({ sessionId, inputActions, useInput, translate: t, ensureView, recovery }: Props) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const saved = useSyncExternalStore(recovery.subscribe, () => recovery.get(sessionId), () => recovery.get(sessionId))
  const { notice = '', text, retry } = saved ?? {}
  const [viewError, setViewError] = useState('')
  const mounted = useRef(true), pending = useRef(false)
  const state = useInput((value: InputState) => value)
  const latest = useRef({ sessionId, state }); latest.current = { sessionId, state }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setOpen(false) }, [sessionId])
  useEffect(() => {
    try { ensureView(sessionId); setViewError('') }
    catch (error) { setViewError(error instanceof Error ? error.message : String(error)) }
  }, [sessionId, ensureView])
  const credential = (globalThis as typeof globalThis & { __PROMPT_TOOL_REWIND__?: string }).__PROMPT_TOOL_REWIND__
  const disabled = busy || !credential || !!viewError || state.phase !== 'plain'
  const run = async (mode: 'once' | 'round', retryRequest?: RewindRequest): Promise<void> => {
    if (pending.current || disabled || !credential) return
    pending.current = true; setBusy(true); setOpen(false)
    recovery.set(sessionId, retryRequest ? { ...saved, notice: '' } : { notice: '' })
    const initial = state
    try {
      ensureView(sessionId)
      const outcome = await rewindConversation({ sessionId, mode, credential, input: inputActions, retry: retryRequest, restoredMarkers: recovery.restored,
        canRestore: () => mounted.current && latest.current.sessionId === sessionId && initial.draft === '' && initial.occurrences.length === 0 && initial.attachmentIds.length === 0 && latest.current.state.draftRev === initial.draftRev,
      }, request => bridgeCall('rewind', request))
      const failed = outcome.result.targets.filter(target => target.status === 'failed')
      recovery.set(sessionId, { retry: outcome.retry, text: outcome.restored ? undefined : outcome.text ?? recovery.get(sessionId)?.text,
        notice: outcome.restoreError ? `${t('rewind.restoreFailed')} ${outcome.restoreError}` : failed.length
          ? outcome.result.targets.map(target => `${target.sessionId}: ${target.status === 'committed' ? t('rewind.done') : target.message}`).join('\n') : t('rewind.done') })
    } catch (error) {
      recovery.set(sessionId, { text: recovery.get(sessionId)?.text, notice: error instanceof Error ? error.message : String(error),
        retry: error instanceof RewindSubmissionError ? error.request : retryRequest })
    }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  return <span>
    <HintTooltip label={viewError || (!credential ? t('rewind.unavailable') : t('rewind.label'))}>
      <span><Menu open={open} onClose={() => setOpen(false)} compact align="end"
        items={[{ id: 'once', label: t('rewind.once'), disabled }, { id: 'round', label: t('rewind.round'), disabled }]}
        onSelect={mode => { if (mode === 'once' || mode === 'round') void run(mode) }}
        anchor={<Button icon disabled={disabled} aria-label={t('rewind.label')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>↶</Button>} />
      </span>
    </HintTooltip>
    {notice && <span role="status">{notice}</span>}
    {retry && <Button disabled={disabled} onClick={() => void run(retry.mode, retry)}>{t(retry.phase === 'retry' ? 'rewind.retry' : 'rewind.retryRequest')}</Button>}
    {text !== undefined && <details><summary>{t('rewind.recover')}</summary><textarea readOnly value={text} aria-label={t('rewind.recover')} /></details>}
  </span>
}
