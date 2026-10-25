import type { ReactNode } from 'react'
import { Button } from './Button.tsx'

export interface PublicationView {
  pending: boolean
  error?: string
}

/** 已写盘、运行发布未完成的统一提示；重试只重建，不重写。 */
export function PublicationNotice(props: {
  publication?: PublicationView
  onRetry?: () => void
  pendingLabel: string
  retryLabel: string
  disabled?: boolean
  className?: string
}): ReactNode {
  const { publication, onRetry, pendingLabel, retryLabel, disabled, className } = props
  if (publication === undefined || !publication.pending) return null
  return <p role="alert" className={className}>
    {publication.error ?? pendingLabel}
    {onRetry !== undefined && <Button variant="outline" shape="pill" size="sm" disabled={disabled} onClick={() => onRetry()}>{retryLabel}</Button>}
  </p>
}
