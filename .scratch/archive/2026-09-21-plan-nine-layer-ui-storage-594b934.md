# 九层配置卡与参数存储重设计

## 需求与授权

- 2026-09-21 用户要求按真实配置卡内嵌设置的思路重设计九层 UI，使用 ui-skills、dev-expert，详细核对官方各插入点参数，并评估后端整合。
- 追加明确选择：连参数存储结构一并重新设计；同层共享引擎参数，规则参数独立；用户随后要求本轮完成后由代理运行一次性离线脚本迁移全部可写预设，不留日常显式迁移工具。禁止运行时自动迁移或旧格式双读。
- 基线 594b934；验证完成后迁移 DSH_HOME/.agent-presets 下全部可写预设；不启动/重启/停止在役 DSH。
- 新格式：`layerSettings.<injection-layer>.<engine-param-key>` 保存共享参数，归属由既有 ENGINE_PARAM_DEFINITIONS.card → ENGINE_EDITOR_GROUP_MAP.displayLayer 派生。`promptConfigs[].params` 仍是实例参数；persona、variables、customTools、subagentToolPolicy 与 moduleConfigs 保留其独立所有者。没有实例时不派生 UI 卡。
- 用户已通过互动提问确认上述新格式；追加授权子代理结束时向主会话注入指定文本。`subagent-end.params.action` 区分 `observe`（缺省）与 `inject-main`（显式启用），不把事件返回值冒充注入通道。
- 用户追加：根 preset.yml 全参数模板也对照重建。使用 Document API 从71键参数目录、九层契约和真实模板生成，保留独立重建命令与覆盖回归。

## 审查结论

- 官方源码 ddefc45fbc 与已安装包同为 0.1.6-alpha.2，九层 API 一致；插件层能力矩阵不是官方事件字段表。
- P1：策略支持层未下发；subject 可选择当前 hook 不具备的载荷；身份字段允许引擎已拒绝的 kind；切层只清 subject/match，残留其他不支持字段会导致保存失败。
- P1：局部 params 类型和枚举校验过宽；实际保存端未调用既有提示词权威校验，非法配置可能先写盘。
- P2：请求层/观察层仍显示无效正文、变量与消息来源表单；统一大表单没有表达九层实际动作差异。
- 新存储需求是用户主动选择，并非修 UI 的必要前提；保持运行时平铺参数适配面，避免将各写端点和模块工厂一起重写。
- 待核查：runtime-context 动态 provider 返回 Promise，与官方同步 text 契约不符。本轮记录证据，不未经行为复现声称已修复。

## 影响面、依赖与护栏

- 引擎 schema → /meta、/bootstrap → PromptConfigForm、StrategyParamsFields → 实际保存校验。
- 新存储适配 → manifest 读写、能力创建/删除、writer 与导入导出；运行时 EngineParams 字段保持，文件格式显式迁移。
- 主线程：UI 表单、策略控件、CSS、中英词条、客户端行为测试、官方对照文档、PLAN、最终集成。
- 子代理 A：engine/schema 与契约/保存入口、对应 engine/shared/host 定向测试；不写 manifest、UI 表单。
- 子代理 B：新存储适配与迁移工具、manifest、包内预设、对应存储回归与必要测试夹具；不写 schema、runtime/settings-bridge 或 UI 表单。
- 主线程补齐：src/host/characters.ts、src/host/import-source.ts、src/host/preset-package.ts、src/host/sillytavern.ts 及相关集成回归，确保所有生产读写链都消费新格式。离线脚本保留于 scripts，不作为日常产品工具发布，主线程负责实际用户预设迁移。
- 官方契约只读代理提供九层证据；主线程实现子代理结束事件到主会话的注入行为、独立引擎回归与结束层模板。
- 图谱工具固定将生成物写入 .ai-memory/knowledge-graph，与仓库 .ai-memory 只允许修改记忆的硬约束冲突；按技能降级条款使用 rg 精确复核读写依赖，不生成图谱。
- 使用 ui-skills baseline-ui / refactoring-ui / fixing-accessibility，复用 DSH primitive、CSS Modules、语义 token，无新 UI 依赖。
- 对照资料使用已安装官方类型与本地同版本文档；不修改宿主源码，不默认扩展官方 hook 能力，不改变晋升、次数、受众与 epoch。
- 保留用户未跟踪 skills/；只暂存任务文件，本地 .ai-memory 不提交。

## Wave 1：契约、存储与迁移

<task type="auto">
  <name>T1：统一九层编辑与保存契约</name>
  <files>engine/schema.mjs、src/shared/bridge-contract.ts、src/client/prompt-tool-types.ts、src/runtime/settings-bridge.ts、src/runtime/configs-validate.ts、对应 engine/shared/host 测试</files>
  <action>下发各层支持策略、匹配对象、正文/变量/元数据与局部字段契约；实际保存复用权威校验，拒绝明确无效的类型与枚举。</action>
  <verify>错误配置保存不写盘；合法九层模板校验与执行保持；/meta 与 /bootstrap 同源、复制引擎独立可用。</verify>
  <security>沿用 Host/Origin、白名单、请求体上限和只读守卫；不执行用户脚本验证配置。</security>
  <done>新增反例先红后绿，主线程复核关键契约。</done>
</task>

<task type="auto">
  <name>T2：按层保存共享参数并执行一次性离线迁移</name>
  <files>manifest、新存储 helper、scripts/migrate-layer-settings.mjs、包内 preset.yml、存储与迁移测试</files>
  <action>登记键从 layerSettings 读取/写入，旧位置登记键明确提示迁移；工具支持默认预览、显式写入、冲突拒绝、备份与受保护恢复。未知字段、注释、false/0 保真。</action>
  <verify>新格式往返、清空删键、能力隐含装配和完整移除、混合冲突、幂等、迁移失败原字节不变、恢复冲突拒绝、writer 行为等价。</verify>
  <security>按用户追加授权迁移所有可写预设；原子写盘，备份不混入导出资产，不覆盖未知改动，不重启在役服务。</security>
  <done>包内预设使用新格式，迁移工具与回归通过，无自动迁移或旧参数双读。</done>
</task>

## Wave 2：九层表单与可访问 UI

<task type="auto">
  <name>T5：子代理结束后向主会话注入文本</name>
  <files>engine/layers.mjs、子代理结束层模板、独立 engine 回归</files>
  <action>通过公开的 Agent/session 血缘定位主会话，以 Agent.inject 投递模型上下文；默认只观察，显式动作启用投递；记录 runId 去重，作用域与 disposer 释放。</action>
  <verify>主会话投递目标、文本、条件、次数；嵌套子代理、无可用主会话、重复结束事件与卸载不误投递；保持 observe 默认与现有启动层行为。</verify>
  <security>只向该子代理所属的真实主会话投递，不跨会话猜测，不自动唤醒或重启宿主。</security>
  <done>独立行为回归通过，UI 与文档明确官方事件观察和插件追加注入的区别。</done>
</task>

<task type="auto">
  <name>T3：真实配置卡按实际行为组织控件</name>
  <files>PromptConfigForm.tsx、PromptConfigFields.tsx、prompt-config-policy.ts、prompts.module.css、locales-prompts.ts、客户端回归</files>
  <action>保留实例卡与折叠；卡内统一基本信息、触发/范围、层动作与内容、共享设置、高级元数据。只显示本层可消费字段，请求层结构化编辑官方请求字段，观察层只显示条件和说明；共享参数有明确作用域提示。</action>
  <verify>九层真实渲染矩阵；策略/subject 下拉；换层后可校验；未知数据不因隐藏丢失；真实浏览器宽窄布局、键盘、错误与保存；空层不补卡。</verify>
  <security>保持指令文件授权、版本与原文件写入边界；不添加任意 JSON 到宿主请求的无校验旁路。</security>
  <done>所有九层可解释、可编辑、无假入口，未增加独立设置卡。</done>
</task>

## Wave 3：对照文档与完整验收

<task type="auto">
  <name>T4：官方支持参数对照、完整门禁与交付</name>
  <files>docs/ui-architecture.md、docs/architecture-params.md、九层官方对照文档、PLAN 与回归</files>
  <action>记录各官方输入/输出、插件映射与不支持项，新存储及迁移命令；最终主线程验证，归档提交推送。</action>
  <verify>typecheck、lint、test、build、diff --check，UI 截图与恢复测试；核对路径/链接/命令。</verify>
  <security>测试使用隔离 cwd、临时 DSH_HOME、随机端口，清理本轮现场，不改变在役服务。</security>
  <done>完整证据、已知边界、提交 SHA、origin/dev 推送结果齐全。</done>
</task>

## 回滚与检查点

- 代码 git revert；真实预设迁移有原始字节备份与前后摘要，可通过离线脚本受保护恢复，恢复后按回滚版本重新物化。
- 每 Wave 更新本 PLAN 状态，任务交接只留 PLAN，不放入 .ai-memory。

## 状态

- [✔] Wave 1 / T1：九层元数据与实际保存同源校验，非法保存不改盘。
- [✔] Wave 1 / T2：存储适配、全部生产读写链、一次性离线迁移完成。
- [✔] Wave 2 / T3：九层 UI、矩阵与浏览器交互通过，空层不补卡。
- [✔] Wave 2 / T5：结束事件向根主会话投递，默认观察、条件、次数、血缘与 disposer 回归通过。
- [✔] Wave 3 / T4：官方对照文档、71键全参数模板、完整门禁完成，随代码归档提交；推送回执见交付。

## 验收记录

- `pnpm --dir <repo> typecheck`、`lint`、`test`、`build` 退出码0；最终全量 1273/1273，0失败、0跳过；`git -C <repo> diff --check` 通过。
- 九层渲染矩阵、所有目标层切换后引擎接受、实际保存非法值拒绝且原字节不变、结束动作真实浏览器保存、参数共享与实例独立均覆盖。
- 真实 Edge 明暗主题截图已读取复核；860/420/320宽度无溢出，键盘展开、错误定位、只读与原始草稿回归通过。最终截图不进入版本库。
- 根 preset.yml 从权威目录生成：71共享键、9层、15默认关闭示例；参数值、层归属、规则合法性及组合物化验证通过，`rebuild:preset-template -- --check` 无漂移。
- 官方逐层资料：同版本安装包类型 + ddefc45fbc 官方文档，稳定对照存于 docs/injection-point-contracts.md。
- 真实用户迁移：8个预设扫描/核验，pt-cordis/pt-minimal/pt-ptc各迁11键，pt-standard迁1键，共34键；beta-2-42/custom/liangshen/pt-custom保持原字节。规则数分别128/0/0/0/1/0/0/4，迁移前后相等。
- 迁移备份：上述4个预设目录各保留 `.layer-settings-backup.json`，原始字节及前后SHA校验通过；后续预览全部unchanged。
- `node scripts/rematerialize-presets.mjs --dsh-home <DSH_HOME>`：8个扫描，7个物化，手写 liangshen 跳过，0失败；再次确认4个迁移定义的SHA仍等于备份afterHash。
- `<repo>` 为 D:/AI/GitHub/dsh-plugin-prompt-tool；脚本/测试 cwd 为 D:/AI/workspase/_temp，测试设置临时 DSH_HOME 和随机端口。

## 实施取舍与已知边界

- 依照用户最后指令撤下日常迁移入口，不发布迁移 CLI；保留一次性离线脚本与恢复能力。没有启动/读取/保存时自动迁移或旧参数双读。
- 运行时 EngineParams 和 bridge 保持平铺适配面，磁盘按层组织；不将共享值复制到单条规则，不迁移 persona/变量/工具/策略各自所有权。
- 子代理结束注入使用公开血缘和 Agent.inject；无法确认根会话或主会话不存活时跳过，不唤醒driver。投递账本按会话有界保留最近运行。
- 已确认的既有 runtime-context 异步provider与官方同步text契约不一致，本轮只记录，未扩展到该运行时修复；不声称此项已修复。子代理启动同样不承诺赶上已领取输入的首个请求。
- 图谱工具落位违反仓库.ai-memory边界，已按技能降级条款使用rg复核依赖。refactoring-ui的附加diagnose资源未由MCP提供，已使用主技能完整规则。
- 新客户端/引擎和生成产物已就绪；在役DSH没有停止或重启，需要用户重启DSH后加载新版运行时代码。

## 测试现场与清理限制

- 测试helper清理隔离目录、DSH_HOME与浏览器profile。主线程清理本轮截图和迁移核验临时脚本；真实迁移的4份备份按恢复用途保留。
- 既有未跟踪 skills/ 与历史临时目录未改；.ai-memory仅追加本地修改记忆，不暂存。
