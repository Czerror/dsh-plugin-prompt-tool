import { useEffect } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PromptConfigsEditor } from './PromptConfigsEditor.tsx'
import { usePromptToolStore, type PromptToolSettingsTransport } from './prompt-tool-store.ts'
import styles from './PromptUi.module.css'

export interface PromptSettingsPageInjected {
  api: IApiClient
  settings: PromptToolSettingsTransport
}

export type PromptSettingsPageProps = PropsRuntime<'settings.section'> & InjectFace<PromptSettingsPageInjected>

/** 主设置页：只保留「提示词配置」区块（含目录导入）。 */
export function PromptSettingsPage(props: PromptSettingsPageProps): ReactNode {
  const { api, settings } = props
  const store = usePromptToolStore(api, settings)

  useEffect(() => {
    void store.load()
    // load 引用稳定（内部依赖均为稳定 useCallback），实际只执行一次。
  }, [store.load])

  return (
    <div className={styles.pageShell}>
      {store.loading && <p className={styles.loading} role="status">正在读取提示词配置…</p>}
      {!store.loading && (
        <PromptConfigsEditor
          api={api}
          meta={store.meta}
          configs={store.fields.promptConfigs}
          configsDir={store.fields.promptConfigsDir}
          savedConfigs={store.savedConfigs}
          savedConfigsDir={store.savedConfigsDir}
          onPatchConfigs={(configs) => store.patch({ promptConfigs: configs })}
          onPatchConfigsDir={(dir) => store.patch({ promptConfigsDir: dir })}
          onSaveConfigs={(configs) => store.persistConfigs(configs)}
          onSaveConfigsDir={(dir) => store.persistConfigsDir(dir)}
          onReload={store.load}
          onNotice={store.showNotice}
        />
      )}
      {store.notice && <p className={clsx(styles.notice, store.noticeKind === 'error' && styles.noticeError)} role="status">{store.notice}</p>}
    </div>
  )
}
