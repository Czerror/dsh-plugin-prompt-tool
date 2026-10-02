import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { configIdentityKey, type ModuleConfigOrderEntry, type ModuleConfigOrderSnapshot } from '../../../shared/module-config-order.ts'
import { bridgeCall, errorMessage } from '../../data/bridge-client.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { CollapsibleCard } from '../../ui/CollapsibleCard.tsx'
import { moveToView } from '../../data/prompt-config-order.ts'
import ui from '../../ui/controls.module.css'

const sameScope = (a: ModuleConfigOrderEntry, b: ModuleConfigOrderEntry): boolean => a.layer === b.layer && a.position === b.position && a.order === b.order

/** 已启用模块的配置身份排序；编辑正文继续由各模块配置卡负责。 */
export function ModuleConfigOrderCard({ store, t }: { store: PromptToolStore; t: PromptToolTranslate }): ReactNode {
  const [snapshot, setSnapshot] = useState<ModuleConfigOrderSnapshot>()
  const [entries, setEntries] = useState<ModuleConfigOrderEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dragId, setDragId] = useState<string>()
  const [drop, setDrop] = useState<{ id: string; before: boolean }>()
  const busyRef = useRef(false)
  const dirty = snapshot !== undefined && entries !== snapshot.entries

  const refresh = useCallback(async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const result = await bridgeCall('moduleConfigOrder')
      if (!result.ok) throw new Error(result.message ?? t('moduleOrder.unavailable'))
      setSnapshot(result.value)
      setEntries(result.value.entries)
      setError('')
    } catch (cause) {
      setError(t('moduleOrder.readFailed', { reason: errorMessage(cause) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [t])

  // 模块启停成功会走既有 store.load() 并更新列表；错误草稿不被后台刷新覆盖。
  useEffect(() => {
    if (!dirty) void refresh()
  }, [store.meta.presets, dirty, refresh])

  const save = async (next: ModuleConfigOrderEntry[]): Promise<void> => {
    if (busyRef.current || snapshot === undefined) return
    busyRef.current = true
    setBusy(true)
    setEntries(next)
    setError('')
    try {
      const result = await bridgeCall('moduleConfigOrder', {
        expectedRevision: snapshot.revision,
        entries: next.map(({ moduleId, configId }) => ({ moduleId, configId })),
      })
      if (!result.ok) throw new Error(result.message ?? t('moduleOrder.unavailable'))
      setSnapshot(result.value)
      setEntries(result.value.entries)
    } catch (cause) {
      setError(t('moduleOrder.saveFailed', { reason: errorMessage(cause) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const move = (sourceId: string, targetId: string, before: boolean): void => {
    if (busyRef.current || sourceId === targetId) return
    const source = entries.find((entry) => configIdentityKey(entry) === sourceId)
    const target = entries.find((entry) => configIdentityKey(entry) === targetId)
    if (source === undefined || target === undefined || !sameScope(source, target)) return
    const cards = entries.map((entry) => ({ id: configIdentityKey(entry), layer: entry.layer, order: entry.sequence }))
    const visibleIds = entries.filter((entry) => sameScope(entry, source)).map(configIdentityKey)
    const next = moveToView(cards, sourceId, targetId, before, source.layer, undefined, undefined, visibleIds)
    if (next === cards) return
    const byId = new Map(entries.map((entry) => [configIdentityKey(entry), entry]))
    void save(next.map((card) => ({ ...byId.get(card.id)!, sequence: card.order ?? 0 })))
  }

  const moduleNames = new Map((store.meta.presets ?? []).map((entry) => [entry.id, entry.name]))
  const groups = new Map<string, ModuleConfigOrderEntry[]>()
  for (const entry of entries) {
    const scope = JSON.stringify([entry.layer, entry.position, entry.order])
    const group = groups.get(scope) ?? []
    group.push(entry)
    groups.set(scope, group)
  }
  const dragged = entries.find((entry) => configIdentityKey(entry) === dragId)
  const disabled = busy || snapshot === undefined

  return <CollapsibleCard id="pt-module-config-order" title={t('moduleOrder.title')} meta={t('moduleOrder.hint')}>
    <div className={ui.listFilterRow}>
      <button type="button" className={ui.pillButton} disabled={busy} onClick={() => { void refresh() }}>
        {t(dirty ? 'moduleOrder.discardRefresh' : 'moduleOrder.refresh')}
      </button>
    </div>
    {(error || busy) && <p className={error ? ui.noticeError : ui.configFieldHint} role={error ? 'alert' : 'status'} aria-live="polite">
      {error || t('app.loading')}
    </p>}
    {entries.length === 0 && !busy && <p className={ui.configFieldHint}>{t('moduleOrder.empty')}</p>}
    {[...groups].map(([scope, group]) => <section key={scope} aria-label={`${group[0]!.layer} / ${group[0]!.position}`}>
      <h3 className={ui.configSectionTitle}>{group[0]!.layer} · {group[0]!.position}{group[0]!.order === undefined ? '' : ` · ${group[0]!.order}`}</h3>
      <div className={ui.skillCardList} role="list">
        {group.map((entry, index) => {
          const key = configIdentityKey(entry)
          const up = group[index - 1]
          const down = group[index + 1]
          return <div key={key} className={ui.skillCard} role="listitem"
            data-module-id={entry.moduleId} data-config-id={entry.configId}
            data-dragging={dragId === key ? '' : undefined}
            data-drop-before={drop?.id === key && drop.before ? '' : undefined}
            data-drop-after={drop?.id === key && !drop.before ? '' : undefined}
            onDragOver={(event) => {
              if (disabled || dragged === undefined || dragId === key || !sameScope(dragged, entry)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              const rect = event.currentTarget.getBoundingClientRect()
              setDrop({ id: key, before: event.clientY < rect.top + rect.height / 2 })
            }}
            onDrop={(event) => {
              event.preventDefault()
              if (dragId !== undefined && drop?.id === key) move(dragId, key, drop.before)
              setDragId(undefined)
              setDrop(undefined)
            }}>
            <button type="button" className={ui.dragHandle} draggable={!disabled} disabled={disabled}
              aria-label={t('moduleOrder.drag', { name: entry.name })}
              onDragStart={(event) => { setDragId(key); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', key) }}
              onDragEnd={() => { setDragId(undefined); setDrop(undefined) }}
              onKeyDown={(event) => {
                const target = event.key === 'ArrowUp' ? up : event.key === 'ArrowDown' ? down : undefined
                if (target === undefined) return
                event.preventDefault()
                move(key, configIdentityKey(target), event.key === 'ArrowUp')
              }}>⋮⋮</button>
            <span className={ui.skillCardBody}>
              <strong className={ui.configName}>{entry.name}</strong>
              <span className={ui.configMeta}>{moduleNames.get(entry.moduleId) ?? entry.moduleId} · {entry.moduleId} / {entry.configId}</span>
              {!entry.enabled && <span className={ui.configMeta}>{t('moduleOrder.disabled')}</span>}
            </span>
            <span className={ui.dirCardActions}>
              <button type="button" className={ui.pillButton} disabled={disabled || up === undefined}
                aria-label={`${t('card.moveUp')} ${entry.name}`} onClick={() => { if (up) move(key, configIdentityKey(up), true) }}>{t('card.moveUp')}</button>
              <button type="button" className={ui.pillButton} disabled={disabled || down === undefined}
                aria-label={`${t('card.moveDown')} ${entry.name}`} onClick={() => { if (down) move(key, configIdentityKey(down), false) }}>{t('card.moveDown')}</button>
            </span>
          </div>
        })}
      </div>
    </section>)}
  </CollapsibleCard>
}
