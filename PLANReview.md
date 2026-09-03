# 验收结论：**不通过**

验收日期：**2026-09-02**。当前 `dev` 分支 `HEAD=f732891`，与 `origin/dev` 一致，工作树干净。

## 基础验证

以下命令均按要求在 `D:\AI\workspase\_temp` 执行：

- `pnpm --dir $Repo typecheck`：通过
- `pnpm --dir $Repo lint`：通过
- `pnpm --dir $Repo test`：**456/456 通过**
- `pnpm --dir $Repo build`：通过
- `git diff --check`：通过

但测试全绿不能证明 PLAN 验收通过：子代理策略测试使用了与官方 API 不一致的 mock，掩盖了实际运行错误。

## Wave 验收

| Wave | 结果 | 说明 |
|---|---|---|
| Wave 1：ToolDefinition 标准化 | 部分通过 | Schema 物化、无参数工具、输出校验和 disposer 已实现；非法参数没有产生标准工具错误 |
| Wave 2：delegate ToolRuntime | 基本通过 | 已走 `ctx.tools.execute()`，调用身份、Signal、上下文和结束语义有覆盖 |
| Wave 3：策略与物化链 | 不通过 | 策略无法停用，writer 不校验策略，也不会自动装配模块 |
| Wave 4：Agent-scoped shadow | **不通过，P0** | spawn/fork、前台/continuable 与官方 API 契约不匹配 |
| Wave 5：UI | 不通过 | 仅完成基础编辑器，PLAN 要求的 session、角色库、完整预览等未实现 |
| Wave 6：文档与验证 | 部分通过 | 命令通过，但 PLAN 中“Wave 1-6 完成”的执行记录与实际不符 |

## 发布阻断项

### 1. 子代理运行时使用了错误的官方 API

`engine/subagent-tool-policy.mjs:144-171`：

- `startContinuable()` 缺少顶层 `signal`
- 读取不存在的 `child.sessionId`，官方返回 `childId`
- 前台运行读取不存在的 `runHandle.sessionId`
- 调用不存在的 `runHandle.settled()`；官方接口是 `run.result`

官方契约位于：

- `deepseek-harness/packages/subagent/subagent/src/continuation.ts:92-117`
- `deepseek-harness/packages/subagent/subagent/src/types.ts:264-289`

该契约在 PLAN 基线 DSH `0.1.2-alpha.4` 和当前实际链接的 `0.1.2-alpha.5` 中相同，不属于版本漂移。

隔离探针结果：

```text
continuable topLevelSignalPresent = false
childId expected "child-bg", actual ""
foreground error = "runHandle.settled is not a function"
```

对应测试 `test/engine/subagent-tool-policy-runtime.test.mjs:39-45` 恰好伪造了 `sessionId` 和 `settled()`，因此形成假阳性。

### 2. `subagent_fork` 实际调用了 `spawn`

`engine/subagent-tool-policy.mjs:88` 为两种 shadow 共用默认 provider `spawn`。

隔离结果：

```text
subagent_fork provider expected "fork", actual "spawn"
```

因此不满足：

- fork 继承父模型路由
- fork 继承上下文
- KV Cache 语义
- spawn/fork 独立行为

### 3. Selector 优先级存在确定性错误

`engine/subagent-tool-policy-core.mjs:259-279` 使用“当前 profile 是否等于默认 profile”判断前一选择器是否命中。

当显式 `tool_profile` 正好选择默认档时，后续 `character_id` 仍会覆盖它：

```text
输入：tool_profile=base, character_id=analyst
期望：base
实际：researcher
adopted：["tool_profile", "character_id"]
```

违反固定优先级：

```text
tool_profile > character_id > task_type > 自动分类 > default
```

### 4. 子代理不能拥有主代理之外的工具

`engine/subagent-tool-policy.mjs:110` 使用：

```js
ctx.tools.schemas(run.agent)
```

作为 `presetAvailable`。这取到的是父代理**已经过滤后的实际工具面**，所以主代理隐藏的工具无法授权给子代理。

直接违反 PLAN 13.3：

> 子代理可比主代理拥有更多工具，但不能超过用户 ceiling。

### 5. 模型参数 Schema 没有真正执行校验

shadow 工具通过 `agent.ctx.tools.register()` 注册，未使用 `defineTool()`，也没有运行时参数校验。

真实 ToolRuntime 探针：

```text
传入 enum 外的 profile
invalidEnumRejected = false
bodyRan = 1
```

因此以下限制都能被绕过或只会被静默忽略：

- `modelSelectable: false`
- `additional_tools.maxItems`
- selector enum
- 参数类型

越界扩权目前是过滤或截断，不是 PLAN 要求的明确拒绝。

### 6. 策略无法停用

`src/runtime/settings-bridge.ts:1353-1358` 在判断空策略之前先执行校验。

UI 发送 `{ policy: null }` 时结果为：

```text
HTTP 409
subagentToolPolicy must be an object
policyStillPresent = true
```

同时，启用后的 UI 没有可操作的停用按钮。

### 7. `writePreset()` 没有保障策略契约

`src/host/write-preset.ts:658-666` 只原样写入策略文件，没有：

- 调用统一 validator
- 自动追加 `subagent-tool-policy` 模块
- 拒绝非法策略

隔离结果：

```text
手写合法 subagentToolPolicy：
policy.yml 已生成 = true
运行时模块已装配 = false

手写 subagentToolPolicy: {}：
应拒绝 = true
实际接受 = true
非法 policy.yml 已生成 = true
```

这还会导致参数桥停止写入原 delegation filter，但新的策略模块并未加载。

### 8. `maxDepth` 和模型路由在策略启用后失效

`engine/compositions/source/local/subagent-tool-policy.yml` 只向 shadow 模块传入 `policyFile`。

原参数桥仍将以下配置写到被 shadow 的官方工具行，而不是新模块：

- `maxDepth`
- `subagentModel.agentOptions`
- provider/model 默认值

此外，shadow 工具：

- 不传递 `reasoning_effort`
- 不要求 provider/model 成对
- 不执行 LLM route preflight
- 不保留官方模型选择策略

### 9. 跨预设隔离未实现

`engine/subagent-tool-policy.mjs:195-204` 监听所有 `agent/created` 后直接注册 shadow，没有检查 Agent 是否属于当前 preset generation。

官方 `tool-subagent` 对同类场景使用 `scopeChainOf(scopeOf(agent.ctx)).includes(compositionScope)` 做归属过滤。当前实现无法满足：

- 两个 preset generation 的 policy 不串用
- Agent 重挂预设后的工具定义正确回收和重装

### 10. UI 仅为部分实现

目前仍缺少 PLAN 明确要求的功能：

- 主会话 session id 没有从 `ctx.sessions.list.getSnapshot()` 自动取得，仍需手工输入
- profile 没有复制、排序和引用感知删除
- 没有当前工具目录勾选
- 角色绑定没有使用 `/characters-list`，仅手填 ID
- 没有失效角色绑定检查
- task rule 没有 `modelSelectable` 编辑项
- 没有即时正则校验和单独测试文本
- 实例预览缺少 `tool`、`character_id`、`task_type`、`restrict_tools`
- 预览没有 provider capability 结果
- 工具面没有展示总数

## 已确认通过的部分

- 自定义工具参数 DSL 使用官方转换器物化为 JSON Schema。
- 无参数工具可进入 `ctx.tools.schemas()`。
- 非法成功输出会被 registry 拒绝。
- 自定义工具 disposer 会撤销注册。
- delegate 已删除直接 `.execute()` 调用，改走真实 `ctx.tools.execute()`。
- nested call 的 `rootCallId`、parent token、Signal、additionalContexts、concludesTurn 已传播。
- `/tool-surface` 只读取存活 Agent，并仅返回 `name/description`。
- loopback、Host、Origin 和 body-size guard 保留。
- SlotRegistry/no-host-DOM 测试通过。
- 未修改或重启当前运行中的 DSH 服务。

## 最终判定

当前实现不能将 PLAN 第十六节标记为“Wave 1-6 全部完成”。至少应先完成以下 P0 修复后重新验收：

1. 按官方 `SubagentRun`、`ContinuableStartSpec` 和 `ContinuableStart` 契约重写运行路径。
2. 将 `subagent` 固定到 `spawn`、`subagent_fork` 固定到 `fork`。
3. 使用真实官方形状重写运行时测试，删除 `sessionId/settled()` 假接口。
4. 修复 selector 命中状态、preset 可用工具来源和跨 generation scope 过滤。
5. 修复策略停用、writer 校验和模块自动装配。
6. 恢复 `maxDepth`、子代理模型路由、reasoning effort 与 preflight。
7. 完成 PLAN 规定的 UI 和 sessions snapshot 接入。

本轮仅执行验收，仓库无改动，因此**没有新增提交或推送**。当前远端状态仍为 `origin/dev@f732891`。

Contract check: PLAN.md 分 Wave 验收、官方契约核验、完整验证命令、阻断项、Git 状态。
