import { useEffect, useState } from 'react'
import { countEnabledConfigs } from '../../shared/module-config-order.ts'
import { bridgeCall } from './bridge-client.ts'
import type { RuleDiagnosticRecord } from '../../shared/bridge-contract.ts'
import { beginLatest, isLatest } from './resource-track.ts'

/**
 * 状态栏的全仓只读摘要：一次 `/rule-diagnostics` 拿回
 * 「有条件因缺事实无法判定」的规则条数与已启用模块里的配置启用/总条数。
 * 数据就绪和版本变化时重读，打开工作台期间每两秒刷新真实运行观测；
 * 否则启停模块后计数会停在旧值。读取失败按 0 处理——摘要读不到不该影响工作台。
 */
export function useRuleDiagnostics(enabled: boolean, revision = ''): { unavailableCount: number; configs: { enabled: number; total: number }; records: RuleDiagnosticRecord[] } {
  const [summary, setSummary] = useState<{ unavailableCount: number; configs: { enabled: number; total: number }; records: RuleDiagnosticRecord[] }>({ unavailableCount: 0, configs: { enabled: 0, total: 0 }, records: [] })
  useEffect(() => {
    if (!enabled) return
    let active = true
    const latest = { latest: 0 }
    const read = (): void => { const sequence = beginLatest(latest); void bridgeCall('ruleDiagnostics').then((result) => {
      if (!active || !isLatest(latest, sequence) || result.ok !== true) return
      setSummary({
        unavailableCount: result.value.records.filter(record => record.unavailable > 0).length,
        configs: countEnabledConfigs(result.value.configs?.entries ?? []),
        records: result.value.records,
      })
    }) }
    read()
    const timer = setInterval(read, 2000)
    return () => { active = false; clearInterval(timer) }
  }, [enabled, revision])
  return summary
}
