# 引擎设置并入注入层实例卡 PLAN

## 需求与授权

- 日期：2026-09-20；起始基线：`dev / 7d78e77`（上一轮 G1—G7 补齐完成后的 HEAD）。
- 用户原始诉求（沿用 [归档 PLAN](../../.scratch/archive/2026-09-20-plan-engine-reuse-a7c80bc.md) 补录的原话）：`本项目已经 对齐官方9个注入层,可否 统一前端和后端可编辑引擎参数 设置到 9个注入层 模块卡片中,不在把引擎设置分散在各处`。
- 本轮起因（用户原话）：`为何引擎的设置参数 在前端中 还是独立的卡片`。
- 已确认的范围与取舍（用户在本轮互动提问中的选择）：
  1. 能力装配与移除入口：**彻底取消独立能力卡**，装配状态与移除入口并入层设置区。
  2. 引擎设置的落点：**嵌进每张提示词配置实例卡内部**的折叠区（每张该层实例卡都有，默认折叠）；任一处修改同步同一份值。
  3. 没有对应参数的层：**不创建**层设置容器；有参数而该层没有实例卡时，用不写盘的兜底容器承载。
  4. 提示词配置实例卡本身保持现状：多实例、平铺、排序/拖拽/批量启停/搜索语义不变。
- 已授权：上述范围内的前端重构、对应契约测试改写与新增、权威文档同步、分切片提交并推送 `origin/dev`。
- 未授权：改动引擎运行时行为、bridge 端点与写盘语义、宿主源码；不新增依赖、不重启运行中的 DSH 服务。
- 本轮唯一 PLAN 为 `docs/agents/plan-format.md` 规定的骨架；完成后按仓库规则归档到 `.scratch/archive/`。

## 审查结论

现状（基线 `7d78e77`）核实：引擎参数确实仍以**独立卡片**形态存在，`engineLayerSlots` 只做到「按层归位 + 工具管线共享设置卡」，没有把参数搬进实例卡。

| 现状证据 | 位置 | 问题 |
|---|---|---|
| 每个能力卡内部渲染 `EngineParamFields card={能力 id}` | [EngineModuleList.tsx:168](../../src/client/features/modules/EngineModuleList.tsx) | 能力卡同时是装配卡与参数卡，同一批参数与共享设置区重复出现两处入口 |
| 层内所有卡片都是独立组件（人设、变量、模型、默认值、委派、工具、能力卡） | [EngineLayersPanel.tsx](../../src/client/app/workspace/pages/EngineLayersPanel.tsx) | 引擎设置分散，用户要改一个参数需要先判断它在哪张卡 |
| 提示词配置卡只有注入内容相关字段，没有本层引擎设置区 | [PromptConfigForm.tsx](../../src/client/features/prompts/PromptConfigForm.tsx) | 实例卡不承载本层引擎设置，与用户确认的目标形态不符 |
| 契约把现状写成规则：「一项实际装配能力一张卡」 | [ui-architecture.md](../../docs/ui-architecture.md) §9.1 | 文档需要随本轮重构同步改写 |

判定：本轮是**结构重构**，不是缺陷修复；行为目标见各 Wave 的 `<done>`，不改变任何运行时注入语义。

## 影响面、依赖与护栏

1. 主要链路：页面 → `engineLayerSlots` → `PromptConfigsEditor` / `ConfigListWithTemplates` → `PromptConfigList` → `PromptConfigCard` → `PromptConfigForm`；参数写入仍走既有 `store.patch` + `persistParamOverrides`，资产仍走各自端点。
2. 串行约束：Wave 1 的注入点是 Wave 2 内容装配的前置；Wave 2 内 T3 先于 T4/T5（T4、T5 改同一批页面与 feature 文件，串行执行）。
3. 不得改变：引擎 hook 注册、九层顺序、`/meta` 与 `/bootstrap` 载荷、参数缺省与空值语义、`expectedPresetId` 身份核对、指令文件独立正文与版本校验、localStorage 使用禁令。
4. 不得新增：状态库、事件总线、第二份参数状态、独立同步服务；跨 feature 的内部 import（共享内容放 shared 或 app 层注入）。
5. 性能护栏：折叠区默认折叠且**折叠时不渲染内容**，同层 120 张实例卡不因新增设置区而渲染出成百上千控件。
6. bridge 与安全面本轮不变：无新增端点、无白名单变更、无路径与凭据暴露；移除能力仍走既有二次确认与 `removeEngineCapability`。
7. 每个任务按约 200 行实现量级控制，超过时按行为拆成可验收切片并更新本 PLAN。

## Wave 1：实例卡内的本层设置注入点（结构骨架）

```xml
<task type="auto">
  <name>T1：提示词配置卡支持注入「本层引擎设置」折叠区</name>
  <files>src/client/features/prompts/PromptConfigForm.tsx；PromptConfigCard.tsx；PromptConfigList.tsx；PromptConfigsEditor.tsx；src/client/app/workspace/pages/ConfigListWithTemplates.tsx；src/client/locales-prompts.ts</files>
  <action>在表单分区中新增「本层引擎设置」折叠区（原生 details 或既有折叠形态），默认折叠且折叠时不渲染内容；由页面经列表逐层注入 `renderLayerSettings(layer, config)` 回调，卡片自身不依赖 store，也不复制第二份状态。</action>
  <verify>node --test "$Repo/test/client/prompt-config-form-layout.test.mjs" "$Repo/test/client/engine-module-cards.test.mjs"；断言：折叠区标题来自字典、默认折叠、折叠时不出现参数控件、展开后渲染注入内容、未注入时不渲染该区。</verify>
  <security>只呈现参数控件，不新增写通道；注入内容由 app 层提供，feature 不反向依赖 app；不涉及外部输入与路径。</security>
  <done>实例卡具备承载本层引擎设置的稳定注入点，默认折叠且零渲染成本。</done>
</task>
<task type="auto">
  <name>T2：该层无实例卡时的兜底设置容器</name>
  <files>src/client/features/prompts/PromptConfigList.tsx；src/client/app/workspace/pages/EngineLayersPanel.tsx；src/client/locales-prompts.ts</files>
  <action>当某层有可编辑引擎设置但该层没有任何可见实例卡时，列表渲染一张兜底「本层引擎设置」容器（复用同一注入内容），并在容器内说明它不写入 preset.yml；该层出现实例卡后容器不再渲染。兜底容器不进入 promptConfigs、不触发保存、不创建配置对象。</action>
  <verify>node --test "$repo/test/client/engine-module-cards.test.mjs"；断言：无实例卡且有设置时出现容器与说明、有实例卡时不出现、容器渲染不调用任何保存回调、切层不产生写入。</verify>
  <security>容器只读展示与参数写入既有参数端点，不写用户预设结构；不自动创建配置对象。</security>
  <done>没有实例卡的层（如工具链层）仍能编辑本层引擎参数，且不产生隐式写盘。</done>
</task>
```

## Wave 2：层设置内容装配与独立卡片退场

```xml
<task type="auto">
  <name>T3：按层装配引擎设置内容</name>
  <files>src/client/app/workspace/pages/EngineLayersPanel.tsx；src/client/features/modules/EngineParamFields.tsx；src/client/features/modules/EngineModuleList.tsx；src/client/shared 契约（只读复用）</files>
  <action>新增 `engineLayerSettings({ store, t, layer, keyword })`：按层归集该层引擎参数组（默认值组 + 该层能力 card，复用 `EngineParamFields` 与 `instanceId` 保证 DOM id 唯一）、该层已装配能力的装配状态与移除入口（二次确认沿用既有 ConfirmDialog 与 store.removeEngineCapability）。无参数层返回 undefined。</action>
  <verify>node --test "$repo/test/client/engine-module-cards.test.mjs"；断言：九层各自归集到的参数键与 `ENGINE_PARAM_DEFINITIONS.card` 派生一致、无参数层返回 undefined、同一参数在不同层容器内 DOM id 不重复、移除能力仍要求确认。</verify>
  <security>移除能力沿用既有授权与二次确认，不新增写通道；参数写入仍走 `persistParamOverrides`。</security>
  <done>每层的引擎设置内容有唯一装配来源，参数键不另抄一份。</done>
</task>
<task type="auto">
  <name>T4：独立能力卡与单例引擎参数卡退场</name>
  <files>src/client/app/workspace/pages/EngineLayersPanel.tsx；MainSessionPage.tsx；SubagentPage.tsx；src/client/features/modules/EngineModuleList.tsx；EngineParamFields.tsx</files>
  <action>列表不再渲染独立能力卡、提示词默认值卡；能力的存在性与移除、参数编辑全部改由 T1/T2 的层设置区承载。创建菜单（添加能力/工具模块）保留在工具栏；工具管线共享设置卡与散落的重复入口一并移除，避免同一参数第二处编辑点。</action>
  <verify>node --test "$repo/test/client/engine-module-cards.test.mjs" "$repo/test/client/menu-select.test.mjs" "$repo/test/client/scope-create-separation.test.mjs"；断言：列表不再出现能力卡节点、创建菜单仍列出全部未装配能力、层设置区可编辑同一参数且只有一处写入口。</verify>
  <security>不因移除卡片而放宽权限：只读预设下设置区仍禁用；能力移除仍受 `editable` 与确认保护。</security>
  <done>用户点击任意一张本层实例卡即可编辑本层引擎参数；界面上不再有独立的引擎参数卡片。</done>
</task>
<task type="auto">
  <name>T5：结构化资产编辑器并入层设置区</name>
  <files>src/client/app/workspace/pages/EngineLayersPanel.tsx；src/client/features/{persona,models,subagents,tools}/**；src/client/features/prompts/PromptConfigsEditor.tsx</files>
  <action>按层归属把资产编辑器并入层设置区：人设 → system-section、模板变量 → runtime-context、主模型路由 → agent-request、子代理模型路由与递归深度 → subagent-start、自定义工具与子代理工具策略 → tool-pipeline；复用各自专用编辑器、草稿池与写端点，不复制转换逻辑，不把重型编辑器做成第二实现。</action>
  <verify>node --test "$repo/test/client/engine-module-cards.test.mjs" "$repo/test/client/tools-preview.test.mjs" "$repo/test/client/module-policy-smoke.test.mjs"；断言：每项资产在且仅在其归属层的设置区出现、同层多卡同源、主子受众视图不串、只读预设下禁用。</verify>
  <security>资产写入仍走既有端点与校验（persona 互斥、工具 id 唯一、策略上限）；不把当前会话模型操作纳入预设保存。</security>
  <done>九层的引擎设置与资产编辑都在该层实例卡的设置区内完成，独立卡片全部退场。</done>
</task>
```

## Wave 3：回归、文档与交付

```xml
<task type="auto">
  <name>T6：契约测试改写与新增</name>
  <files>test/client/engine-module-cards.test.mjs；prompt-config-form-layout.test.mjs；menu-select.test.mjs；scope-create-separation.test.mjs；module-policy-smoke.test.mjs；ui-v2-page-smoke.test.mjs；locale-contract.test.mjs</files>
  <action>改写与现状绑定的旧断言（「一项装配能力一张卡」「能力卡默认折叠」「页面经 renderCapabilityExtra 注入」等），新增：层设置区的出现/默认折叠/零渲染、同层多卡同源同步、无实例卡层兜底容器、能力移除二次确认、只读预设禁用。</action>
  <verify>node --test "$repo/test/client/*.test.mjs"；上述断言通过，且不出现只靠源码字符串匹配替代行为断言的新用例。</verify>
  <security>不删除既有安全面断言（指令文件读写、写盘边界、bridge 白名单）；改写只针对与卡片形态绑定的断言。</security>
  <done>契约测试锁住新形态，旧形态断言不再残留。</done>
</task>
<task type="auto">
  <name>T7：权威文档同步</name>
  <files>docs/ui-architecture.md；docs/architecture-params.md；CHANGELOG.md</files>
  <action>改写「一项实际装配能力一张卡」「公共配置位于列表顶部」等旧契约，记录「本层引擎设置嵌在实例卡折叠区内、同源同步、无实例卡层用不写盘容器兜底、独立能力卡退场」；CHANGELOG 记本轮条目。</action>
  <verify>git -C $Repo diff --check；文档内的路径、链接与命令核对通过；不复制易变实现细节。</verify>
  <security>不涉及运行时代码；文档不记录凭据与用户数据。</security>
  <done>文档与实现一致，后续维护者不会照旧契约改回独立卡片。</done>
</task>
<task type="auto">
  <name>T8：最终门禁、GUI 产物与归档</name>
  <files>本 PLAN；脚本生成的 lib/；CHANGELOG.md</files>
  <action>在隔离 cwd 跑完整门禁，重建受影响 Web 产物并只读核对现有 3080 GUI；填满 `## 状态` 与 `## 验收记录`，把 PLAN 原样复制到 `.scratch/archive/` 后从 `.scratch/plan/` 移除，与本轮改动一并提交推送 `origin/dev`。</action>
  <verify>pnpm --dir $Repo typecheck、lint、test、build 与 git -C $Repo diff --check 全部通过；核对 lib/client.js 含本轮新文案；未启动替代服务、未重启宿主。</verify>
  <security>不提交 lib、临时目录、本地记忆或用户文件；不触碰真实 DSH_HOME 之外的用户资产。</security>
  <done>新形态全部验收通过并有实际验证记录，PLAN 归档、交付说明完整。</done>
</task>
```

## 回滚与检查点

- 每个 Wave 完成即提交一次，回滚用对应提交的 `git revert`；不重写历史、不清理用户目录。
- 中断时以最后一个已验证切片为检查点；恢复前重新检查工作树与 `pnpm --dir $Repo test` 基线。
- 结构重构期间若发现某层无法在不新增状态的前提下承载设置，停止该层改造并在本 PLAN 记录阻塞原因，不用临时全局状态绕过。

## 状态

- [ ] Wave 1 / T1、T2：待实施。
- [ ] Wave 2 / T3、T4、T5：待实施。
- [ ] Wave 3 / T6、T7、T8：待实施。

## 验收记录

（实施后逐条补录命令、结果与证据；未执行的项不写入。）

## 实施取舍与已知边界

- 兜底层设置容器只存在于界面，不写入 preset.yml；用户在该层新建配置卡后，同一份设置也出现在卡内。
- 不改变引擎运行时行为、九层顺序、参数缺省语义与 bridge 载荷；本轮只改编辑面的位置与容器。
- 重型资产编辑器（自定义工具、子代理策略）在同层每张实例卡内只渲染同一份内容，展开任意一张即操作同一资产；折叠时零渲染成本。
