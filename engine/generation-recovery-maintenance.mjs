/** 维护窗口与范围选择归上下文runtime，这里只决定是否允许扩大范围。 */
export async function recoveryMaintenance(runtime, signal, allowFullFallback, valid, report) {
  if (!runtime) { report('context runtime unavailable; recovery stopped'); return null }
  let result
  try {
    result = await runtime.compactRecovery(signal)
  } catch (error) {
    if (!valid() || error?.name === 'AbortError' || error?.code === 'ABORTED') return null
    if (!allowFullFallback) { report(`regional maintenance failed; recovery stopped (${String(error?.message ?? error)})`); return null }
    result = await runtime.compactNow(signal)
  }
  if (!valid()) return null
  if (result === null || !Array.isArray(result?.shadowedSeqs) || result.shadowedSeqs.length === 0) {
    report('maintenance no-op; recovery stopped')
    return null
  }
  return result
}
