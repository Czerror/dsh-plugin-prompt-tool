import { useEffect, useState } from 'react'
import { bridgeCall } from './bridge-client.ts'

/**
 * 状态栏用的规则判定摘要：回「有条件因缺事实无法判定」的规则条数。
 * 工作台数据就绪后只读一次（不轮询）；读取失败按 0 处理——诊断读不到不该影响工作台。
 */
export function useUnavailableRuleCount(enabled: boolean): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let active = true
    void bridgeCall('ruleDiagnostics').then((result) => {
      if (!active || result.ok !== true) return
      setCount(result.value.records.filter(record => record.unavailable > 0).length)
    })
    return () => { active = false }
  }, [enabled])
  return count
}
