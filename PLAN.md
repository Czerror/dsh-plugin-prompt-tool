# dsh-plugin-prompt-tool 工具契约与预设工具面计划

> 日期：2026-09-02
> 分支：`dev`
> 基线：`e3433da`
> 状态：待实施
> 替代：原《L2 参数、Bridge 与 Engine 重构计划》已全部落地，本文件整体取代旧计划。
> 参考：`D:\AI\GitHub\dsh-plugins@05c50f3`、`D:\AI\GitHub\deepseek-harness@4e84901`（DSH `0.1.2-alpha.4`）。

## 一、结论与范围

本轮只处理工具契约和工具面可观测性，不重做现有预设编译器。

优先级固定为：

1. **P0：修复自定义工具定义契约**
   - `customTools.parameters` / `output.schema` 必须经官方 `dsh-tools` DSL 转为标准 JSON Schema。
   - 无参数工具也必须提供合法的空对象参数 Schema。
   - 真实 `ToolRuntime` 必须能够执行并投影所有生成工具。
2. **P0：修复 delegate 执行链路**
   - delegate 必须经 `ctx.tools.execute()` 做嵌套调度。
   - 不再直接调用目标工具的 `execute()`。
3. **P1：增加当前会话实际工具面预览**
   - UI 只读展示当前 Agent scope 最终可见的工具名与描述。
   - 不挂载未激活预设，不提供任意 `agent.cordis.yml` 通用编辑器。
4. **P2：收紧未实现契约**
   - 当前未实际消费的 `customTools.scope` 改为显式拒绝，避免静默忽略。
   - 真正的 main/subagent/both 作用域另立计划，不在本轮做半套实现。

明确排除：

- 不修改 DeepSeek Harness 源码。
- 不替换 `preset.yml → modules/moduleConfigs/params → agent.cordis.yml` 编译链。
- 不把行为源迁移到官方 `agentPresets` Remote。
- 不复制 `dsh-plugins/preset-builder` 的旧 `agentPresets.mutate` API。
- 不增加 PTY、持久 stdin、后台 Job 或定时任务执行器。
- 不新增工具并发配置；未声明 `isConcurrencySafe` 时保持官方默认独占执行。
- 不增加跨标签页 revision fencing；出现真实并发编辑需求后再做。

## 二、已确认事实

### 2.1 当前自定义工具没有生成合法 ToolDefinition

`engine/tool-config-engine.mjs` 当前直接把配置 DSL 注册到 `ctx.tools.register()`：

- 有参数工具把 `{ text: { type: string, required: true } }` 原样暴露给模型，而不是 JSON Schema object。
- 无参数工具省略 `parameters`，真实 `ctx.tools.schemas()` 会报错。
- `output.schema` 同样绕过官方 ValueSchemaSpec 转换，嵌套 required 语义不能保证正确。

已在 `D:\AI\workspase\_temp` 使用真实 `Context + SystemPrompt + ToolRuntime` 验证：

```text
tool "no_args" parameters must be lossless JSON before schema projection
```

因此现有 mock 只捕获“对象是否注册”，不足以证明工具能进入真实模型目录。

### 2.2 delegate 绕过官方工具管线

当前 delegate 路径通过：

```js
const target = tools.get(name)
await target.execute(args, minimalExec)
```

直接执行目标实现，绕过：

- 参数 Schema 校验；
- allow/deny/ask 与 approval；
- `tools/pre-execute` / `tools/execute` / `tools/post-execute`；
- timeout policy；
- 嵌套调用 token、rootCallId 与 durable result；
- additionalContexts 与 concludesTurn 传播。

复合工具必须使用官方 registry 作为唯一执行入口。

### 2.3 `scope` 目前只是死字段

`customTools.scope` 仅校验 `main | subagent | both`，注册逻辑没有读取它，UI 也没有入口。

本轮不为一个尚未开放的字段引入 `agent/created`、root/subagent 判断和多套 disposer。先显式拒绝该字段；未来确有需求时参考 `dsh-plugins/loop` 的 agent-scoped 注册模式完整实现。

### 2.4 `preset-builder` 只能参考 UI 概念

`dsh-plugins/preset-builder` 的“预设组成 + 最终工具列表”信息架构有参考价值，但代码基于旧接口：

- 依赖 `@deepseek-ai/dsh-client-runtime` / `connection.api`；
- 假定 `agentPresets.read()` 返回 `plugins`、`tools`、`revision`；
- 假定存在 `set-disabled` / `set-config` mutation。

当前 DSH `0.1.2-alpha.4` 的 `readDocument()` 只返回 composition 文本、trust 和展示元数据；`pluginInventory` 也是只读组合清单。因此本项目继续使用当前 `remote`、`settingsScope` 和受控 loopback bridge。

## 三、架构决策

### 3.1 `preset.yml` 继续是唯一行为源

保持现有链路：

```text
preset.yml customTools
        ↓ writePreset
custom-tools/*.yml
        ↓ tool-config-engine
官方 ToolDefinition
        ↓ ctx.tools registry
Agent 实际工具面
```

约束：

- `custom-tools/*.yml` 是生成物，不成为第二个可编辑源。
- `agent.cordis.yml` 仍由模块编译器生成，不增加通用原始 YAML 写入入口。
- 保存自定义 delegate 工具时，现有 `customToolModules()` 继续自动补齐角色卡、世界书和 session-var 模块。

### 3.2 官方 schema 转换必须复用，不自造第二套

优先从运行中的 DSH 入口解析同一份 `@deepseek-ai/dsh-tools`，复用：

- `defineTool()`；或
- `parameterSchemaSpecToJsonSchema()` / `valueSchemaSpecToJsonSchema()`。

解析方式参考 `dsh-plugins/loop`：从 `process.argv[1]` 创建 `require`，避免生成目录或 link 路径加载出另一份 Host 依赖。

若隔离 smoke 证明该解析方式在生成预设目录不可用，才把 Schema 转换移到 host 侧物化阶段；不复制官方转换器源码。

### 3.3 delegate 是嵌套工具调用，不是本地函数调用

嵌套调度必须携带：

```text
callId
rootCallId
name
arguments
agent
parent = 当前 run.token
signal
```

外层工具继续保持当前 `{ ok, value?, error? }` 输出契约，但必须：

- 从标准 `ToolExecutionResult` 读取成功值或错误；
- 将 nested result 的 additionalContexts 逐项交给 `run.deferContext()`；
- nested result 标记 concludesTurn 时调用 `run.concludeTurn()`；
- callId 使用当前调用可推导的稳定后缀，不使用 `Date.now()`。

### 3.4 工具面预览只展示真实运行态

第一版只展示当前会话 Agent scope 的实际工具面：

```text
Host 全局工具
+ 当前 preset 工具
+ agent-scoped 工具与 restriction
+ 当前 presentation/filter 状态
= 当前会话实际工具面
```

不尝试静态推导任意未挂载预设的“最终工具”，因为它还受 Host bundle、Agent scope、tool-filter、bootstrap/stage 和运行时代际影响。

UI 行为：

- 展示工具总数、名称、描述和文本搜索；
- 无当前会话时显示明确空态；
- 保存或重建后提示“既有会话保留原 generation”；
- 只读，不提供插件启停或通用 JSON config 编辑。

## 四、实施 Wave

### Wave 1：ToolDefinition 标准化（P0）

修改目标：

- `engine/tool-config-engine.mjs`
- `test/engine/tool-config-engine.test.mjs`

任务：

1. 从运行中 DSH 解析官方 `dsh-tools` 导出，确保与 Host 使用同一份包。
2. `compileTool()` 使用官方转换构造完整 ToolDefinition：
   - `parameters: def.parameters ?? {}`；
   - `output.schema` 经 ValueSchemaSpec 转换；
   - 保留当前 JSON renderer、timeoutMs 与 execute 分发。
3. 保留现有输入校验、description 消毒和按条跳过语义。
4. `scope` 存在时明确报“不支持”，该条工具按现有 warn-and-skip 处理。
5. 增加真实 registry 契约测试：
   - 有参数工具生成标准 JSON Schema；
   - 无参数工具生成空 object Schema；
   - output required / array / oneOf 转换正确；
   - `ctx.tools.schemas()` 不抛错；
   - `ctx.tools.execute()` 能完成一次真实调用并校验输出。

验收门：Wave 1 未通过前不进入 delegate 和 UI 工作。

### Wave 2：delegate 统一走 ToolRuntime（P0）

修改目标：

- `engine/tool-config-engine.mjs`
- `test/engine/tool-config-engine.test.mjs`

任务：

1. 删除 `tools.get(...).execute(...)` 与伪造 `minimalExec`。
2. 使用 `ctx.tools.execute()` 发起 nested dispatch。
3. 保留完整引用、部分插值和固定值的现有 args 映射语义。
4. 转换标准成功/失败结果为外层 `{ ok, value?, error? }`。
5. 传播 additionalContexts、concludesTurn 和 AbortSignal。
6. 增加确定性测试：
   - 目标参数非法时由真实 registry 拒绝；
   - pre/post hook 能观察 nested call；
   - approval/deny 不被绕过；
   - 取消信号可到达目标工具；
   - 不再出现直接 `.execute(` 调用目标定义的代码。

### Wave 3：当前会话工具面预览（P1）

修改目标：

- `src/shared/bridge-contract.ts`
- `src/runtime/settings-bridge.ts`
- `src/client/prompt-tool-bridge.ts`
- `src/client/prompt-tool-types.ts`
- `src/client/index.ts`
- `src/client/CustomToolsModuleCard.tsx`
- `test/shared/bridge-contract.test.mjs`
- `test/host/settings-bridge.test.mjs`
- `test/client/no-host-dom.test.mjs` 或现有 slot/client contract 测试

任务：

1. 新增只读 bridge endpoint，例如 `/tool-surface`。
2. Host 侧通过动态 `ctx.inject(['agents', 'tools'], ...)` 等待服务，不扩大静态 inject。
3. 请求只接受当前 session id；校验长度、类型和存活 Agent。
4. 从目标 Agent scope 获取 `tools.schemas(agent)`，响应只返回必要字段：

```ts
{
  tools: Array<{ name: string; description: string }>
}
```

5. Client 从官方 sessions snapshot 取得当前会话 id后请求；不把 session id 持久化进 settings。
6. 在现有自定义工具区增加只读折叠面板，支持刷新和搜索。
7. 保留 loopback、Host、Origin 和 body-size guard；无 Agent 或服务未就绪返回稳定错误码。

### Wave 4：文档与契约收口（P2）

修改目标：

- `docs/engine-reuse.md`
- `README.md`
- `PLAN.md`
- 受影响的模板注释

任务：

1. 记录 customTools 使用官方 Schema DSL，运行时转换为标准 ToolDefinition。
2. 明确 delegate 经官方工具管线，不是目标函数别名。
3. 删除“scope 已支持”的误导描述，标注为延期能力。
4. 记录工具面预览只代表当前运行会话，不代表未挂载预设。
5. 更新执行记录、测试数和最终提交信息。

## 五、文件级变更矩阵

| 文件 | 最小变更 | 验证 |
|---|---|---|
| `engine/tool-config-engine.mjs` | 官方 Schema 转换；delegate nested dispatch；显式拒绝 scope | 真实 ToolRuntime 契约测试 |
| `test/engine/tool-config-engine.test.mjs` | 从对象捕获测试补到真实 registry/execute 测试 | Node test runner |
| `src/shared/bridge-contract.ts` | 新增只读工具面端点常量与 payload 契约 | shared contract test |
| `src/runtime/settings-bridge.ts` | 动态等待 agents/tools；按 session 返回 schemas 摘要 | guard/error/success tests |
| `src/client/prompt-tool-bridge.ts` | 工具面响应解析 | 传输契约测试 |
| `src/client/prompt-tool-types.ts` | 最小 ToolSurface 类型 | typecheck |
| `src/client/index.ts` | 暴露当前 session id 或工具面读取能力 | client bundle contract |
| `src/client/CustomToolsModuleCard.tsx` | 只读列表、搜索、刷新、空态 | client/no-host-DOM tests |
| `README.md` / `docs/engine-reuse.md` | 更新工具定义、delegate 与运行态预览语义 | `git diff --check` |

## 六、验收标准

### ToolDefinition

- [ ] 无参数工具可出现在 `ctx.tools.schemas()` 中。
- [ ] 参数 DSL 被转换为标准 JSON Schema object。
- [ ] output DSL 被转换为 registry 可校验的 JSON Schema。
- [ ] 非法参数在执行前产生标准工具错误，工具实现不被调用。
- [ ] 非法成功输出被 registry 拒绝。
- [ ] 工具 disposer 随 preset/agent scope 生命周期撤销。

### Delegate

- [ ] 代码中不存在对目标 ToolDefinition 的直接 `execute()` 调用。
- [ ] nested call 经过 pre/execute/post 管线。
- [ ] approval、deny、timeout 和 cancellation 不被绕过。
- [ ] rootCallId / parent token 保持嵌套关系。
- [ ] additionalContexts / concludesTurn 能传回外层调用。
- [ ] 现有参数映射模板行为不变。

### 工具面预览

- [ ] 只返回当前存活会话实际可见工具。
- [ ] 不挂载或激活其他预设。
- [ ] 不把完整参数 Schema、大文本或 secrets 送往客户端。
- [ ] 无当前会话、未知 session、服务未就绪都有稳定错误载荷。
- [ ] 搜索只在客户端过滤，不增加请求频率。
- [ ] UI 仍只通过官方 SlotRegistry，不读取宿主 DOM。

### 架构边界

- [ ] `preset.yml` 仍是 customTools 单一来源。
- [ ] `agent.cordis.yml` 和 `custom-tools/*.yml` 仍是生成物。
- [ ] 不引入旧 `connection.api` / `dsh-client-runtime`。
- [ ] 不新增通用 preset/plugin JSON mutation。
- [ ] 不修改运行中的 DSH 服务或真实用户预设。

## 七、验证命令

所有测试 cwd 固定为 `D:\AI\workspase\_temp`：

```pwsh
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'

pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
```

开发循环可先运行：

```pwsh
node --test "$Repo/test/engine/tool-config-engine.test.mjs"
node --test "$Repo/test/host/settings-bridge.test.mjs"
node --test "$Repo/test/shared/bridge-contract.test.mjs"
```

最终仍运行完整 `pnpm --dir $Repo test`。

## 八、实施顺序与中断条件

1. Wave 1 先建立真实 ToolRuntime 红灯测试，再修定义转换。
2. Wave 2 在标准 ToolDefinition 稳定后改 delegate。
3. Wave 3 只读展示，不与 P0 修改交叉开发。
4. Wave 4 最后更新长期文档。

中断条件：

- 从 DSH 运行入口解析官方 `dsh-tools` 失败：停止扩大修改，先在隔离 `DSH_HOME` 查明模块解析方式。
- nested dispatch 无法完整传播上下文/终止语义：保留旧功能关闭 delegate 模板，不退回直接 execute。
- 工具面 endpoint 需要挂载未激活预设才能回答：取消该能力，只保留当前会话视图。
- 任一 Wave 破坏现有 preset 物化、主/子代理隔离或 disposer：停止后续 Wave，先修回归。

## 九、执行记录

- [x] 旧 L2 计划全部落地并从本文件移除。
- [x] 分析 `dsh-plugins` 工具与预设实现。
- [x] 对照 DSH `0.1.2-alpha.4` 当前 API。
- [x] 用真实 ToolRuntime 复现 customTools Schema 问题。
- [ ] Wave 1：ToolDefinition 标准化。
- [ ] Wave 2：delegate 统一走 ToolRuntime。
- [ ] Wave 3：当前会话工具面预览。
- [ ] Wave 4：文档与契约收口。
- [ ] 完整 typecheck / lint / test / build。
- [ ] 提交并推送 `origin/dev`。
