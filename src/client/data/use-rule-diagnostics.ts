import { useEffect, useState } from 'react'
import { countEnabledConfigs } from '../../shared/module-config-order.ts'
import { bridgeCall } from './bridge-client.ts'

/**
 * 状态栏的全仓只读摘要：一次 `/rule-diagnostics` 拿回
 * 「有条件因缺事实无法判定」的规则条数与已启用模块里的配置启用/总条数。
 * 工作台数据就绪后只读一次（不轮询）；读取失败按 0 处理——摘要读不到不该影响工作台。
 */
export function useRuleDiagnostics(enabled: boolean): { unavailableCount: number; configs: { enabled: number; total: number } } {
  const [summary, setSummary] = useState({ unavailableCount: 0, configs: { enabled: 0, total: 0 } })
  useEffect(() => {
    if (!enabled) return
    let active = true
    void bridgeCall('ruleDiagnostics').then((result) => {
      if (!active || result.ok !== true) return
      setSummary({
        unavailableCount: result.value.records.filter(record => record.unavailable > 0).length,
        configs: countEnabledConfigs(result.value.configs?.entries ?? []),
      })
    })
    return () => { active = false }
  }, [enabled])
  return summary
}
