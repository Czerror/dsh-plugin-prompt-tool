# 子代理页创建入口对等 与 过滤/新建严格分离（F1–F5）

- 编写日期：2026-09-17（UTC+8）。
- 状态：方案已编写；用户已指定本轮执行 F1–F5，执行完成后用 `open-code-review-delegate`（ocr）委派审查。
- 固定实现基线：`dev@f1b3621`（旧 PLAN 归档于 `.scratch/prompt-tool-framework/archive/plan-f1-f5-subagent-scope-f1b3621.md`，blob `e83aca2`，与 `f1b3621:PLAN.md` 逐字节一致）。
- 来源：用户指令——「本项目之前存在子代理工具黑白名单功能，现在是否依然存在，目前没在 UI 发现」「这是模块引擎能力，当前方案是正确的，只是子代理目前没有完整支持主会话的新建模块/引擎/工具等能力，子代理还是使用的老版新建模块功能，并且存在严重 bug」「执行 F1~F5 修复，完成后使用 ocr 技能审查」。

## 1. 用户的规则（本轮判据，最高优先级）

| 规则 | 含义 | 落地要求 |
|---|---|---|
| R1 过滤只能由用户手动改变 | 过滤框（`viewFilter` / `innerViewFilter`）与搜索词只响应人的操作 | 任何创建/复制/删除路径不得写入过滤状态；用回归断言锁死 |
| R2 新建只做两件事 | 跳转到卡片 + 展开卡片 | 创建后：① 展开新对象 ② 滚动定位到新对象；不做别的 |
| R3 新建即可见 | 新对象必须落在当前视图集合内 | 受众/作用域随创建位置代入，而不是把过滤框改成"全部" |
| R4 子代理能力对等 | 子代理页要有主会话同款的新建模块/引擎/工具入口 | 复用现有创建组件与参数桥，不另起一套 |

## 2. 只读查证结论（本轮改动依据）

### 2.1 过滤侧现状：R1 已成立

- 过滤状态唯一写入口是下拉 `onChange`：`PromptConfigList.tsx:66-68`（`changeViewFilter`）← `:320`。
- 创建/复制/删除路径（`useTemplatePicker.pickTemplate:75-88`、`handleDuplicate:182-197`、`handleDelete:198-203`）只操作 `configs` 列表，不写过滤状态。
- `ad81b28` 期间的旧联动（筛选切到 `tool-pipeline` 时自动展开自定义工具）已删除，无残留。

### 2.2 新建侧现状：R2/R3 均未达成

| 缺口 | 证据 |
|---|---|
| 新建配置不写 `audience` | `useTemplatePicker.ts:75-88` 只做深拷贝/id 去重/identity 修正/`instruction-hint → placeholder`；子代理页新建 `audience: main` 的配置后立即被 `PromptConfigList.tsx:82-87` 的作用域过滤隐藏（"新建即消失"） |
| 无滚动跳转 | 全仓库 `scrollIntoView` 零命中；`scroll` 相关代码只有 tooltip/popover 定位测量 |
| 卡片无定位锚点 | `EngineModuleCard.tsx:37` 只有 `data-module-card="true"`；`PromptConfigCard` 无 `data-*`/`id` |
| 能力卡展开信号一次性 | `MainSessionPage.tsx:27,29` 的 `focusCapability` 创建后不清空；再次创建同一能力时 `revealKey` 值不变（`EngineModuleCard.tsx:31-34`），第二次不展开 |

### 2.3 子代理页入口缺口（F1 依据）

主会话页有、子代理页没有：`EngineModuleActions`（能力模块/recipe 创建）、`EngineModuleCards`（能力卡与删除）、`CustomToolsCard`（自定义工具）、`create:variables`（插值变量）、`tpl:<layer>`（按插入点层级新建）。静态证据：全仓库唯一调用 `createEngineCapability` / `removeEngineCapability` 的组件是 `EngineModuleList.tsx`（`:45`、`:102`），子代理页不引用它。

### 2.4 受众语义澄清（实现关键）

- **"受众"（audience）是提示词配置的字段**（`audience: '' | 'main' | 'subagent'`），控制注入对象。
- **`subagentToolPolicy` 是"每个子代理的工具档"**（工具授权配置，写在 preset.yml 顶层 `subagentToolPolicy` 段），两者不是同一个"受众"概念，本轮不混用。
- 内置模板现状：`templates/70-subagent-maintenance.yml` 显式 `audience: subagent`；其余模板无 `audience` 键（缺省 = 公用，主会话与子代理都可见）。因此子代理页新建的可见性风险集中在"模板自带 `audience: main`"与后续人工改判。

## 3. 修复方案（F1–F5）

### F1 补齐子代理页创建入口（R4）

- `SubagentPage.tsx` 接入与主会话同款入口：
  - `EngineModuleActions`（合并菜单：引擎能力/recipe 创建）；
  - `EngineModuleCards`（能力卡 + 删除；`layerFilter` 与页面视图联动）；
  - `CustomToolsCard`（自定义工具新建/编辑）；
  - 模板入口按插入点层级（`tpl:<layer>`）与变量入口。
- 复用现有参数桥与既有组件，不新增数据通道；子代理页仍不重复主会话专有模块（`tool-bootstrap` / `context-gate` 的门控语义保持在主会话页，子代理相关开关仍由「工具与深度」卡承担）。
- 新增对象按当前页面作用域代入（见 F2），保证满足 R3。

### F2 受众/作用域代入 + 过滤零写入（R1/R3）

- `useTemplatePicker` 增加作用域参数；`pickTemplate` 依据调用位置写入受众：
  - 子代理页新建 → `audience: 'subagent'`；
  - 主会话页新建 → 保持模板原样（缺省 = 公用，两边可见）。
- 明确禁止：创建路径调用 `changeViewFilter` / 写 `viewFilter` / 改搜索词。

### F3 跳转 + 展开（R2）

- 给卡片加稳定定位锚点：`EngineModuleCard` 增加 `data-module-card-id`，`PromptConfigCard` 增加 `data-config-id`。
- 创建成功后：先展开（沿用 `revealKey` / `createdConfigId`），渲染提交后滚动定位到锚点（`scrollIntoView({ block: 'nearest' })`，避免整页跳动）。
- 清理一次性信号：`focusCapability` 在展开生效后清空，保证**重复创建同一能力仍会再次展开并跳转**。
- 目标节点异步出现时（描述符有 30 秒缓存）在同一提交/下一帧重试，找不到则静默退出，不阻塞创建结果。

### F4 修 `beforeCards` 位置与过时文案

- `PromptConfigList` 的 `beforeCards` 渲染位置与注释不符（注释自称"置顶固定卡片"，实际渲染在标题与工具栏之后，`:339-340`）——移到列表顶部，或修正注释与语义一致。
- 改写过时文案：`locales.ts:73`（`configList.emptyPreStep` 声称"作为 settings 覆盖层，切换预设后仍保留"）与 `ConfigListWithTemplates.tsx:32` 注释——实际 promptConfigs 按预设存储、写激活预设 `preset.yml`（`use-prompt-tool-store.ts:842`、ADR-0001），切换预设不会保留。

### F5 指令文件卡作用域收敛 + 回归断言

- 指令文件（AGENTS.md 等）是主会话概念：收敛为仅主会话页渲染，避免子代理页重复挂载产生双编辑入口。
- 新增确定性回归测试（至少覆盖）：
  1. 任意创建路径调用后，过滤状态与搜索词逐字节不变；
  2. 子代理作用域新建的配置立刻出现在子代理列表且处于展开态；
  3. 同一能力连续创建两次，每次都能展开并触发跳转信号；
  4. 复制配置时 `audience` 原样透传，不被作用域改写。

## 4. 任务拆解与执行

### Wave 1：受众与作用域（F2 基础）

- [✔] T1：`useTemplatePicker` 增加作用域参数并代入 `audience`；`ConfigListWithTemplates` 透传 `scope`。
- [✔] T2：主会话页创建链路保持缺省（公用），确认无过滤写入。

### Wave 2：跳转与展开（F3）

- [✔] T3：卡片锚点（`data-module-card-id` / `data-config-id`）。
- [✔] T4：创建后滚动定位 + 一次性展开信号清理（含重复创建场景）。

### Wave 3：子代理页入口对等（F1）

- [✔] T5：`SubagentPage` 接入能力创建菜单、能力卡、自定义工具卡、按层模板与变量入口。
- [✔] T6：清理"老版新建模块"残留（若存在与新版重复的入口，保留单入口）。

### Wave 4：位置与文案（F4）与收敛（F5）

- [✔] T7：`beforeCards` 位置修正 + 过时文案改写（中文与英文文案同步）。
- [✔] T8：指令文件卡作用域收敛为仅主会话页。
- [✔] T9：回归测试 T1–T4 断言全部落地。

### Wave 5：门禁与交付

- [✔] T10：`pnpm typecheck` + `lint` + `test` + `build` + `git diff --check` 全绿。
- [ ] T11：提交并推送 `origin/dev`（中文 Conventional Commit）。
- [ ] T12：`open-code-review-delegate` 委派审查本轮改动，结果写入本文件与 `.ai-memory/`。

## 5. 验证与证据

- 门禁：`pnpm --dir $Repo typecheck`、`lint`、`test`、`build`、`git -C $Repo diff --check`。
- 行为证据：
  - 子代理页新建配置后立即出现在子代理视图并展开（客户端测试断言）；
  - 创建动作前后过滤状态不变（同一测试内断言）；
  - 重复创建同一能力两次，展开/跳转信号两次都触发（组件测试断言）；
  - 指令文件卡不再出现在子代理页（结构断言）。
- 反例证据：`git status` 只含本轮文件；`lib/` 与 `.ai-memory/` 不入库。

## 6. 回滚与停止条件

- 回滚：本轮为前端行为修复 + 文案修正，反向 `git revert` 本轮提交即可；不改写历史、不 reset、不 clean。
- 不动运行中的 DSH：不停止/重启当前 dsh 与 dsh web，不抢占端口；客户端改动需用户刷新页面（必要时本插件客户端 bundle 重建）。
- 停止条件：门禁全绿、推送成功、OCR 审查完成并记录结论。

## 7. Wave 与任务完成状态

`[✔]` = 已完成且对应验证通过；`[ ]` = 未完成。

- [✔] **Wave 1：受众与作用域（F2 基础）**
  - [✔] T1：`useTemplatePicker` 新增 `TemplatePickerScope` 与纯函数 `createConfigFromTemplate`（受众代入 + id 去重 + identity 跟随 + 策略降级）；`ConfigListWithTemplates` 透传 `scope`。
  - [✔] T2：主会话页两个入口（`PromptConfigList` 内建与合并菜单）均以 `scope='main'` 创建，保持公用缺省；创建链路无过滤写入。
- [✔] **Wave 2：跳转与展开（F3）**
  - [✔] T3：`PromptConfigCard` 加 `data-config-id`；`EngineModuleCard` 加 `anchorId` → `data-module-card-id`；新增 `src/client/ui/reveal-card.ts`。
  - [✔] T4：`createdConfigId` 与 `focusCapability` 两处创建后均滚动定位；定位信号改为 `{ id, token }` 递增，重复创建同一能力仍展开。
- [✔] **Wave 3：子代理页入口对等（F1）**
  - [✔] T5：`SubagentPage` 接入 `EngineModuleActions`、`EngineModuleCards`、`CustomToolsCard`、按层模板与 `TemplateVariablesModuleCard`（后者由 `PromptConfigsEditor` 导出复用）。
  - [✔] T6：子代理页不再只有老版单入口——创建链路统一走新组件；`ConfigListWithTemplates` 增加 `toolbarActions` / `moduleCards` / `onViewFilterChange` 三个受控口，未新增第二套实现。
- [✔] **Wave 4：位置与文案（F4）与收敛（F5）**
  - [✔] T7：`beforeCards` 移到过滤行之前且只渲染一次；`configList.emptyPreStep` 中英文案与源码注释改为"写入激活预设 preset.yml，随预设走"。
  - [✔] T8：指令文件卡 props 按 `instructionScope` 收敛，子代理页不下发（单一编辑入口）。
  - [✔] T9：新增 `test/client/scope-create-separation.test.mjs`（10 条断言）；`engine-module-cards` 展开用例改用新信号并补重复创建断言。
- [✔] **Wave 5：门禁与交付**
  - [✔] T10：`typecheck` ✓、`lint` 0 warning/0 error（257 文件）✓、`test` **940/940** ✓、`build` ✓、`git diff --check` 干净 ✓。
  - [✔] T11：提交 `9227c09`（`feat(client): 子代理页创建入口对等，过滤与新建严格分离`），快进推送 `origin/dev`（`f1b3621..9227c09`）。
  - [✔] T12：`ocr delegate`（open-code-review v1.12.4）范围审查 `f1b3621..9227c09`：17 个变更文件中 **13 个可审查**（4 个 md 被规则排除），13/13 逐文件审阅，见第 8 节。

## 8. 交付与 OCR 委托审查记录

- 提交：`9227c09`，快进推送 `origin/dev`（`f1b3621..9227c09`）；未切 `main`、未建 PR、本地记忆（`.ai-memory/`）与 `lib/` 不入库。
- 审查入口：`ocr delegate preview --from f1b3621 --to 9227c09 --format json -b "…"` → `mode: range`，`reviewable_count: 13`，`excluded_count: 4`（`PLAN.md`、`CHANGELOG.md`、`docs/ui-architecture.md`、`.scratch` 归档，均为 `unsupported_ext`）；`ocr delegate rule` 返回单一系统规则组（拼写/死代码/代码质量/React 最佳实践/异步/安全）。
- 覆盖：13/13 可审查文件逐文件核对 diff + 规则（`ConfigListWithTemplates`、`MainSessionPage`、`SubagentPage`、`EngineModuleList`、`PromptConfigCard`、`PromptConfigList`、`PromptConfigsEditor`、`useTemplatePicker`、`locales`、`EngineModuleCard`、`reveal-card`、`engine-module-cards.test`、`scope-create-separation.test`）。
- 结论：**无 critical/high 缺陷**。命中规则的检查项全部满足——无 `any`、无 `var`、无 `==`、无嵌套三元、无 `innerHTML`/`eval`、无组件内声明组件、无内联 style、effect 均有清理函数（`scrollToCreatedCard` 返回 disposer，`setTimeout`/`requestAnimationFrame` 均被取消）、异步路径无未处理拒绝。
- 记录备查的设计取舍（非缺陷，用户规则下的预期行为）：目标卡被当前过滤挡掉时（例如在 `tool-pipeline` 视图新建能力、在 `runtime-context` 视图新建任何能力）卡片保持不可见、滚动重试约 2 秒后静默退出——这正是"过滤只能由用户手动改变、新建不得动过滤框"的直接结果，切到「全部」或对应层即可见。
- 低优先改进候选（未改，等用户指定修复范围）：
  1. `reveal-card.ts` 的重试窗口内若用户切页，重试仍会继续（组件卸载会取消；面板常驻时会有一次延迟跳转）。
  2. `SubagentPage` 与主会话页的创建菜单弹层共用同一个 `anchorRef`，两个入口在不同位置触发时弹层锚点仍指向合并菜单按钮。
