import { useEffect, useRef } from 'react'

export function useAutosave(identity: string, save: () => void, delay = 600) {
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const composing = useRef(false)
  const latest = useRef(save)
  latest.current = save
  const cancel = (): void => { clearTimeout(timer.current); timer.current = undefined }
  const flush = (): void => { cancel(); if (!composing.current) latest.current() }
  const schedule = (): void => { cancel(); if (!composing.current) timer.current = setTimeout(flush, delay) }
  useEffect(() => { composing.current = false; return cancel }, [identity])
  return { schedule, cancel, flush, onCompositionStart: () => { composing.current = true; cancel() }, onCompositionEnd: () => { composing.current = false; schedule() } }
}
