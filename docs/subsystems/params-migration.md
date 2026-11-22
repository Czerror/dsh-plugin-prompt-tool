# 旧格式转换与模块私有数据导入

## 旧格式与显式转换
新内部上下文、变量、工具和人设字段不双读：world-book/stWorldBook/stWorldBookRecursive/stMacros/stSource、动作局部变量、旧工具能力以及全部顶层 persona、config.yml.personaSources 均在读取根拒绝，需用户手工重建人设规则并移除旧字段。外部 ST 标准别名仍由 adapter 识别。

其它历史快捷参数按共享白名单读取，未登记值不参与执行；旧快捷键写入拒绝。不能因此推断任意旧模块可运行，更不能把被拒绝的本次退役字段当普通未知元数据略过。完整边界以 load/compile/save 的实际错误为准。

旧私有记忆/角色来源标记阻止原生分享与导入；不能删掉标记后发出潜在记忆。先备份并明确拆分私有 memory.md 和可分享规则，再由用户授权转换。未知附件保留，不清理旧用户目录。

## 模块私有数据预览与导入

用户在 Web 或 TUI 执行 `/prompt-tool data-import <JSON>`。目标必须是已安装的用户模块，每次显式传 `moduleId`；来源根由用户选择，`paths` 逐个指定根下普通文件，不递归扫描。以下示例的 `your_module_id` 均替换为实际目标模块 ID。

```text
/prompt-tool data-import {"moduleId":"your_module_id","sourceDirectory":"D:/my-data","paths":["notes.jsonl","rules.md"]}
```

预览返回 `revision` 和 `entries`，每项有目标路径与 `create`、`skip` 或 `conflict` 状态，预览不写盘。确认后保持原请求不变，加上 `"expectedRevision":"<预览返回的 revision>"` 再执行。只创建缺失项；同内容项跳过，冲突项报告并保留目标，不提供隐式覆盖。来源内容、选择范围或整个目标目录在预览后发生变化均拒绝应用，须重新预览。

目标统一落在模块的 `data/`。来源根下的旧名 `02-墨.jsonl` 集中映射为 `data/02-soul.jsonl`；目标已存在旧账本时拒绝生成第二份账本，须先明确处理旧数据。原始来源始终保留。路径越界、链接、非普通文件、非法 UTF-8、单文件超过 8 MiB、总量超过 64 MiB 或条目超过 2048 个均拒绝。

初始化使用 `{"moduleId":"your_module_id","initialize":true}` 选择目标模块 `assets/manifest.yml` 的目录与模板文件，同样先预览再带 `expectedRevision` 应用，不能同时给外部来源。只补缺失，不覆盖已修改模板；不凭空创建清单 `checks` 中的文件，检查通过也不等于初始化完成。`data/AGENTS.md` 是模块私有资产，不是工作区指令文件。

`host/module-data-import.ts` 统一拥有预览与应用；完整候选在现有模块目录事务中生成，锁内复核版本后交换，准备失败保留原目录。默认模块导出仍排除整个 `data/`。这条显式命令不会改变 `module_manifest` 既有的 next/check/apply 语义。check 本身保持只读且实时检查；规则条件 `manifest: { ok: boolean }` 通过 `src/host/module-manifest-check.ts` 单独缓存结果 1000ms，manifest 的 mtime/size 变化提前失效，到期后首次求值完整重检。显式 check 不刷新规则缓存，也不写变量。独立 rule-engine 入口不提供该读取器；三值与入口契约见 [引擎复用](engine-rules.md#规则条件与动作边界)。

分享与整模块安装的包选择、预览和确认见[资产交换](../asset-transfer.md)。
