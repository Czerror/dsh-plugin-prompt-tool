import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { getEngineMeta } from '../../engine/schema.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const browserPath = process.env.PROMPT_TOOL_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

test('真实CSS：层设置宽窄布局、键盘与就地错误，胶囊和鼠标过滤保持', { skip: !existsSync(browserPath), timeout: 30000 }, async () => {
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')))
  const { transform } = require('lightningcss'), ts = require('typescript')
  const css = []
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';
import {StatusBadge} from ${JSON.stringify(join(root, 'src/client/ui/StatusBadge.tsx').replaceAll('\\', '/'))};
import {MenuSelect} from ${JSON.stringify(join(root, 'src/client/ui/MenuSelect.tsx').replaceAll('\\', '/'))};
import ui from ${JSON.stringify(join(root, 'src/client/ui/controls.module.css').replaceAll('\\', '/'))};
import {PromptConfigForm} from ${JSON.stringify(join(root, 'src/client/features/prompts/PromptConfigForm.tsx').replaceAll('\\', '/'))};
import {LayerSettingsContent} from ${JSON.stringify(join(root, 'src/client/app/workspace/pages/EngineLayersPanel.tsx').replaceAll('\\', '/'))};
import {EMPTY_FIELDS} from ${JSON.stringify(join(root, 'src/client/data/prompt-tool-fields.ts').replaceAll('\\', '/'))};
import {createWorkspaceDrafts} from ${JSON.stringify(join(root, 'src/client/data/workspace-drafts.ts').replaceAll('\\', '/'))};
import {PROMPT_TOOL_DICTS} from ${JSON.stringify(join(root, 'src/client/locales.ts').replaceAll('\\', '/'))};
const t=(key,params={})=>Object.entries(params).reduce((text,[name,value])=>text.replaceAll('{'+name+'}',String(value)),PROMPT_TOOL_DICTS.zh[key]??key);
function Settings(){
 const [,render]=React.useReducer(n=>n+1,0);
 const store=React.useMemo(()=>({fields:{...EMPTY_FIELDS,presetTemplate:'layout',writePreset:true},moduleFacts:{sourceMode:'explicit',editable:true,declaredModules:['deliberation-gate','progress-reminder'],effectiveModules:['deliberation-gate','progress-reminder'],rowIds:[]},editorDrafts:createWorkspaceDrafts(),publishDrafts:()=>render(),patch:next=>{Object.assign(store.fields,next);render()},persistParamOverrides:async()=>{window.paramWrites=(window.paramWrites??0)+1},removeEngineCapability:async()=>true}),[]);
 window.settingsStore=store;
 return React.createElement('div',{'data-settings-host':true,style:{width:'860px',maxWidth:'100%'}},React.createElement(PromptConfigForm,{t,meta:window.layerMeta,config:{id:'layout-pipe',layer:'tool-pipeline',strategy:'static',text:'布局验收'},onPatch:()=>{},renderLayerSettings:(layer,config)=>React.createElement(LayerSettingsContent,{store,t,layer,configId:config.id,excludeCapabilities:['custom-tools','subagent-tool-policy']})}));
}
const names=['Anchored Standard(prompt-tool)','夏瑾 天琴座 Beta 2.42（SillyTavern 转换）'];
const cards=names.map((name,index)=>
React.createElement('article',{key:name,style:{width:'240px'},'data-card':index},React.createElement('div',{className:ui.presetCardHead},
React.createElement('strong',{className:ui.presetCardName},name),React.createElement(StatusBadge,{className:ui.presetHeadBadge,tone:'success',label:'使用中'}))));
function Filter(){const [value,setValue]=React.useState('all');return React.createElement(MenuSelect,{value,ariaLabel:'按层级或策略过滤',options:[{value:'all',label:'全部'},{value:'world-book',label:'世界书',group:'内容策略'},{value:'pre-step',label:'前置步骤',group:'插入点'},{value:'system-section',label:'系统提示段',group:'插入点'}],onChange:next=>{window.filterValue=next;setValue(next)}})}
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,...cards,
React.createElement('section',{className:ui.settingRowStack,hidden:true,'data-hidden-group':true},'隐藏参数组'),
React.createElement('section',{className:ui.pageActions,'data-sticky':true},'模块列表 / 保存配置',React.createElement(Filter)),React.createElement(Settings)));`
  const bundle = await rolldown({ input: 'badge-fixture', platform: 'browser', transform: { define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}', 'import.meta.env': '{}' } },
    plugins: [{ name: 'real-badge-css',
      resolveId(source, importer) {
        if (source === 'badge-fixture') return '\0badge-fixture.mjs'
        if (['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(source)) return require.resolve(source)
        if (source.endsWith('.css')) return '\0badge-css:' + (isAbsolute(source) ? source : source.startsWith('.') ? resolve(dirname(importer), source) : createRequire(importer).resolve(source)) + '.mjs'
      },
      load(id) {
        if (id === '\0badge-fixture.mjs') return entry
        if (id.startsWith('\0badge-css:')) {
          const path = id.slice('\0badge-css:'.length, -4)
          const result = transform({ filename: path, code: readFileSync(path), cssModules: path.endsWith('.module.css') ? { pattern: '[hash]_[local]' } : false })
          css.push(result.code.toString())
          return `export default ${JSON.stringify(Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name])))}`
        }
      },
      transform(code, id) { if (id.endsWith('.tsx')) return ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText },
    }],
  })
  let output
  try { ({ output } = await bundle.generate({ format: 'iife' })) } finally { await bundle.close() }
  const js = output.find((item) => item.type === 'chunk').code
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/app.js' ? js : `<!doctype html><meta charset="utf-8"><style>${css.join('\n')}:root{color-scheme:light;--dsw-alias-label-primary:light-dark(#20242a,#eef0f3);--dsw-alias-label-secondary:light-dark(#5d6571,#b2bac7);--dsw-alias-label-tertiary:light-dark(#7a8391,#909bad);--dsw-alias-bg-layer-2:light-dark(#fff,#20242b);--dsw-alias-bg-layer-3:light-dark(#f6f7f9,#272c34);--dsw-alias-border-l1:light-dark(#e9ecf0,#323a46);--dsw-alias-border-l2:light-dark(#d9dfe7,#414c5c);--dsw-alias-border-l3:light-dark(#a5afbd,#637086);--dsw-alias-brand-primary:#3572d6;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-bg-layer-1:light-dark(#fff,#20242b);--dsw-alias-state-business-primary:#3572d6;--dsw-alias-state-error-primary:#c63737;--dsw-font-xxs-12:400 12px/1.5 sans-serif;--dsw-font-xs-strong-13:600 13px/1.5 sans-serif;--dsw-font-s-14:400 14px/1.5 sans-serif;}body{font:12px/18px sans-serif;margin:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}article{margin-bottom:16px}strong{font:600 13px/20px sans-serif!important}</style><div id="root"></div><script>window.layerMeta=${JSON.stringify(getEngineMeta())}</script><script src="/app.js"></script>`)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const profile = mkdtempSync(join(tmpdir(), 'pt-badge-browser-'))
  const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  const exited = once(browser, 'exit')
  let ws
  try {
    let port
    for (let i = 0; i < 150 && !port; i++) {
      try { const value = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; if (/^\d+$/.test(value)) port = value } catch {}
      if (!port) await delay(50)
    }
    assert.ok(port, '隔离浏览器调试端口就绪')
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl)
    await once(ws, 'open')
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', ({ data }) => { const msg = JSON.parse(data); if (!msg.id) return; const item = pending.get(msg.id); pending.delete(msg.id); if (msg.error) item.reject(msg.error); else item.resolve(msg.result) })
    const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
    const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, returnByValue: true }); assert.equal(result.exceptionDetails, undefined); return result.result.value }
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
    for (let i = 0; i < 100 && !await evaluate('document.querySelectorAll("[data-card]").length===2'); i++) await delay(30)
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-hidden-group]')).display`), 'none', '参数组的布局样式不得覆盖搜索隐藏状态')
    for (const width of [240, 160]) for (const scale of [1, 2]) {
      const rows = await evaluate(`(()=>{document.querySelectorAll('[data-card]').forEach(e=>e.style.width=${width}+'px');return [...document.querySelectorAll('[data-card]')].map(card=>{const tag=card.querySelector('[data-tone=success]:last-child');tag.style.fontSize=${scale * 12}+'px';tag.style.lineHeight=${scale * 18}+'px';const title=card.querySelector('strong');title.style.setProperty('font-size',${scale * 13}+'px','important');title.style.setProperty('line-height',${scale * 20}+'px','important');const range=document.createRange();range.selectNodeContents(tag);return {lines:range.getClientRects().length,textWidth:range.getBoundingClientRect().width,width:tag.getBoundingClientRect().width,cardWidth:card.clientWidth,overflow:card.scrollWidth>card.clientWidth+1}})})()`)
      assert.equal(rows.length, 2)
      for (const row of rows) { assert.equal(row.lines, 1, JSON.stringify({ width, scale, row })); assert.equal(row.overflow, false); assert.ok(row.textWidth <= row.width) }
    }
    for (const scheme of ['light', 'dark']) for (const surface of ['transparent', 'rgb(80 100 140 / .12)', 'initial']) {
      const color = await evaluate(`(()=>{document.documentElement.style.colorScheme=${JSON.stringify(scheme)};const e=document.querySelector('[data-sticky]');e.style.setProperty('--dsw-alias-bg-base',${JSON.stringify(surface)});e.style.setProperty('--dsw-alias-bg-layer-2',${JSON.stringify(surface)});return getComputedStyle(e).backgroundColor})()`)
      assert.match(color, /^rgb\(/, `操作区基底必须不透明：${scheme}/${surface} → ${color}`)
    }
    const pointerClick = async (selector) => {
      await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight)e.scrollIntoView({block:'center'})})()`)
      await delay(40)
      const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
      await delay(80)
    }
    await evaluate(`window.trace=[];for(const name of ['pointerdown','mousedown','focusin','focusout','mouseup','click'])document.addEventListener(name,e=>window.trace.push([name,e.target.textContent?.slice(0,35),!!document.querySelector('[role=menu]')]),true)`)
    await pointerClick('[aria-label="按层级或策略过滤"]')
    assert.equal(await evaluate('!!document.querySelector("[role=menu]")'), true, '真实鼠标打开过滤菜单')
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.trim()==='系统提示段').dataset.targetFilter='true'`)
    await pointerClick('[data-target-filter="true"]')
    assert.equal(await evaluate('window.filterValue'), 'system-section', JSON.stringify(await evaluate('window.trace')))

    // 生产表单默认折叠；用键盘打开后才创建本层参数控件。
    assert.equal(await evaluate(`document.querySelector('[data-layer-settings-content]') === null`), true)
    await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false })
    await evaluate(`document.querySelector('[data-layer-settings="tool-pipeline"] summary').focus()`)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    for (let i = 0; i < 100 && !await evaluate(`!!document.querySelector('[data-layer-settings-content]')`); i++) await delay(30)
    assert.equal(await evaluate(`document.querySelector('[data-layer-settings="tool-pipeline"]').open`), true)
    for (const width of [860, 420, 320]) {
      await evaluate(`document.querySelector('[data-settings-host]').style.width='${width}px'`)
      await delay(40)
      const layout = await evaluate(`(()=>{const root=document.querySelector('[data-layer-settings-content]');const grid=root.querySelector('[data-layer-param-fields="deliberation-gate"]');const text=grid.querySelector('textarea').closest('[data-param-key]');return {width:root.getBoundingClientRect().width,overflow:root.scrollWidth>root.clientWidth+1,columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,textWidth:text.getBoundingClientRect().width,gridWidth:grid.getBoundingClientRect().width,groupWidths:[...root.querySelectorAll('[data-layer-param-group]')].map(e=>e.getBoundingClientRect().width)}})()`)
      assert.ok(layout.width >= width - 60, `设置内容占满外层网格：${JSON.stringify(layout)}`)
      assert.equal(layout.overflow, false, `无水平溢出：${width}`)
      assert.equal(layout.columns, width > 640 ? 2 : 1, `参数列数：${width}`)
      assert.ok(layout.textWidth >= layout.gridWidth - 2, `长文本占整行：${JSON.stringify(layout)}`)
      assert.ok(layout.groupWidths.every(value => value >= layout.width - 4), '每个分组占完整宽度')
      const pairs = await evaluate(`(()=>[...document.querySelectorAll('[data-param-pair]')].map(group=>[...group.querySelectorAll('[role="switch"]')].map(button=>{const r=button.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width}})))()`)
      assert.equal(pairs.length, 2, '深思门与节拍都沿用同一关联开关规则')
      for (const pair of pairs) {
        assert.equal(pair.length, 2)
        assert.ok(pair[1].x > pair[0].x + pair[0].width, `子代理开关位于右侧：${width}`)
        assert.ok(Math.abs(pair[0].y - pair[1].y) <= 1, `关联开关同一行：${width}`)
      }
    }
    await evaluate(`document.querySelector('[data-layer-param-group="deliberation-gate"]').hidden=true`)
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-layer-param-group="deliberation-gate"]')).display`), 'none')
    await evaluate(`document.querySelector('[data-layer-param-group="deliberation-gate"]').hidden=false`)
    const number = '#pt-param-layer-tool-pipeline-layout-pipe-deliberation-gate-deliberationMinChars'
    await evaluate(`document.querySelector('${number}').focus();document.querySelector('${number}').select()`)
    await send('Input.insertText', { text: '12a' })
    await evaluate(`document.querySelector('${number}').blur()`)
    await delay(40)
    assert.equal(await evaluate(`document.querySelector('${number}').getAttribute('aria-invalid')`), 'true')
    assert.equal(await evaluate(`!!document.getElementById(document.querySelector('${number}').getAttribute('aria-describedby'))?.textContent`), true)
    assert.equal(await evaluate('window.paramWrites??0'), 0, '非法数字只展示就地错误')
    await evaluate(`document.querySelector('${number}').focus();document.querySelector('${number}').select()`)
    await send('Input.insertText', { text: '120' })
    await evaluate(`document.querySelector('${number}').blur()`)
    await delay(40)
    assert.equal(await evaluate('window.paramWrites'), 1, '一次失焦仍只保存一次')
    const mainSwitch = '[data-param-key="cotDrip"] [role="switch"]'
    const childSwitch = '[data-param-key="cotDripSubagents"] [role="switch"]'
    await evaluate(`document.querySelector('${mainSwitch}').focus()`)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    assert.equal(await evaluate(`document.activeElement===document.querySelector('${childSwitch}')`), true, '键盘顺序与左右排列一致')
    const toggleWithSpace = async () => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
      await send('Input.dispatchKeyEvent', { type: 'char', text: ' ', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
      await delay(40)
    }
    await toggleWithSpace()
    assert.deepEqual(await evaluate('[window.settingsStore.fields.cotDrip,window.settingsStore.fields.cotDripSubagents,window.paramWrites]'), [false, true, 2], '子代理开关独立保存，不联动主开关')
    await evaluate(`document.querySelector('${mainSwitch}').focus()`)
    await toggleWithSpace()
    assert.deepEqual(await evaluate('[window.settingsStore.fields.cotDrip,window.settingsStore.fields.cotDripSubagents,window.paramWrites]'), [true, true, 3])
    if (process.env.PROMPT_TOOL_LAYER_SCREENSHOT) {
      await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false })
      await evaluate(`document.querySelector('[data-settings-host]').style.width='860px'`)
      for (const scheme of ['light', 'dark']) {
        await evaluate(`document.documentElement.style.colorScheme='${scheme}'`)
        await delay(40)
        const clip = await evaluate(`(()=>{const r=document.querySelector('[data-layer-settings-content]').getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height,scale:1}})()`)
        const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip })
        writeFileSync(process.env.PROMPT_TOOL_LAYER_SCREENSHOT + '-' + scheme + '.png', Buffer.from(image.data, 'base64'))
      }
    }
  } finally {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 0, method: 'Browser.close' }))
    await Promise.race([exited, delay(2000)])
    if (browser.exitCode === null) browser.kill()
    await exited
    ws?.close(); server.close()
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
