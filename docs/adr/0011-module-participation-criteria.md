# 模块参与判据：唯一真值源与按用途分的三个问题

状态：已采纳，2026-10-10。

## 决策

**「一个模块是否参与」只有一个真值源**：存储根 `config.yml` 的启用表（`schemaVersion: 3` 的 `enabled` 列表）。`src/host/config-store.ts` 的 `enabledModuleIds()` 是它**唯一**的读取口，客户端不另立一份真相——它用的是 `/bootstrap` 下发的 `meta.modules[].enabled`，那是启用表的**副本**。

**判据按用途分，不合并成一个入口。** 四个消费者问的是三个不同的问题：

| 消费者 | 判据 | 它问的问题 | 为什么不合并 |
|---|---|---|---|
| 运行时装配（`src/index.ts` 的 `enabledModules`） | **总闸** && `enabledModuleIds()` && 模块目录存在 | 这个模块**现在参与装配吗** | 总闸是运行开关，不是「模块是否存在」；关掉它只是不装配 |
| 跨模块排序（`src/host/module-config-order.ts` 的 `readInputs`） | `enabledModuleIds()` | 已启用模块之间**怎么排** | 排序定义的编辑不该被总闸牵连 |
| 规则卡准入（`src/client/features/prompts/RulesWorkspace.tsx` 的 `owners`） | `meta.modules[].enabled`（启用表副本） | 这张卡**给不给编辑** | 用户 2026-10-10 拍板：启用表是第一优先级，其次才是 `_settings.yml` 与 `rules/*.yml` |
| 编辑通道（`src/runtime/settings-bridge.ts` 的 `/rules` 端点） | **不查启用** | 我**能不能读写**这个模块的定义 | 保留「先把模块写好、再启用」的能力 |

**模块与配置的身份同样只有一处**：`src/shared/module-config-order.ts` 的 `configIdentityKey({ moduleId, configId })` —— 规则区的卡、排序条目与运行时的 `promptConfigs` 共用它，所以「卡的身份链路」不会分叉。

**模块目录身份不是一张登记表，而是写死的路径结构**：`<modulesRoot>/<id>/` 加上 `module.yml` 的 `id`，由 `assertModuleDirectory` 强制两者一致（并拒绝符号链接、越界与大小写混淆）——它是那个约定的**执行者**，不是身份的载体。全仓没有 id→路径 的映射：定位一律 `join(root, id)`，唯一的 `moduleSpecCache` 也以**定义文件路径**为键。因此**身份含根**——不同根下的同一个 id 是**两个身份**（包内模板与用户副本一直如此），不构成冲突；反过来，「根传错」得到的是「操作到另一个身份」，属参数归属问题，不是身份冲突。

## 取舍

- **不引入 `isModuleActive()` 之类的统一判据**：表里那三个问题的答案本就不同，合并的结果只能是加参数区分（等于没统一），或者删掉「总闸关闭仍可改排序定义」这条既有行为。
- **总闸刻意不进 UI 的可见性**：`docs/ui-architecture.md` 的配置排序一节写明「模块启用或停用均可保存自身排序，**总闸关闭仍可改排序定义**」。规则区对总闸的反馈是**只读**（`RulesWorkspace` 的 `readOnly` 读 `fields.modulesEnabled`），不是隐藏。
- **一致性来自真值源唯一，不来自入口唯一**：客户端拿的是服务端下发的副本，两侧不会各自解释「启用」的含义。
- **卡片准入与编辑通道的差异是设计**：前者按启用表收窄，后者保留（编辑未启用模块是准备动作）。这两处看起来「不一致」，但回答的是不同问题。

## 后续

- 新增消费者时，先回答「它在问这三个问题里的哪一个」，并在上表登记；**不要**因为「别处已经有判据」就直接复用。
- 卡片准入的收窄（2026-10-10，提交 `c35b93bc`）带来的结果：未启用模块不出卡、不发 `/rules`；要编辑它的规则，先在「模块」页启用。
- 真值源若将来变化（例如启用表增列），只需改 `enabledModuleIds()` 与 `/bootstrap` 的下发，四个消费者不动。

## 与历史决策的关系

- [ADR-0008](0008-module-slices-memory-assembly.md) 的模块切片与内存装配不变：本 ADR 只规定「谁按什么判据决定参与」，不改写盘与装配机制。
- [ADR-0010](0010-two-history-views.md) 管的是会话历史的视图归属，与模块参与无关。
- `docs/ui-architecture.md` 的模块列表与配置排序两节是本 ADR 的事实依据。
