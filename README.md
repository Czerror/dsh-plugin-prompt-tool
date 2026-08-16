# 提示词工具（dsh-plugin-prompt-tool）

DSH 插件：为 DeepSeek Harness 提供三层提示词规范注入，并通过 Web 界面在线编辑。核心是“最优组合”首轮锚定：保持官方 Minimal（极简）训练分布的首轮条件，在模型轨迹稳定后再恢复完整能力。

## 来源与参考

| 项目 | 关系 | 复用内容 |
|---|---|---|
| [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) | 上游，内联快照 | 两阶段首轮锚定、tool-bootstrap、context-gate、resident 目录与按需解锁 |
| [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) | 参考 | 首轮结构、追加任务引导、Flash 弱路由人设与三锚、子代理方案 |
| [yjh051108/dsh-super-injector](https://github.com/yjh051108/dsh-super-injector) | 参考 | 缓存铁律、工具面成本原则 |

上游文件固化在 `upstream/dsh-anchored-standard/`（含 `LICENSE`、`NOTICE`、`REVISION`），
用 `pnpm sync:anchored` 更新。

## 项目说明

- **常驻层**：把 `AGENTS.md` 作为受管块写入 `~/.dsh/AGENTS.md`；开启 `injectAgentsPrompt` 时，以 `instruction-hint` 的位置每会话注入一次。
- **按需层**：扫描 `skills/*/SKILL.md` 注册可开关技能，内容只来自技能自身。
- **锚定层**：生成独立的 `~/.dsh/.agent-presets/prompt-tool/` 预设，承载首轮工具引导、上下文闸门、任务引导注入与提示词注入。
- **Web 界面**：自建回环设置桥，在线编辑 `preset.md` 与 `AGENTS.md`，切换全部开关；不占用模型设置区。
- **TUI（终端界面）命令**：`/prompt-tool status` 查看状态，`/prompt-tool on|off|toggle <开关>` 切换。
- **上游管理**：上游 dsh-anchored-standard 以内联快照形式放在 `upstream/`，`pnpm sync:anchored` 刷新；不再使用 git 子模块。

## 构建 / 装载

```sh
pnpm install
pnpm build          # 生成 lib/
pnpm typecheck      # Host 与 Client 两个 tsc program
pnpm lint           # oxlint
pnpm test           # pnpm build + node --test
pnpm prepare        # npm publish / git install 前自动触发
pnpm sync:anchored  # 从上游 main 刷新内联快照（可加 ref 参数）
```

本插件挂载在独立 profile（`prompt-tool`）：

```sh
dsh plugin --profile prompt-tool add link:<本仓库绝对路径>
dsh --profile prompt-tool
dsh plugin --profile prompt-tool remove dsh-plugin-prompt-tool
```

临时调试可用官方 `--patch` 覆盖层（不落盘、不改 profile）：

```sh
dsh --profile prompt-tool --patch <cordis.yml>
```

完全重启 dsh 后，新建会话并选择 prompt-tool 预设。

## 原理

模型的首轮请求结构决定整条会话轨迹。上游实测：官方 Minimal 首轮（训练原句 + 持久 `bash` + `str_replace_editor`，无输出封顶）稳定锚定 we 轨迹；完整 Standard 目录与自动注入在场会破坏锚定。

本插件把“首轮轨迹选择”和“后续完整能力”拆开：

1. **干净首轮**：`context-gate` 清空首轮自动上下文并剥离自动注入；`tool-bootstrap` 只暴露 Minimal 两个工具；`router-first-turn` 把 persona 替换为训练原句。
2. **晋升**：首次工具调用或助手回复落地后，目录进入 resident（常驻）集，上下文与注入恢复；工具按需解锁。
3. **追加任务引导**：可选 `near-anchor`，在首条真实用户消息之后追加一次引导——默认按任务自动选择 we/let 首句，也可固定使用自定义文本。
4. **提示词注入**：we 锚定确认后，把 `preset.md` 作为用户消息注入一次；未确认最多等一轮兜底。
5. **子代理**：目录直接全量放行（实际仍受调用方工具白名单过滤）；开启 `subagentFlash` 时，采用 dsh-router-standard 的 Flash 方案——固定 Flash 路由、任务分类人设与三锚。

主会话首轮始终只有两个工具；模型性能不受记忆、技能等自动注入影响，完整能力在轨迹稳定后恢复。

## 配置参考

挂载配置（cordis.patch.yml / profile patch）：

```yaml
- insert:
    - id: prompt-tool
      name: dsh-plugin-prompt-tool
      config:
        text: ''            # 覆盖 preset.md 文本；默认读项目文件
        agentsText: ''      # 覆盖 AGENTS.md 文本；默认读项目文件
        injectAgentsPrompt: false  # 用 AGENTS.md 替换 instruction-hint 提示文本
        writeAgents: true   # 写 ~/.dsh/AGENTS.md 受管块（默认 true）
        writePreset: true   # 启用锚定预设（总开关，默认 true）
        injectPrompt: true  # we 确认后注入 preset.md（默认 true）
        skillSwitches: {}   # 按 skills/* 目录名开关，未列出默认开启
        anchorFirstTurn: false  # 追加任务引导（默认关闭）
        anchorText: ''      # 自定义引导文本
        anchorCustom: false # 使用自定义引导（true=固定使用 anchorText；false=自动选择）
        subagentFlash: false    # 子代理固定 Flash 模型（默认关闭）
        subagentFlashProvider: 'deepseek-official'
        subagentFlashModel: 'deepseek-v4-flash'
        customBashPath: 'bash.exe'  # 自定义 bash 路径（默认 PATH 查找）
        skillsDir: ''       # 可选技能目录（默认包内 skills/）
        skillRankBase: 250  # 技能候选排序基数
        residentAgentsPath: ''  # 默认 ~/.dsh/AGENTS.md
        presetDir: ''       # 默认 ~/.dsh/.agent-presets/prompt-tool/
        presetOrder: 5      # preset 显示顺序
        fallbackText: ''    # preset.md 缺失或不可读时的回退文本
```

字段说明：

- **启用锚定预设**：总开关。开启时生成并刷新 `~/.dsh/.agent-presets/prompt-tool/`；关闭时移除已生成目录，锚定相关开关失效。
- **追加任务引导**：开启时挂载 `near-anchor`，在首条真实用户消息后追加一次任务引导。
- **使用自定义引导**：开启时固定使用 `anchorText`；关闭时按任务自动选择 we/let 引导，Flash 模型附加三锚。开启且文本为空时不注入。
- **子代理固定 Flash 模型**：开启时采用 dsh-router-standard 的 Flash 子代理方案——通用子代理行加固定 Flash 路由、任务分类人设与三锚；宿主直派子代理（含 dsh-mnemon）自动补 Flash 路由，调用方显式模型优先。检测不到 DeepSeek 模型路由时 Web/TUI 禁用，且运行时强制降级为关闭。
- **自定义 bash 路径**：上游若带作者机器固定路径，生成 preset 时归一化为该值，默认 PATH 查找 `bash.exe`。
- 其他字段语义见上方配置注释；设置文件优先级高于挂载配置，首次安装时用项目文件内容初始化设置。

## 版权

本项目采用 MIT 许可证。

- 首轮锚定机制源自 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)（MIT），其 `preset/` 快照内联于本仓库 `upstream/`，对应上游提交记录见 `REVISION`。
- 任务引导与 Flash 子代理方案参考 [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)（MIT）。
- 缓存与工具面成本原则参考 [yjh051108/dsh-super-injector](https://github.com/yjh051108/dsh-super-injector)（MIT）。
- 上游 `agent.cordis.yml` 基于 DeepSeek Harness Standard 预设修改；原始 DeepSeek 版权与 MIT 声明保留在 `upstream/dsh-anchored-standard/NOTICE` 与 `LICENSE`。
- 本项目 `LICENSE` 见仓库根目录；随上游快照发布的 `upstream/dsh-anchored-standard/LICENSE` 与 `NOTICE` 继续保留。
