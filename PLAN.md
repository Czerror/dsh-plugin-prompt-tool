# ab2c5e1–21e8761 审查发现全量修复（F01–F15）

## 1. 需求与授权

- 日期：2026-09-17。基线：`dev@21e876106220c298b3236fa6bd955a7379204cb4`，开始时工作树干净。
- 用户已明确要求“全量修复”，授权实施上一轮报告全部 15 项有效发现、必要行为回归、文档同步、中文 Conventional Commit 和推送 `origin/dev`。
- 上一轮报告：`D:/AI/workspase/_temp/review-ab2c5e1-to-21e8761-20260917.md`；本方案以以下 F01–F15 表为可移植的范围记录，不依赖临时报告才能验收。
- 旧 PLAN 已原文归档为 `.scratch/prompt-tool-framework/archive/plan-subagent-policy-ui-21e8761-20260917.md`，Git blob 与基线 PLAN 同为 `b895ae1244c6f889331c6a487a8251cde7915db7`。
- 本轮保持插件边界：不改宿主，不操作用户预设数据，不停止或重启现有 DSH。验证采用隔离 cwd、DSH_HOME、浏览器 profile 与随机端口。

## 2. 修复方案与验收

| ID | 问题 | 修复方向 | 确定性验收 |
|---|---|---|---|
| F01 | 目录预设包逐文件提交丢资源 | 预设包整包预览/提交，角色卡批次独立排队 | 两文件请求保持一个提交；实际 bridge 保留正文和附件；多 JSON 合并 |
| F02 | 权限标签首次失焦不保存 | 子字段提交后读取最新草稿保存 | 输入黑名单后直接离开卡片，新标签确实进入请求 |
| F03 | 旧保存响应清除新草稿 | 草稿与提交快照对应，只确认已提交版本；串行处理离焦期间待存修改 | 延迟旧响应期间继续编辑，最新草稿最终保存；失败仍可重试 |
| F04 | 重启策略写空工具档 | 复用共享可用策略骨架 | off/on 后默认工具非空，策略通过校验 |
| F05 | 子代理筛选状态断链 | 受控值与回调完整透传 | 切到 system-section 后 pre-step 卡不可见且选择值正确 |
| F06 | 工具管线隐藏能力卡 | 让能力卡自身按层过滤 | tool-pipeline 中策略卡可见，其他层正确隐藏 |
| F07 | 新建卡定位信号断链 | 页面创建 ID 传给列表，删除无入口重复 picker | 新卡展开并定位，筛选与搜索不被改写 |
| F08 | 在途重预览取消无效 | 取消失效请求与当前文件，忽略迟到结果 | 延迟换组响应后取消不恢复卡、不提交，后续导入可用 |
| F09 | 延迟递归漏层 | 有界循环同时计入条目与层级推进 | 延迟 0/1/2/3 四条全部选中，无无限循环 |
| F10 | 空宏副键绕过条件 | 保留源副键约束及未命中语义 | AND_ANY/AND_ALL 未赋值副键不匹配，否定逻辑和正常宏保持语义 |
| F11 | 世界书诊断混入普通配置 | commit 只记录选中世界书 | static + lore 的快照仅记录 lore 的 committed |
| F12 | 隐式策略运行但 UI 隐藏 | 保留历史已有策略授权，如实暴露运行事实，显式创建可补齐声明 | 有段无模块的运行/UI事实一致；补模块幂等且不覆盖策略；删除真正停用 |
| F13 | ENOENT 文本误判降级 | 只依据文件读取错误 code 判断缺失 | 缺文件可降级；现存无效 ENOENT 档名仍抛错，不解除限制 |
| F14 | 展示截断污染计数和告警 | 全量计数/去重告警与展示数组分离 | 600 条降级计数 600，200 info 后 warning 仍统计与持久化 |
| F15 | 删除保留代码的上游版权声明 | 上游 MIT 声明迁入随包发布的 engine 目录 | 原文版权/许可保留，包文件清单与物化包含声明 |

F12 兼容取舍：旧 PLAN 记录“已有段但模块未声明继续工作”，本轮不通过静默关闭历史策略来修复显示问题。正常能力仍以显式 modules 为准；历史策略实际隐式装配需被 UI 如实呈现，并能补齐声明。关闭开关仍只删段、保留卡片；删除能力同时删除段与模块。

## 3. 影响面与依赖证据

| 责任点 | 调用方/消费方 | 回归范围 |
|---|---|---|
| useImportPreviewFlow | PresetSwitcher、CharactersPage、ImportPreviewCard → importPresetPackage/charactersImport | client 浏览器、host 导入契约 |
| SubagentToolPolicyCard | 两页 EngineModuleCards 插槽 → bridge → preset.yml → 策略编译器 | 浏览器失焦/并发、host 保存、引擎授权 |
| SubagentPage/ConfigListWithTemplates | PromptConfigList、useTemplatePicker、EngineModuleCards | 真实组件筛选、创建、只读边界 |
| selectStWorldBook | executor.runPreStepBatch → coordinator 或独立引擎 → bridge 诊断 | engine + host 主/子会话、epoch、disposer 既有回归 |
| resolvePresetModuleFacts/isEngineCapabilityPresent | bootstrap、创建/移除、renderComposition、writePreset | host 能力事实、物化、参数与保存 |
| convertStToPresetWithReport | convertStToPreset、角色导入、预设包合并、stWarnings | host 转换/报告/合并与完整测试 |
| engine 许可 | package.json files 中的 engine、writePreset 引擎目录物化 | 文件包含检查、build |

已用 `rg` 复核上述调用关系。dev-expert 图谱脚本固定输出 `.ai-memory/knowledge-graph` 且无输出覆盖参数，与仓库“图谱不放 .ai-memory”边界冲突；本轮使用已验证的实际调用链和 rg 局部依赖替代，不运行该生成器。

## 4. 任务拆解与执行

### Wave 1：最小修复与定向回归（五组写区互斥）

```xml
<task type="auto">
  <name>T1 导入与子代理列表 F01/F05/F06/F07/F08</name>
  <files>src/client/data/use-import-preview-flow.ts; features/presets/PresetSwitcher.tsx; features/characters/CharactersPage.tsx（仅必要调用适配）; app/workspace/pages/{SubagentPage,ConfigListWithTemplates}.tsx; test/client/import-preview-browser.test.mjs; test/client/scope-create-separation.test.mjs; 对应新增浏览器测试</files>
  <action>复用既有流程与列表组件；以整包为导入单元，正确失效取消请求，接通受控筛选与创建信号。</action>
  <verify>先重现既有反例；新增真实 React/浏览器行为断言；从隔离 cwd 运行对应 client 测试。</verify>
  <security>取消和迟到响应不得产生额外写入；保留摘要/版本校验、预设身份与只读限制。</security>
  <done>五项反例转绿，角色卡批次语义和筛选不被创建动作改写。</done>
</task>
<task type="auto">
  <name>T2 策略编辑保存 F02/F03/F04</name>
  <files>src/client/features/subagents/SubagentToolPolicyCard.tsx; subagent-policy-draft.ts（必要时）; test/client/subagent-policy-browser.test.mjs 及独占夹具</files>
  <action>最新草稿保存、版本确认/待存队列、复用共享骨架；保持单开关与失焦自动保存。</action>
  <verify>真实 DOM 首次标签失焦、保存中二次编辑、失败重试、关闭再打开、切预设/卸载隔离。</verify>
  <security>权限黑白名单必须实际落盘；旧请求不覆盖新预设；禁止把失败显示成成功。</security>
  <done>三个反例转绿，无并发覆盖或未提交草稿被标干净。</done>
</task>
<task type="auto">
  <name>T3 世界书与策略读取 F09/F10/F11/F13</name>
  <files>engine/st-world-book.mjs; engine/subagent-tool-policy.mjs; test/engine/{st-world-book,subagent-tool-policy-degrade}.test.mjs</files>
  <action>修正层级推进预算、副键空值语义、commit 范围与 ENOENT 判定。</action>
  <verify>四项最小反例转绿；正常触发、否定条件、概率/时窗、缺文件与损坏文件回归。</verify>
  <security>损坏策略必须 fail loud；未赋值副键不得放宽匹配条件；循环仍有界。</security>
  <done>四项行为修复且相关 engine 测试通过。</done>
</task>
<task type="auto">
  <name>T4 历史策略事实一致 F12</name>
  <files>src/host/manifest.ts; src/shared/engine-capabilities.ts; 必要的 test/host 能力事实/保存/物化测试</files>
  <action>历史段隐式装配在实际模块事实中可见；创建补齐显式声明，移除删除数据。</action>
  <verify>显式模块、历史半状态、关闭段、删除能力、幂等及策略内容不被覆盖。</verify>
  <security>保留已有授权限制；不能因展示修复让历史策略失效，也不能误装配其他 dormant 配置。</security>
  <done>界面存在性、组合运行和写盘事实一致。</done>
</task>
<task type="auto">
  <name>T5 转换报告与许可 F14/F15</name>
  <files>src/host/sillytavern.ts; test/host/st-preview-report.test.mjs; engine/THIRD_PARTY_LICENSES; README.md</files>
  <action>在生成点累积全量分类和去重告警，仅截断展示；恢复保留代码对应的上游 MIT 声明。</action>
  <verify>600 条分类、诊断越限后 warning、合并计数；原文许可及包/物化包含检查。</verify>
  <security>报告不参与授权，不执行宏；许可修复不恢复已删除的上游运行预设。</security>
  <done>摘要及 stWarnings 完整，许可随移植引擎分发。</done>
</task>
```

### Wave 2：集成验证与交付（依赖 Wave 1 全部完成）

```xml
<task type="auto">
  <name>T6 集成、规范同步与审查</name>
  <files>docs/{SillyTavern,ui-architecture,architecture-params,engine-reuse}.md; CHANGELOG.md; PLAN.md; 必要测试调整</files>
  <action>主线程复核每组 diff/反例，同步稳定行为及相关旧文档矛盾；运行完整门禁与 OCR 委托复审。</action>
  <verify>pnpm typecheck/lint/test/build，git diff --check；最终源码与回归匹配；已知浏览器清理 EPERM 若复现则修复本轮测试生命周期。</verify>
  <security>全部测试在 _temp 与临时 DSH_HOME；不接管现有 DSH 端口；生成物按脚本处理。</security>
  <done>15 项验收有证据，完整门禁通过，复审无未修复阻塞问题。</done>
</task>
<task type="auto">
  <name>T7 记录、提交、推送</name>
  <files>PLAN.md; .ai-memory/20260917/daily.md（仅本地）；本轮修改文件</files>
  <action>更新 Wave 状态并追加项目记忆，仅暂存本轮文件，创建中文 Conventional Commit，推送 origin/dev。</action>
  <verify>检查 staged diff、提交 SHA、远端 dev 对应提交与最终工作树。</verify>
  <security>不提交 .ai-memory、临时 profile、凭证或 lib；不切换/推送 main。</security>
  <done>本地提交与 origin/dev 一致，交付验证结果与生效步骤。</done>
</task>
```

## 5. 验证与回滚

- 验证命令全部从 `D:/AI/workspase/_temp` 启动，`TEMP/TMP` 指向该目录。子代理只运行定向测试；共享 lib 由主线程统一 build 后运行完整 test。
- 必跑：`pnpm --dir $Repo typecheck`、`pnpm --dir $Repo lint`、`pnpm --dir $Repo test`、`pnpm --dir $Repo build`、`git -C $Repo diff --check`。
- 仓库记录及已有用户文件均保留；每组修复可独立反向补丁或经授权 revert，不使用 reset/clean 覆盖历史。
- 生效：客户端刷新；运行时引擎需通过既有重建链物化，现有 DSH 的模块缓存需要用户重启服务后生效。本轮不会操作该服务。
- 停止条件：F01–F15 均有验证、完整门禁通过、复审结束、提交并推送 origin/dev。

## 6. 阶段证据与复核

- T1：五项目标浏览器反例修前均红；修复后与角色逐卡对照、取消继续队列、在途卸载、只读边界及旧导入流程共 26/26 通过。实际宿主附件写盘和多 JSON 合并由完整测试中的 preset-package-import/st-preview-report 契约覆盖。
- T2：策略浏览器修复前 7 个子场景中 6 个失败；修复后 7/7 通过。主线程连同能力卡渲染测试重跑 20/20 通过，覆盖首标签失焦、保存中编辑/再次失焦、失败重试、共享骨架及切预设/卸载。
- T3：四个新增回归先红后绿；引擎组 8 文件 133/133 通过，主线程再次定向重跑 F09/F10/F11/F13 为 4/4。保留单层延迟无递归驱动时不激活的既有 T16 契约。
- T4/T5：历史策略事实及报告截断回归先红（能力隐藏、500≠600），修复后与既有报告用例 4/4 通过；独立复核另外覆盖四种策略状态及 600 unsupported/warning 的全量计数。
- F15：上游 MIT 原文包含检查通过；`package.json#files` 包含 engine，实际 writePreset 物化后的声明与源文件一致（1/1 通过）。
- 生产变更保持在既有模块内，没有新增依赖；新增测试使用现有 Node test runner 和已安装浏览器。
- 完整门禁（主线程、隔离 cwd）：`pnpm --dir $Repo typecheck`、`lint`、`build` 均退出 0；`pnpm --dir $Repo test` **986/986 通过、0 失败、0 跳过**（含构建），`git diff --check` 退出 0。新增 23 条计入 Node 总数的测试。
- 已确认的浏览器清理 EPERM 同时收口：新旧导入测试使用 Browser.close → 等待自身子进程退出 → 清理独占 profile；完整测试未再失败。
- OCR 复审：workspace preview 共 33 文件，23 reviewable、10 excluded；23/23 逐文件按 rule 检查，另人工检查 8 份文档/归档和 2 份夹具，合计 reviewed=33、skipped=0、coverage=100%。主线程复跑各组反例并检查全部最终 diff；独立代理复核宿主、报告及客户端异步边界，没有新的未修复阻塞发现。
- 未执行：真实用户 DSH 服务重启、真实预设重物化，由用户决定生效时机；所有行为验证均在隔离环境完成。图谱按本计划第 3 节降级为实际调用链核查。

## 7. Wave 与任务完成状态

`[✔]` 表示完成且验证通过；`[ ]` 表示未完成。

- [✔] 前置：确认用户全量修复授权；旧 PLAN 原文归档并核对 Git blob。
- [✔] Wave 1：修复与定向验证。
  - [✔] T1：F01/F05/F06/F07/F08。
  - [✔] T2：F02/F03/F04。
  - [✔] T3：F09/F10/F11/F13。
  - [✔] T4：F12。
  - [✔] T5：F14/F15。
- [ ] Wave 2：集成验证与交付。
  - [✔] T6：文档、完整门禁、OCR 复审。
  - [ ] T7：项目记忆、中文提交、推送 origin/dev。
