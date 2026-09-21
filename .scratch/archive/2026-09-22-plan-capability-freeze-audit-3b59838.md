# 引擎装配、能力操作与预设切换检查

## 需求与授权

- 基线 3b59838，dev；用户已有未跟踪 skills/ 保留。
- 用户要求检查 UI 自动配装与移除导致的卡死；补充：浏览器无响应、DSH 终端正常，phase-control 与 phase-control-ptc 都触发过，创建组合后切换预设尤为明显。
- 用户提出跨预设共享参数及执行引擎未装配两种假设，随后明确选择“修复这两处并继续验证”。追加要求：“跨预设共享参数 功能应该移除,先求证是那次提交加入的”。
- 历史求证后，用户明确确认删除“预设模型参数自动回写宿主全局默认模型”，保留官方当前会话手动选择；再次确认按实际规则/请求参数补齐执行引擎和现有队列串行。

## 审查结论

1. **P1，已确认装配缺口**：本机 pt-custom 的 preset.yml 有 1 条提示词规则、modules 为 []，生成 agent.cordis.yml 为 `[]`。引擎能力目录不含 prompt-config-engine；impliedModulesForParams 只按登记参数的 card 与 moduleConfigs 补能力，不因 promptConfigs 或模型请求参数补执行引擎。因此可有真实规则但没有消费者。此事实能证明规则不执行，尚不能证明浏览器卡死。
2. **P1，已确认并发缺口**：src/client/data/use-prompt-tool-store.ts:989/1001 的能力创建/移除绕过 presetSaveQueue；957 行切换只等待该队列。EngineParamFields 的失焦参数保存进入队列，因而能力写与参数写、能力创建与切换可并发。隔离浏览器已观察到 capabilityPending=true 时预设已变为目标；延迟请求后由模拟真实 guard 的 409 拒绝。真实后端 guardPresetIdentity 会重新检查当前目录，不应把该竞态直接称为跨预设参数串写。
3. **P2，已确认测试盲区**：test/fixtures/module-workbench.mjs 对 engine-capability 的 remove 也执行 modules.add，且没有 api.switchPreset、bootstrap 固定 test；现有组合创建 smoke 不覆盖实际移除和切换链。
4. **尚未确认卡死根因**：纯前端隔离浏览器中，128 条规则下三个 recipe 的串行创建→切换往返在约 60–80ms 完成；移除→切换完成，JS 心跳继续、无 Runtime.exceptionThrown。没有复现浏览器线程卡死，不据此否认用户现场。宿主真实重挂与页面现场尚未覆盖。
5. **参数隔离核查**：layerSettings 写各预设自己的 preset.yml；.engine 是共享代码，无跨预设参数存储。本机 8 个预设声明/有效模块/生成引擎行只读比对完成，出现的引擎路径均存在。UI moduleFacts 是配置推导，不是宿主成功挂载的证明。
6. **次要观察**：storeRef.current 每次渲染仍被赋新对象，和“稳定引用”注释不符；可能放大重渲染，但未发现自行触发更新的闭环，不将其冒充卡死根因或擅自扩大修复。
7. **历史求证与仍在运行的跨预设影响**：51ba4f5（2026-08-22）把旧全局 settings 参数迁移复制到全部插件预设；27dd2f1（2026-09-14）删除运行时迁移，6bb4b56 删除离线旧迁移。73e2093（2026-08-21）加入 installDefaultModelRoute，把预设 modelProvider/modelName 写入全局 agentDefaultModel.saveSelection，当前仍在。隔离探针证实 A 固定路由回写全局后，B 未配置路由继续继承 A 的全局值。8b231b2 的 layerSettings 是单预设内按层共享，不是跨预设存储。

## 影响面、依赖与护栏

- 装配：shared/engine-capabilities → host/manifest → writePreset → agent.cordis.yml；提示词实际消费为 engine/prompt-config-engine。
- UI：EngineParamFields/EngineCapabilityCreateMenu/LayerCapabilityRow → use-prompt-tool-store → bridge；预设切换另经 api.switchPreset 与全局 settings 队列。
- UI 子代理只读核查。主线程复核结论后完成全部修改、回归、构建与交付；本机同步仅通过现有 rematerialize-presets 更新生成物。
- 编辑只用 apply_patch；shell 使用 pwsh 7；测试及临时脚本 cwd 仅 D:/AI/workspase/_temp。禁止停止在役服务、修改宿主源码。

## Wave 1：检查与复现

<task type="auto">
  <name>T1：追踪能力与参数装配</name>
  <files>src/shared/engine-capabilities.ts；src/host/manifest.ts；src/host/write-preset.ts；engine 与本机预设生成目录</files>
  <action>核对实际声明、生成行、文件存在与运行依赖，记录缺口。</action>
  <verify>本机 8 预设只读比对；能力/bridge/晋升/默认同步定向回归。</verify>
  <security>只读，不输出凭证；不修改本机预设。</security>
  <done>已确认事实与未确认根因分别记录。</done>
</task>

<task type="auto">
  <name>T2：隔离浏览器复现能力与切换交错</name>
  <files>src/client 读取；_temp/pt-mount-audit-3b59838 临时探针</files>
  <action>真实 React + Edge、内存 HTTP 替身，测试三个组合、移除、切换及延迟能力请求，记录 JS 心跳/异常。</action>
  <verify>串行无卡死；延迟能力请求尚未完成即能切换，返回冲突时 UI 心跳继续。</verify>
  <security>随机本地端口、独立 browser profile；测试只终止自己创建的浏览器。</security>
  <done>探针证据已取得，临时目录完成后清理。</done>
</task>

## Wave 2：最小修复

<task type="auto">
  <name>T3：实际提示词与请求参数需要时补齐执行引擎</name>
  <files>src/host/manifest.ts；src/shared/engine-capabilities.ts（如需）；test/host/preset-capabilities.test.mjs 等最小回归</files>
  <action>使显式模块预设中的真实规则与生成请求规则有 prompt-config-engine 消费者；复用同一 effectiveModules 推导，空预设继续空装配。</action>
  <verify>先红后绿：空模块+真实规则、模型请求参数、移除其他能力后执行引擎保留；空预设不补模块。</verify>
  <security>只派生当前预设必要模块，不跨预设写参数，不覆盖手写组合。</security>
  <done>生成行、moduleFacts 与运行消费一致。</done>
</task>

<task type="auto">
  <name>T4：能力增删与预设切换统一串行</name>
  <files>src/client/data/use-prompt-tool-store.ts；test/fixtures/module-workbench.mjs；test/client/module-policy-smoke.test.mjs</files>
  <action>复用现有预设保存队列，能力操作快照绑定预设；切换等待已入队操作，失败不阻塞后续；补真实 remove/switch fixture。</action>
  <verify>延迟组合创建时不能提前切预设；移除不能被旧参数重新装回；原浏览器场景通过且心跳继续。</verify>
  <security>旧预设快照不得写到新预设，保留 expectedPresetId 和错误反馈。</security>
  <done>队列竞态反例转绿，实际增删/切换有行为覆盖。</done>
</task>

<task type="auto">
  <name>T5：移除预设参数自动写入宿主全局默认模型</name>
  <files>src/index.ts；src/runtime/models.ts；相关桥接/客户端提示/模型测试</files>
  <action>删除 installDefaultModelRoute 隐式全局回写及其桥接载荷/客户端提示/无用直接依赖；主模型 provider/model 由当前预设生成的 agent-request 规则消费，显式会话模型选择继续使用官方接口。</action>
  <verify>预设保存/能力操作不调用全局 saveSelection；A/B 独立路由不串；类型、lint、完整测试与构建通过。</verify>
  <security>不改用户已经保存的宿主默认模型，不猜测其历史原值，不迁移或清空其他预设。</security>
  <done>当前预设参数不再隐式改写全局模型选择。</done>
</task>

## 回滚与检查点

- 检查阶段未修改生产代码或预设，无数据回滚；所有发现只写本 PLAN。
- 修复已授权，修改先补真实失败回归；代码回滚使用 git revert；不做新数据迁移。

## 状态

- [✔] Wave 1 / T1：调用链与本机装配核查完成。
- [✔] Wave 1 / T2：隔离浏览器复现并发窗口；浏览器卡死尚未复现。
- [✔] Wave 2 / T3：必要执行引擎推导完成，空预设、手写组合与显式运行参数边界通过。
- [✔] Wave 2 / T4：能力操作加入既有队列，切换等待、参数保存与移除先后顺序、失败恢复及真实 remove fixture 通过。
- [✔] Wave 2 / T5：隐式全局模型回写删除，主模型仅在自身请求生效；1274 项完整测试及 typecheck/lint/build/diff-check 通过。

## 验收记录

- 隔离脚本 probe.mjs：128 张规则卡；phase-control 79ms、phase-control-ptc 70ms、deliberation 63ms（一次探针，非性能基准）；移除切换后心跳从 0 增至 29，无浏览器 Runtime 异常。
- 延迟能力请求：预设已从 other 切为 test，capabilityPending 仍为 true；释放后返回 false/“当前预设已切换”，心跳继续。
- 既有 preset-capabilities、preset-default-sync、settings-bridge、promotion-gate、module-policy-smoke 定向测试退出 0；后两项不等同于现场端到端卡死验收。
- 子代理的静态结论已由主线程回读核对；其定向测试不单独作为交付门禁。
- 红灯证据：preset-capabilities 的规则消费者测试得到 effectiveModules=[]；preset-default-sync 的 A 模型启动测试捕获到全局 saveSelection；Edge 延迟组合创建测试观察到请求未完成时 presetSwitches=['other']。三个反例修后均转绿。
- 模型请求行为：A 的 provider/model/temperature 只覆盖 A 的主会话请求；空 B 与子代理继承各自输入，不携带 A 的覆盖；不完整 provider/model 对不生成请求规则。
- 首次完整测试发现 4 个失败：3 个 writer 旧调用省略 promptConfigs，被新 length 读取拒绝；1 个已删除功能留下无消费者直接依赖。已恢复可选列表兼容，移除 devDependency 及过期依赖断言，通过离线 pnpm install --lockfile-only --offline --ignore-scripts 更新 lockfile。
- 最终 pnpm --dir D:/AI/GitHub/dsh-plugin-prompt-tool typecheck、lint、test、build 和 git diff --check 均退出 0；test 1274/1274、0失败0跳过。数量减少源于撤销已删除全局同步功能的旧测试，并新增装配/全局零写入/队列行为测试。
- 生成契约 RENDER_VERSION 升至 5。已运行 node scripts/rematerialize-presets.mjs --dsh-home 'D:/AI/DeepSeek harness/.dsh'：8 扫描、7 物化、手写 liangshen 跳过、0失败。pt-custom 的 agent.cordis.yml 现在包含 prompt-config-engine，configsDir 指向自身目录。
- 8 份 preset.yml、4 份既有迁移备份与宿主 settings.yaml 的同步前后 SHA256 完全一致；只更新生成产物。

## 实施取舍与已知边界

- 没有把规则未装配或并发窗口直接等同于浏览器卡死；精确根因仍需实际宿主装配/浏览器现场证据。
- 没有引入跨预设参数共享；没有为潜在优化改动 store、订阅框架或组件布局。
- 既有官方手动 session.selectModel 语义保持；不还原或猜测用户此前的全局默认模型。原现场浏览器卡死未在隔离环境完整复现，不能将已确认回写缺陷直接认定为其唯一根因。
- 新版 host/client bundle 需要用户重启 DSH 服务并刷新页面生效。在役服务未停止或重启。

## 测试现场与清理限制

- 临时 probe.mjs 已用内置编辑器删除，空 pt-mount-audit-3b59838 目录路径核实后清理；临时 Edge profile、隔离 DSH_HOME 由各探针/测试清理。
- 保留本机迁移备份与用户未跟踪 skills/；.ai-memory 仅本地追加，不提交。
