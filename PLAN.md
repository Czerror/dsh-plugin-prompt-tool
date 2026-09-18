# 导入导出模块化与统一 UI 实施

## 需求与授权

- 2026-09-18 用户明确“按照这份计划执行修改”，授权执行 [设计稿](.scratch/prompt-tool-framework/design-import-export-2026-09-18.md) 的 W1–W4，包括建议的覆盖、批次、记忆来源证明及依赖校验语义；无需重复征求实现许可。
- 基线：`dev@03b5e4c`，起始工作树干净。旧 PLAN 原文归档到 [归档](.scratch/prompt-tool-framework/archive/plan-before-import-export-03b5e4c-20260918.md)。
- 目标：原生与 ST JSON/YAML、PNG、文件夹和 ZIP 经统一识别／预览／确认；安装有完整验证及恢复；Web/CLI 共享可移植导出与身份规则；角色记忆和用户指令独立所有权不变。
- UI 沿用 DSH primitives、CSS Modules 与主题，落实 ui-skills 设计的来源、检查、结果、覆盖和导出范围流程。
- 完整 ZIP 与单独定义导出已获确认。角色库原生片段先支持自包含内容，文件引用明确拒绝；带附件的内容通过完整预设入口处理。

## 影响面、依赖与护栏

- `client → shared contract → runtime bridge → host source / package / characters / manifest / writer`；预览版本绑定字节、用户选择与目标版本。
- writer 与 manifest 先修源资产、ID 和目录安全；识别与角色更新并行；随后集成安装、ZIP 和 UI，最终完整验证。
- 主线程写 shared、runtime bridge、index 接线、ZIP/package、构建出口、依赖、文档与 PLAN；代理独占 writer/manifest、角色/识别、客户端及各自测试。并行期间不 build，不提交。
- 图谱脚本固定写 `.ai-memory/knowledge-graph`，与仓库禁止将图谱放入记忆目录的规则冲突，本轮以已审查调用图＋rg 全调用者复核替代；不执行该生成器。
- 所有编辑通过 apply_patch；shell 使用 PowerShell 7；测试和脚本 cwd 位于 `D:/AI/workspase/_temp`，合成临时 DSH_HOME。禁止改宿主、停止共享 DSH、改真实预设／角色资源。
- 不增加通用任务平台；受限上传暂存与预览句柄满足本次流程。未知／越界／超量／链接／过期请求零目标写入。

## Wave 1：数据边界

<task type="auto">
  <name>T1：预设身份、源资产和候选物化</name>
  <files>src/host/manifest.ts、write-preset.ts、预设安装 helper、相关 host 测试</files>
  <action>统一合法 ID 与根归属；复制同步定义身份；正文与自有 engine 保留；去掉兄弟清理；提供不触碰共享引擎和不原地覆盖的候选物化入口。</action>
  <verify>数据风险回归先红后绿；真实 writer 保留正文、PNG、模块与兄弟目录；ID 越界、链接及 rename 故障拒绝。</verify>
  <security>根内 canonical 路径、无无主清理、旧目录恢复、Windows 占用不退化为破坏性安装。</security>
  <done>F01/F05/F06 的共享根因闭合，候选入口可用于导入。</done>
</task>

<task type="auto">
  <name>T2：角色来源与长期记忆独立</name>
  <files>src/host/characters.ts、PNG helper、相关角色测试</files>
  <action>来源更新保留记忆、未知文件和未替换头像；原生片段保留合法自包含配置；自动记忆使用无冲突 ID 和可核验来源记录。</action>
  <verify>JSON/PNG/YAML 重导入记忆字节不变；普通 memory ID 不被覆盖；真实应用计数、来源版本和错误恢复。</verify>
  <security>不把同名导入当成删除记忆授权；不可读取目标不能当作目标不存在。</security>
  <done>F02/F10/F13 与记忆导出证明可用。</done>
</task>

## Wave 2：统一识别、预览与提交

<task type="auto">
  <name>T3：字节来源和识别</name>
  <files>src/shared/asset-transfer.ts、bridge-contract.ts、src/host/import-source.ts、preview-revision.ts、源暂存与相关测试</files>
  <action>显式编码、内容判别、唯一根与候选；复用 ST 转换及 PNG 解码；原始流只暂存；转换／目标／覆盖模式均绑定预览版本。</action>
  <verify>格式矩阵、PNG 字节、未知形状、附件不参与识别、枚举顺序、大小及路径边界。</verify>
  <security>有界读取／解压、编码校验、句柄不授予目标写权限。</security>
  <done>所有载体具有同源预览，取消零提交。</done>
</task>

<task type="auto">
  <name>T4：安装事务与桥接接线</name>
  <files>src/host/preset-package.ts、src/runtime/settings-bridge.ts、src/index.ts、shared/runtime/host 测试</files>
  <action>复用候选验证和物化，版本复检后交换目标；错误传播；区分安装结果与刷新失败；把业务规则从 bridge 下沉。</action>
  <verify>坏工具／配置拒绝、候选附件正确定位、物化／交换／恢复故障、旧页面冲突与读失败。</verify>
  <security>白名单、Host/Origin、统一失败载荷及请求体上限保留。</security>
  <done>F03/F04/F07/F11/F12/F14/F16 闭合。</done>
</task>

## Wave 3：可移植导出

<task type="auto">
  <name>T5：ZIP、定义与 CLI 共用资源规则</name>
  <files>src/host/preset-package.ts、scripts/export-preset.mjs、构建出口、ZIP 依赖及包测试</files>
  <action>收集权威定义及自有资源；保留复制身份；ZIP 清单验证；两种分享出口排除有证明的自动记忆，历史歧义要求明确选择。</action>
  <verify>另一临时 DSH_HOME 真实导入／物化；正文与附件哈希；新旧根共存；ZIP 越界／碰撞／超限；源目录不变。</verify>
  <security>指令正文／策略、角色记忆文件、技能库不进入包；不复制共享引擎或根外资源。</security>
  <done>F08/F09 及完整往返通过，Web/CLI 同源。</done>
</task>

## Wave 4：客户端与交付

<task type="auto">
  <name>T6：共用导入面板、覆盖与导出范围</name>
  <files>src/client/data、预设/角色 feature、共享导入 UI、CSS、locale、client 测试</files>
  <action>读取纳入状态机，文件/文件夹选择、目标与资源摘要、选组、覆盖确认、批次跳过/结束、过期重预览、成功后显式切换；ZIP/定义导出范围与依赖提示。</action>
  <verify>真实 Edge 文件输入、PNG、大文件、失败与过期、键盘焦点、明暗/窄屏、卸载不提交下一项。</verify>
  <security>文本转义、焦点陷阱复用、UI 不自授权、危险覆盖明确目标。</security>
  <done>新 UI 接入实际 host 行为，无第二套状态或主题。</done>
</task>

<task type="auto">
  <name>T7：稳定文档、完整门禁与交付</name>
  <files>README、docs/ui-architecture.md、SillyTavern.md、architecture-params.md、CHANGELOG、PLAN</files>
  <action>同步最终行为与限制；复核所有代理产出；生成分发快照；只提交任务文件并推送 origin/dev。</action>
  <verify>typecheck、lint、完整 test、build、diff --check；需要时 verify:host；临时数据清理。</verify>
  <security>本地记忆不提交；不重启运行中 DSH；不改 main。</security>
  <done>全部门禁通过，交付 SHA、分支与用户重启说明。</done>
</task>

## 回滚与检查点

- 每个目标在同文件系统暂存完整新目录；失败恢复该目标旧目录，恢复失败保留可定位备份。共享引擎与兄弟预设不属于导入清理范围。
- Git 回滚仅回代码，不回滚用户后续数据。保留格式适配，不用数据全量重写作为迁移。
- Wave 检查点记录本 PLAN；较长中断摘要写 `.scratch/prompt-tool-framework/`，不把流程产物放 `.ai-memory`。
- 验证命令均从临时 cwd：`pnpm --dir $Repo typecheck`、`lint`、`test`、`build`；`git -C $Repo diff --check`。

## 状态

- [✔] 已取得完整执行授权，核对基线与工作树，原文归档旧 PLAN。
- [✔] W1 / T1：身份、源资产与候选物化；复制和另存同步自有 templateFile 引用。
- [✔] W1 / T2：角色、记忆、头像与未知文件所有权；并发和恢复故障回归。
- [✔] W2 / T3：原生/ST/PNG/YAML 识别、单次剥根、显式字节与预览版本。
- [✔] W2 / T4：原始上传暂存、完整安装与桥接；提交结果和刷新结果分开。
- [✔] W3 / T5：ZIP、定义、CLI 文件夹出口；当前根优先与跨目录往返。
- [✔] W4 / T6：实际 UI、双语、覆盖确认、过期／批次控制和真实 Edge 验证。
- [✔] W4 / T7：完整门禁与稳定文档已验证；提交 SHA 与推送结果以本轮最终交付和 Git 历史为准。

## 验收记录

- 证据类型：命令及退出码、Node 行为测试、真实 Edge 交互与截图检查。
- `pnpm --dir $Repo typecheck`：通过；`lint`：0 错误、0 警告。
- `pnpm --dir $Repo test`：**1119/1119，通过；0 失败、0 跳过**。包含已发布 CLI 三种出口、字节往返、事务故障、角色记忆、路径边界及浏览器交互。
- `pnpm --dir $Repo build`：通过；新增 `lib/preset-transfer.mjs` 供 CLI 共用，lib 不提交。
- `rebuild:composition` 使用固定 `test/fixtures/dsh/current`：重建 24 个官方模块，19 个本地来源保留；`sync:yaml` 重放 yaml@2.9.0；两个版本化快照目录无内容漂移。
- `verify:host`：51 项官方包契约检查，失败 0；`git diff --check` 通过。
- 真实 Edge 定向 27 项通过（其中浏览器条目 14 项），包括实际 CSS、320px、键盘焦点与 reduced-motion；另查看 1280px 截图。未连接用户运行中的 DSH。
- 归档 Git blob 与旧 PLAN 一致：`fbb4a06d8e441f4923043195a345081349b7d16d`。

## 实施取舍与已知边界

- ZIP 采用 `@zip.js/zip.js@2.15.0`（BSD-3-Clause），复用条目属性、流式有界解压与 CRC 校验；未保留最初考虑的 fflate。
- 模块按职责拆为来源识别、PNG 解码、字节暂存、ZIP 载体、预设交换和目录身份，复用原 writer／角色持久化；未建立 service/repository 或格式 registry。
- 保留既有无 ID 行为：单个原生 preset.yml 回退 imported-preset，官方目录定义可从文件夹名获得身份。多个定义和未知对象仍拒绝。
- 收紧身份校验后，将旧测试夹具的随机大小写目录／固定 ID 改为一致合法身份；未放宽生产路径约束。共享选择器改用既有 MenuSelect。
- 自包含角色片段支持 text/texts/控制配置；角色附件引用明确拒绝。任意用户 JS 动态路径的依赖完整性无法静态证明，见资产交换文档。
- 生效：依赖、宿主和客户端 bundle 已更新，**需要用户重启 DSH 服务后生效**；不要求重新链接 profile。已有预设由正常加载／重建通道更新，未对真实用户预设批量写盘。

## 测试现场与清理限制

- 一次旧 ST 测试的静态导入先于临时 DSH_HOME，曾在默认预设根生成 `demo`、`rev`、`one-two` 三个合成预设。已核对创建时间与内容后移入隔离恢复目录；未覆盖既有目标。已修正为设置隔离环境后动态导入，主线程复检默认根中三项均不存在。
- 自动审批拒绝临时目录及截图删除，原因仅为 `blocked by policy`；不通过其他通道绕过。残留如下，业务回归均已通过：
  - `D:/AI/workspase/_temp/pt-st-preview-recovery-20260918-172732`（上述三个合成预设）。
  - 系统 Temp 下 `pt-chara-home-118jYG`、`pt-chara-home-yxpWUB`、`pt-chara-open-4scnKY`、`pt-chara-open-jVAhu5`、`pt-chara-root-SzvPFt`、`pt-chara-root-tAcyBu`。
  - `D:/AI/workspase/_temp/pt-import-20260918.png`（本轮 UI 验证截图）。
- 其余本轮新测试通过自身 teardown 清理；最终全量测试使用隔离 TEMP/TMP 与 DSH_HOME，未停止或重启用户 DSH。
