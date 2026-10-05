# 完整定义提交、规则切片与内存配装

状态：已采纳，2026-10-04。

## 决策

module.yml 保存一个模块的完整规则、参数与能力定义，是唯一持久化提交点和恢复依据。UI 自动保存和直接手改完整文件是两条支持的编辑路径。规则正文分解到 rules/<id>.yml，状态放 _settings.yml 的 rules 映射，模块变量放 variables.yml。切片及清单只在完整性校验通过后发布给 UI 和运行时；缺件、摘要失配、手改切片或伪造清单均从有效完整定义单向恢复。完整定义无效则报错。

同模块保存和恢复串行。正文／变量切片先写，module.yml 原子替换成为提交点，随后更新清单并校验发布。多次文件替换不宣称物理同时原子。提交前失败恢复旧定义对应切片；提交后发布持续失败以 persisted 响应说明已落盘状态，保留最后已验证运行贡献。每条规则正文、共享状态和变量各有 revision；操作只校验自己读写的版本，正文编辑不覆盖并发状态。

运行配装直接编译校验后的规则，内联编译后的 customTools 和 subagentToolPolicy。不再生成 configs/、rules.yml、agent.cordis.yml、custom-tools/、subagent-tools/。独立引擎保留缺字段时的文件入口；内联空值与非法值不得回落。工具资源根改名为 resourceRoot，兼容旧输入且保持原允许范围。

角色卡只是一种导入来源：转为普通 modules/<id>/，没有 character- 前缀目录、.characters 库或新角色专属登记。导入、更新和冲突复用模块机制，更新保留用户记忆、未知资产与未替换头像。模块 memory.md 由世界书工具按需读取，note 追加记忆；存在记忆文件不会自动新增规则或注入。

插件自有身份和端点使用 module 命名，运行总闸使用 modulesEnabled。旧名只在明确输入／公开 API 兼容边界归一，冲突拒绝；宿主官方 preset 和外部格式仍保留真实术语。

## 取舍

完整定义和规则切片保存两种表示，以完整定义的提交点和摘要验证建立唯一恢复方向。收益是保留可交换单文件、局部 UI 版本与确定运行快照；代价是保存需完成切片发布，故失败载荷必须区分提交前后。无需 pending 文件、多版本仲裁或猜测手改切片归属。普通重建原地校验与清理已知旧产物，导入候选仍完整验证后目录交换。

## 与历史决策的关系

- 承接 [ADR-0001](0001-preset-definition-is-authoritative.md) 的完整定义所有权，替代其宿主可发现预设物化方式。
- 承接 [ADR-0005](0005-preset-to-module.md) 的 Agent scope 装配与模块身份，替代角色库并存、configs 回退和角色记忆自动同步。
- 保留 [ADR-0006](0006-module-config-order.md) 的模块＋规则身份与 configOrder 语义，文件序号前缀由 settings.order 替代。
- 保留 [ADR-0007](0007-unified-condition-action-rules.md) 的条件树与动作数组、动作身份、互斥与执行算法（字段名此后更新为 `if`/`then`/`else`，见该 ADR 的状态注记）；磁盘分解不放宽引擎规则字段。

格式、恢复及版本协议见 [后端框架](../architecture-params.md)，导入资产与分享边界见 [资产交换](../asset-transfer.md)。
