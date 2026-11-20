import type { ReactNode } from 'react'
import css from './edge-flow.module.css'

export function EdgeFlow({ path }: { path: string }): ReactNode {
  return <g aria-hidden="true" className={css.streak} style={{ offsetPath: `path("${path}")` }}>
    <ellipse cx="-6" rx="7" ry="2.4" opacity=".45" />
    <circle r="3.2" />
    <circle r="1.5" fill="white" />
  </g>
}
