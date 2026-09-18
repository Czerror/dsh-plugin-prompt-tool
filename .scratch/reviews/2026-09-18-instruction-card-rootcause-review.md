# 指令文件卡根因审查——独立复核报告

- **审查日期**：2026-09-18
- **审查方式**：`dev-expert`（代码审查）+ `open-code-review-delegate`（OCR v1.12.5 委派模式）
- **被复核对象**：`C:\Users\Cz9nl\Desktop\指令文件模块卡无法创建-根因审查-20260918.md`
- **审查基线**：`dev@0dbce47`，工作树干净
- **结论**：被复核报告的根因判定**成立**；但它遗漏了使该缺陷成立的机制，以及一处同类受害点。

## 一、审查范围与方法

OCR `delegate preview` 的 workspace 模式返回 `total_files: 0`（工作树干净）；`--from 11a9e73 --to HEAD` 有 282 个可审文件，与本次根因无关；本 BUG 所在的 `src/client/index.ts` 与 `src/client/data/session-model-face.ts` 自引入点 `11a9e73` 起**从未改动**，没有 diff 可审。

因此按 delegate 对「未跟踪文件即全文新代码」的同一处理：以 **OCR `delegate rule` 解析出的系统规则**（拼写／死代码／代码质量／React／异步／安全）为检查清单，对被审查文件做全文审查。规则获取命令：

```
ocr delegate rule --format json --repo <repo> src/client/index.ts src/client/data/session-model-face.ts \
  src/client/data/use-prompt-tool-store.ts src/runtime/settings-bridge.ts \
  src/shared/bridge-contract.ts test/host/instruction-scope-guard.test.mjs
```

### 覆盖清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `src/client/index.ts` | reviewed | 全文 108 行 |
| `src/client/data/session-model-face.ts` | reviewed | 全文 108 行 |
| `src/runtime/settings-bridge.ts` | reviewed | 根因链路段 275–359 行（全文 2272 行） |
| `src/client/data/use-prompt-tool-store.ts` | reviewed | 会话 id 使用段 405–444 行（全文 1167 行） |
| `test/host/instruction-scope-guard.test.mjs` | reviewed | 全文 179 行 |
| `src/shared/bridge-contract.ts` | skipped | 理由：契约定义文件，与本根因链路无调用关系；其 +189 行变更属导入导出载具契约 |

覆盖率：reviewed 5 / 6，skipped 1（有理由）。

## 二、对原报告的复核结论

| 原报告结论 | 复核结果 | 证据 |
|---|---|---|
| 官方删除 `SessionListState.current` | **成立** | alpha.2 类型 `sessions/service.d.ts:42-56` 仅 `ids／byId／phase／subagentsByParent／jobsBySession` |
| 客户端取值恒 `undefined` | **成立** | `src/client/index.ts:54` 读 `.current`；alpha.2 运行时无该字段 |
| 宿主降级 `global-only` | **成立** | `src/runtime/settings-bridge.ts:337-344` |
| 插件侧 `11a9e73` 放大为硬失败 | **成立** | 该提交删除 `writePreset` 的文件卡物化，改由客户端 id 驱动 |
| 仅三处受害 | **不成立** | 漏 `src/client/data/session-model-face.ts:102` |
| 官方 `0.1.6-alpha.2` 无 `current` | **成立** | profile 实装 alpha.2 |

## 三、问题清单

### Critical-1：开发依赖与运行时版本漂移，`typecheck` 永久假绿

- **位置**：`package.json`（devDependencies `@deepseek-ai/dsh-api-session-controller: 0.1.6-alpha.1`）
- **类别**：bug ｜ **严重度**：critical
- **事实**：
  - 本仓库 `node_modules` = `0.1.6-alpha.1`（`pnpm why` 显示来自 devDependencies），其 `service.d.ts:66` **有** `current: SessionId | undefined`；
  - 真实 DSH profile（`D:\AI\DeepSeek harness\.dsh\profiles\node_modules`）= `0.1.6-alpha.2`，其同名接口**已删** `current`；
  - `pnpm typecheck` **exit 0**。
- **影响**：编译期看到的是「有 `current`」的旧世界，运行期是「没有」的新世界。类型检查、lint、单元测试全部无法发现此类漂移；任何依赖官方快照形状的插件代码都可能静默失效。**这是原报告未提及的机制层缺陷，只修客户端取值无法防止复发。**
- **修复方向**：devDependencies 对齐运行时实装版本，并把「类型版本 = 宿主实装版本」纳入升级流程校验。

### Critical-2：客户端读取已被删除的字段

- **位置**：`src/client/index.ts:54`、`:84`；`src/client/data/session-model-face.ts:24`、`:59`、`:82`、`:102`
- **类别**：bug ｜ **严重度**：critical
- **原报告已列**：`index.ts:54`（指令文件）、`index.ts:84`（switchPreset）、`session-model-face.ts:59`／`:82`（模型投影）
- **本次新增**：
  - `session-model-face.ts:102` —— `select()` 内同样读 `current`，恒抛 `当前没有活动会话`，模型选择写入路径一并失效；
  - `session-model-face.ts:24` —— `SessionModelSessionsLike.list: SnapshotLike<{ current: string | undefined }>` 用**插件自造的结构类型**把 `current` 写死。它不随官方类型演进而变，等于把漂移固化进插件自己的契约，是漂移被掩盖的第二层原因。
- **影响**：工作区指令文件卡不可见、不可写；模型选择卡 `selectable` 恒 false 且写入必失败；`switchPreset` 恒返回 `{ applied: false }`。

### High-3：宿主侧静默降级，无来源告警

- **位置**：`src/runtime/settings-bridge.ts:336-348`
- **类别**：bug ｜ **严重度**：high
- **问题**：`sessionId === undefined` 时 `localAgentCwd` 不执行，直接 `detectAgentsFiles({ projects: false })`，返回 `source: 'global-only'`，不区分「调用方没给 id」与「id 查不到工作区」。
- **影响**：id 异常时工作区卡凭空消失且无任何提示，用户与开发者都只能看到「少了一张卡」。

### Medium-4：回归覆盖缺口

- **位置**：`test/host/instruction-scope-guard.test.mjs:52-90`、`:176-178`
- **类别**：test ｜ **严重度**：medium
- **问题**：`makeHarness` 以 `cwdBySession` 自造假 harness，测试直接传 `session-a`／`session-b`，从不经过客户端取值环节；`:177` 还主动断言「未知会话 → `global-only`」。
- **说明**：`:177` 断言的是**正确的设计意图**（不借用别的会话工作区），它本身不是缺陷；缺口在于没有任何用例覆盖「客户端会传什么 id」，因此官方删字段时测试不会红。

### Karpathy 建议

`session-model-face.ts:24` 的自造结构类型超出了「最小依赖面」的合理用途——它同时承担了「解耦官方类型」与「声明官方字段」两个互相冲突的职责。建议只声明实际用到的方法签名，字段形状交给官方类型，让类型检查重新具备发现漂移的能力。

## 四、审查总结

- **整体评分**：58/100（缺陷本身清楚，但掩盖机制未被识别）
- **主要风险**：类型与运行时漂移使所有静态门禁失去意义，同类缺陷会以「绿灯 + 运行时静默降级」的形式反复出现
- **优先修复**：Critical-1（依赖对齐）→ Critical-2（客户端取值）→ High-3（宿主兜底）
- **正向评价**：原报告的实机探测方法（对比传／不传正确 id 的行为差异）是决定性的，根因链路描述准确；宿主侧的写盘白名单、越界符号链接防护、跨会话上下文 409 等防护经复核均健全，未发现安全问题

## 五、对本轮 PLAN 的影响

`.scratch/plan/2026-09-18-plan-client-session-id-0dbce47.md` 的问题定义与 T1–T5 仍然有效，但需补充：

1. **新增依赖对齐任务**（Critical-1）：否则 T3 改完客户端取值，其他依赖官方快照的代码仍处在假绿状态。
2. **T3 范围扩到四处**：原 PLAN 写「替换三处失效取值」，应含 `session-model-face.ts:102` 与 `:24` 的类型声明。
3. **T2 的红灯用例应加一条版本断言**：断言插件声明的官方快照形状与宿主实装类型一致，把 Critical-1 纳入防复发范围。

## 六、残余风险

- 未做浏览器抓包，「GUI 是否真的没发送 sessionId」仍由类型缺失 + bridge 行为差异推断；修复后以 PLAN 的 T5 实测取代。
- alpha.2 下官方可用的「当前会话」读取途径尚未穷尽（`ISessions` 对外仅暴露 `open`／`clear`／`scopeOf`／`sessionOf` 等，未含直接读取当前选中项的接口），需由 PLAN 的 T1 核实。
- 本报告基于 2026-09-18 的仓库与 profile 状态；官方包升级后需重新核对。
