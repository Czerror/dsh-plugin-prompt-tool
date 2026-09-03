import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('客户端装配层不自建 root 或观察宿主 DOM（官方 slot + body portal）', () => {
  for (const file of [
    'src/client/index.ts',
    'src/client/app/workbench/register-workbench.tsx',
    'src/client/app/workbench/WorkbenchOverlay.tsx',
    'src/client/app/workbench/SidebarGeometryProbe.tsx',
    'src/client/app/workbench/FloatingTrigger.tsx',
  ]) {
    const source = read(file)
    assert.ok(!source.includes('MutationObserver'), `${file} 不应观察宿主 DOM`)
    assert.ok(!source.includes('createRoot'), `${file} 不应自建 React root`)
    assert.ok(!source.includes('[class*='), `${file} 不应包含宿主 CSS 类选择器`)
    assert.ok(!source.includes('[data-pane='), `${file} 不应包含宿主 data-pane 选择器`)
    assert.ok(!source.includes('centerCol'), `${file} 不应依赖宿主中央列结构`)
    assert.ok(!source.includes('logoRow'), `${file} 不应依赖宿主侧边栏结构`)
  }

  const css = [read('src/client/app/workspace/PromptWorkspace.module.css'), read('src/client/app/workbench/Workbench.module.css')].join('\\n')
  assert.ok(!css.includes('data-dsh-prompt-tool-active'), 'CSS 不应依赖宿主 html active 属性')
  assert.ok(!css.includes('centerCol'), 'CSS 不应依赖宿主中央列结构')
  assert.ok(!css.includes('data-dsh-workspace-slot'), 'CSS 不应探测官方 workspace DOM 槽位')
})

test('角色卡导入按 PNG 魔数与载荷大小分流', () => {
  const page = read('src/client/features/characters/CharactersPage.tsx')
  const client = read('src/client/data/bridge-client.ts')
  const transport = read('src/client/data/bridge-transport.ts')
  assert.match(page, /isPngSignature/)
  assert.match(page, /bridgeUpload\(file, file\.name\)/)
  assert.match(page, /\.jpg,\.jpeg/)
  assert.match(client, /BRIDGE_ENDPOINTS\.charactersImportStream/)
  assert.match(transport, /export async function uploadBridge/)
  assert.match(transport, /export function shouldStreamJsonFile/)
})
