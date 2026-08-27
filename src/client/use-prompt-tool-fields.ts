/** fields 订阅式选择器（L3 selector 化）：
 *  组件通过 useSyncExternalStore 订阅 store.fields 的引用变化，仅在所选切片
 *  变化时重渲染——配合 React.memo 组件，父级重渲染不再级联触发子组件。
 *  注意 selector 只在 fields 引用变化时执行一次，返回引用由组件 ref 缓存。
 */
import { useRef, useSyncExternalStore } from 'react'
import type { Fields } from './prompt-tool-bridge.ts'
import type { PromptToolStore } from './prompt-tool-store.ts'

export function usePromptToolFields<T>(store: PromptToolStore, selector: (fields: Fields) => T): T {
  const fields = useSyncExternalStore(store.subscribeFields, store.getFields, store.getFields)
  const cache = useRef<{ fields: Fields | undefined; value: T }>({ fields: undefined, value: undefined as unknown as T })
  if (cache.current.fields !== fields) {
    cache.current = { fields, value: selector(fields) }
  }
  return cache.current.value
}