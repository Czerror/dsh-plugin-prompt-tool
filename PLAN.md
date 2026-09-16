# subagentToolPolicy 改为模块类型能力（G1–G5）

- 编写日期：2026-09-17（UTC+8）。
- 状态：方案已编写；用户已在交互确认三个决策点后授权执行。
- 固定实现基线：`dev@6990bff`（旧 PLAN 归档于 `.scratch/prompt-tool-framework/archive/plan-subagent-policy-as-capability-6990bff.md`，blob `d3fccee`，与 `6990bff:PLAN.md` 逐字节一致）。
- 来源：用户指令——「能否把 subagentToolPolicy 改为模块类型能力」「子代理不显示创建 tool-filter」。

## 1. 用户的决策（本轮判据）

| 决策点 | 用户选择 |
|---|---|
| 启用时写入什么 | **写入可用骨架**：`ceiling.allow` = 常用工具（read/write/edit/glob/grep/bash），一个 default 档全放行，`expansion` 开启且 `requireApproval: true`；启用后立即可用，用户再按需收窄 |
| 能力卡位置 | **单独一张能力卡**：与 `tool-bootstrap`、`anchor-turn` 等并列，卡内嵌现有策略编辑器（档位/预览/保存） |
| 删除语义 | **一并删除策略段**：移除模块声明 + 顶层 `subagentToolPolicy` 段，真正回到官方委派行为 |

## 2. 现状与目标形态

现状：`subagent-tool-policy` **已经是模块**（`engine/compositions/source/local/subagent-tool-policy.yml` 物化 shadow 行），但未登记进 `ENGINE_CAPABILITIES`，所以能力菜单里没有它；启用靠预设顶层 `subagentToolPolicy` 段非空时由 `appendPresetModules` 自动追加模块；卡片住在「工具与深度」卡内。

目标：把它做成**一等能力模块**——能力菜单可创建、能力卡可删除、`modules` 声明即存在；同时保留"段数据源"（`preset.yml` 顶层段 → 物化 `subagent-tools/policy.yml`），因为策略是结构化数据而非行 config。

## 3. 影响面与改动设计

| # | 文件 | 改动 |
|---|---|---|
| G1 | `src/shared/engine-capabilities.ts` | `EngineCapability` 增加可选 `ownSection?: { key: string; skeleton: Record<string, unknown> }`；登记 `subagent-tool-policy`（`moduleKeys`/`rowIds` = `subagent-tool-policy`，`displayLayer: 'tool-pipeline'`，`ownSection.key = 'subagentToolPolicy'`，`skeleton` = 可用骨架） |
| G2 | `src/host/manifest.ts` | `createEngineCapabilityInPreset`：能力带 `ownSection` 且该段缺失时写入 `skeleton`（启用即一致）；`removeEngineCapabilityFromPreset`：能力带 `ownSection` 时一并删除该段 |
| G3 | `src/client/features/modules/EngineModuleList.tsx` | 能力卡渲染：能力 id 为 `subagent-tool-policy` 时内嵌 `SubagentToolPolicyCard`（复用现有编辑器，不复制实现）；移除能力仍走「删除引擎能力」二次确认 |
| G4 | `src/client/features/subagents/DelegationToolsCard.tsx` | 「工具与深度」卡不再内嵌策略编辑器（避免双入口），只保留深度与入口提示；策略编辑器唯一入口 = 能力卡 |
| G5 | 测试/文档 | host 端：启用写骨架+模块、删除清段+模块、幂等、校验拒绝零落盘；client 端：能力卡内嵌策略编辑器、菜单含该能力；`CHANGELOG.md`、`docs/ui-architecture.md`、`docs/architecture-params.md` 同步 |

### 3.1 骨架形态（用户决策 1）

```yaml
subagentToolPolicy:
  defaultProfile: default
  ceiling:
    allow: [read, write, edit, glob, grep, bash]
    deny: []
  profiles:
    - id: default
      name: 默认
      allow: [read, write, edit, glob, grep, bash]
      deny: []
      modelSelectable: true
  modelExpansion:
    enabled: true
    allow: [read, write, edit, glob, grep]
    maxAdditionalTools: 2
    requireApproval: true
```

（需用 `validateSubagentToolPolicy` 实测通过后再定稿。）

### 3.2 一致性约束

- **启用即一致**：能力创建时同时写模块声明与骨架段，避免"模块在、段不在"导致 shadow 行读不到 `policy.yml`。
- **数据源不变**：策略仍以 `preset.yml` 顶层段为单一事实源，`writePreset` 继续物化 `subagent-tools/policy.yml`（不搬进 `moduleConfigs`）。
- **兼容读取**：已有预设（段非空、模块未声明）继续按现有分支工作；下次保存会补上模块声明。

## 4. 任务拆解与执行

### Wave 1：能力登记与宿主写盘

- [ ] T1：`EngineCapability.ownSection` + 登记 `subagent-tool-policy` + 骨架定稿（经 `validateSubagentToolPolicy` 实测）。
- [ ] T2：`createEngineCapabilityInPreset` 写骨架；`removeEngineCapabilityFromPreset` 删段。
- [ ] T3：host 回归测试（启用/删除/幂等/拒绝）。

### Wave 2：UI 落位

- [ ] T4：能力卡内嵌 `SubagentToolPolicyCard`（唯一入口）。
- [ ] T5：`DelegationToolsCard` 去掉内嵌编辑器，保留提示指向能力卡。
- [ ] T6：client 回归测试（卡片内嵌、菜单含能力、单入口）。

### Wave 3：门禁、交付与审查

- [ ] T7：`typecheck` + `lint` + `test` + `build` + `git diff --check` 全绿。
- [ ] T8：文档同步（CHANGELOG / ui-architecture / architecture-params）。
- [ ] T9：提交并推送 `origin/dev`。
- [ ] T10：`open-code-review-delegate` 委派审查本轮改动并记录结论。

## 5. 验证与证据

- 行为证据：真实端点/宿主函数实测——启用后 `preset.yml` 同时含 `modules: subagent-tool-policy` 与骨架段；`writePreset` 产出 `subagent-tools/policy.yml`；组合装配 shadow 行；删除后两者都消失且组合无该行。
- 反例证据：无 `modules` 数组时启用被拒；骨架若未通过校验则该用例必须红（防止写入非法策略）。
- 门禁：`pnpm --dir $Repo typecheck|lint|test|build`、`git -C $Repo diff --check`。

## 6. 回滚与停止条件

- 回滚：反向 `git revert` 本轮提交；`ownSection` 为新增可选字段，不回写历史预设数据。
- 不动运行中的 DSH：不停止/重启服务；客户端改动需用户刷新页面。
- 停止条件：门禁全绿、推送成功、OCR 审查完成。

## 7. Wave 与任务完成状态

`[✔]` = 已完成且对应验证通过；`[ ]` = 未完成。

- [✔] **Wave 1：能力登记与宿主写盘**
  - [✔] T1：`EngineCapability.ownSection` + 登记 `subagent-tool-policy` + 骨架实测通过（校验零错误、解析出 6 个工具、扩权需审批）。
  - [✔] T2：`createEngineCapabilityInPreset` 写骨架（段存在即不覆盖）；`removeEngineCapabilityFromPreset` 连段一起删。
  - [✔] T3：`test/host/subagent-policy-capability.test.mjs` 7 条（目录登记/启用/幂等/半状态自愈/删除清段/残留清理）。
- [✔] **Wave 2：UI 落位**
  - [✔] T4：能力卡经 `renderCapabilityExtra` 插槽内嵌 `SubagentToolPolicyCard`（内嵌 feature 会违反 feature 边界，故用插槽）。
  - [✔] T5：`DelegationToolsCard` 去掉内嵌编辑器，保留深度与入口提示（`policy.delegation.policyMoved`）。
  - [✔] T6：client 断言更新（排除清单、单入口、`declaredModules` 夹具）。
- [✔] **Wave 3：门禁、交付与审查**
  - [✔] T7：`typecheck` ✓、`lint` 0 warning（261 文件）✓、`test` **959/959** ✓、`build` ✓、`git diff --check` ✓。
  - [✔] T8：`CHANGELOG.md`、`docs/ui-architecture.md` 同步。
  - [ ] T9：提交并推送 `origin/dev`（下一步）。
  - [ ] T10：`open-code-review-delegate` 委派审查（下一步）。

## 8. 执行中发现并修复的额外缺陷

- **半状态无法补齐模块声明**：`resolvePresetModuleFacts` 原先会因顶层 `subagentToolPolicy` 段存在而隐式把
  `subagent-tool-policy` 追加进 `effectiveModules`，于是"段在、模块不在"被判成"已装配"，能力菜单永远补不上模块声明。
  修复：移除该隐式追加，`isEngineCapabilityPresent` 以 `declaredModules` 判定（模块声明 = 唯一开关）。
  已由「半状态自愈」用例锁定。
- **骨架超限**：首版骨架把 `web_search` / `web_fetch` 放进 `modelExpansion.allow`，超出 `ceiling.allow`，
  被 `writePreset` 拒绝。改为 ceiling 子集（`write`/`edit`/`glob`/`grep`），并由目录用例校验骨架合法性。
