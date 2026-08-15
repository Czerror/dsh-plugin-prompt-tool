# 提示词工具（dsh-plugin-prompt-tool）

DSH 插件：把简体中文行为规范注入三层（常驻层 + 按需技能层 + agent preset 锚定注入层），并提供 Web UI 在线编辑 `prompt.md`。完整集成 [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) 的首轮锚定机制。

## 三层注入

- **常驻层（user 层）**：`AGENTS.md` 规则写入 `~/.dsh/AGENTS.md`。上游现以 `instruction-hint` 取代 dsh-agent-instructions 的大块注入：晋升后只提示一次"这些指令文件存在，先读"，模型经文件工具自行读取（`prompt.md` 不混入，改由 preset 层在锚定确认后注入，避免重复）。
- **按需层（技能）**：注册 `prompt` 技能，content = `prompt.md` 中文规范 + `prompt/SKILL.md` 正文，`resourceBase` 指向 `prompt` 目录，`references` 按需读取（flash-7013 / pro-8013 双档位规则）。
- **独立 agent preset 层**：插件加载时直引 anchored-standard 上游文件生成 preset 到 `~/.dsh/.agent-presets/prompt-tool/`（首轮 = 官方 Minimal 真实 schema：持久 `bash` + `str_replace_editor` + 剥离自动注入上下文，无输出 cap）；首轮 reasoning 稳定 "we" 轨迹，we 锚定确认后注入 `prompt.md`；晋升后不放全量目录，改为 resident 集（bootstrap 对 + `dev_tool_search` / `skill_search` / `skill_load` + 已解锁工具）。

> 提示词采用「we 锚定确认后注入」：首轮剥离自动注入（`agent-instructions` / `skill-catalog`），Minimal 真实工具 schema 下 reasoning 稳定走 "We need…" 轨迹；确认 we 锚定后（或不确认则最多等一轮兜底）把中文规范作为 user 消息补进来（每会话一次）。工具目录晋升不依赖 we 确认（首个工具调用或助手回复即放开），锚定失败也不会卡死。

## 项目引用

本项目集成与参考的生态项目：

| 项目 | 关系 | 复用内容 |
|---|---|---|
| [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) | **集成（上游，跟踪 main）** | 加载时直引子模块 `vendor/dsh-anchored-standard/preset/` 的 `agent.cordis.yml` 与全部 `*.mjs` 模块（更新即生效），Minimal 真实 schema 首轮锚定机制 |
| [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) | 参考 | 复杂度启发式正则、近距离注入原则、持久事件推导状态（resume 安全） |
| [dsh-super-injector](https://github.com/yjh051108/dsh-super-injector) | 参考 | 缓存铁律（静态进 system 头、动态走消息尾）、首轮锚定铁律、开发工具链（dev_* 注入/热重载） |
| [dsh 破限者（1449690477/dsh）](https://github.com/1449690477/dsh) | 姊妹项目 | `prompt/` 技能目录（SKILL.md + references）与之同源，常驻层 AGENTS.md 机制一致 |

### 上游直引（子模块）

上游文件不复制、不锁版本：`.gitmodules` 已声明 `branch = main`，插件加载（写 preset）时
直接读子模块 `vendor/dsh-anchored-standard/preset/` 里的 `agent.cordis.yml`（运行时注入
prompt-injector 块与 `prompt.md`）以及全部上游 `*.mjs` 模块（tool-bootstrap /
compaction-epoch / custom-bash / dev-tool-search / instruction-hint / skill-search），
并把它们完整复制进生成的 preset。同步上游：

```sh
git submodule update --remote vendor/dsh-anchored-standard   # 跟随上游 main
pnpm build                                                   # 重建插件
# 重启 dsh 即生效
```

- 上游仓库以子模块形式固定在 `vendor/dsh-anchored-standard`，跟踪 main，不锁 commit
- `preset.yml`、`prompt-injector.mjs`、`turn-anchor.mjs` 为本项目自有文件，固定走 `preset/`
- vendor 缺失（git 安装未初始化子模块）或上游结构变化 → 插件加载时报错（fail loud）
- npm 安装走发布包内置的 `vendor/dsh-anchored-standard/preset` 快照，无需子模块；
  git clone / `link:` 安装则需 `git submodule update --init` 后再使用

## 修改记录

- **v2.2（2026-08-15）**：子模块同步上游 main（`ffb845c`，PR #20/#21/#23/#27/#29）。晋升后由全量目录改为 resident 集（bootstrap 对 + dev_tool_search / skill_search / skill_load + 解锁工具）；AGENTS.md 由每轮注入改为 instruction-hint 一次性提示 + 模型自读；新增 compaction 回落与 Windows custom-bash；`writePreset` 复制上游全部 `preset/*.mjs`；`.gitmodules` 声明 `branch = main`。
- **v2.1（2026-08-15）**：技能目录重命名 `dreammod` → `skill` → `prompt`；上游改为子模块直引，移除不再需要的同步脚本。
- **v2.0（2026-08-15）**：跟随 anchored-standard PR #14，首轮工具 schema 从 `pwsh/read + 1024 cap` 改为官方 Minimal 真实 schema（持久 `bash` + `str_replace_editor`，无 cap）；删除 zero 变体与锚定消息机制，回归原版 tool-bootstrap（字节一致）+ `prompt-injector.mjs` 附加件（we 确认后注入一次 prompt.md，未确认最多等一轮兜底）。实测：复杂英文任务 ×5 并行，we 锚定 5/5、首请求纯净、注入恰好一次。
- **v1（2026-08）**：初版——zero 工具锚定变体 + 固定锚定消息 + 三层注入（AGENTS.md 常驻层、skill 按需层、preset 层）。

## Web UI

在 Settings → 插件 → **插件配置**分区注册「提示词工具」可折叠卡片（`settings.plugin.item`，与其他插件卡片同款式），展开后提供：

- **注入开关**：首轮独立锚定轮（`anchorFirstTurn`）、锚定句文本（`anchorText`，可自定义）、写入 `~/.dsh/AGENTS.md`（`writeAgents`）、生成锚定注入 preset（`writePreset`）
- **保存 / 还原**：把编辑框内容与全部开关写入 `prompt-tool` settings 命名空间（未保存时头部显示"未保存"标记，可一键还原草稿）；Host 监听后写回 `prompt.md`、按开关刷新 `~/.dsh/AGENTS.md` 与 preset，下一次请求即生效
- **打开编辑**：用系统编辑器打开 `prompt.md`
- **在线编辑框**：直接编辑 `prompt.md` 文本

## 工作原理

1. Host 启动读取 `prompt.md` 作为中文规范源。
2. 常驻层：`AGENTS.md` 规则写入 `~/.dsh/AGENTS.md`（首轮被剥离；晋升后由 `instruction-hint` 提示一次，模型经文件工具自行读取）。
3. 按需层：注册 `prompt` 技能，name/description/whenToUse/metadata 全部来自 `SKILL.md` frontmatter。
4. preset 层：直引 `vendor/` 上游 `agent.cordis.yml` + 全部 `*.mjs` 生成 `~/.dsh/.agent-presets/prompt-tool/`，并把 `prompt.md` 注入 `prompt-injector` 的 `promptText`（we 锚定确认后注入）。晋升后目录为 resident 集，其余工具经 `dev_tool_search` 按需解锁。
5. UI 保存通过 settings API 写入 `promptText` 与全部开关；Host 的 watch 回调写回 `prompt.md`，并按开关刷新 `AGENTS.md` 与 preset（含 turn-anchor 行的增删），下一次请求即生效。

## 文件结构

```text
dsh-plugin-prompt-tool/
├── package.json
├── LICENSE                     # MIT
├── prompt.md                   # 中文规范源文件（Web UI 可编辑）
├── AGENTS.md                   # 常驻层附加规则
├── plan.md                     # 设计与测试计划（含上游更新对照、实测数据）
├── tsconfig.json               # Host 类型检查 program（排除 src/client）
├── tsconfig.client.json        # Client 类型检查 program（jsx: react-jsx）
├── tsdown.config.ts            # 构建配置（host lib + client bundle，自包含）
├── cordis.patch.yml            # 挂载配置
├── preset/                     # 本项目自有 preset 文件（上游文件直引 vendor 子模块）
│   ├── preset.yml              # preset 元数据
│   ├── prompt-injector.mjs     # 附加件：we 锚定确认后注入一次 prompt.md
│   └── turn-anchor.mjs         # 可选附加件：首轮独立锚定轮（anchorFirstTurn 开关）
├── prompt/
│   ├── SKILL.md                # 按需层技能定义（name: prompt）
│   └── references/
│       ├── flash-7013.md
│       └── pro-8013.md
├── src/
│   ├── index.ts                # Host 入口
│   ├── preset-core.ts          # preset 生成纯函数（buildCordis / parseFrontmatter）
│   ├── css-modules.d.ts
│   └── client/
│       ├── index.ts            # Client 入口（注册 settings.plugin.item 卡片）
│       ├── PromptEditor.tsx    # 编辑框组件
│       └── PromptEditor.module.css
├── test/
│   └── preset-core.test.mjs    # node:test 单元测试（buildCordis / parseFrontmatter）
├── vendor/                     # git 子模块：dsh-anchored-standard（跟踪 main；agent.cordis.yml + 全部 preset/*.mjs 直引源）
└── lib/                        # 构建产物（pnpm build 生成，不提交）
    ├── index.mjs               # Host 运行时（ESM）
    ├── index.d.mts             # Host 类型声明
    ├── preset-core.mjs         # preset 生成核心（测试导入）
    └── client.js               # Client 运行时（浏览器模块加载器协议，经 exports["./client"] 扫描）
```

## 构建与检查

```sh
pnpm install
pnpm build
pnpm typecheck    # Host 与 Client 两个 tsc program，均 --noEmit
pnpm lint         # oxlint
pnpm test         # pnpm build + node --test
```

按官方发布规范，`prepare` 也指向同一份 tsdown 配置（自包含转译 `src/`，并产出 `.d.mts` 类型声明）：

```sh
pnpm prepare      # npm publish / git install 前自动触发（构建 lib/ 与 vendor/ 直引文件的发布快照）
```

## 装载（官方 bundle-in-profile 模式）

本插件挂载在**独立 profile**（`prompt-tool`），不混入 web profile（web 是别人的插件组合）。

```sh
dsh plugin --profile prompt-tool add link:<本仓库绝对路径>      # 官方 link 安装
dsh plugin --profile prompt-tool remove dsh-plugin-prompt-tool # 卸载
```

profile 的 bundles：`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`（in-box，直接写进
bundles 列表，pnpm 不管理）+ `dsh-plugin-prompt-tool`。本地仓库 link 后：`lib/` 为已构建
产物（`pnpm build` 生成），`vendor/` 子模块随仓库 checkout，插件加载时直引上游最新文件
（`git submodule update --remote vendor/dsh-anchored-standard` 后重启 dsh 即生效）。

启动（web app 随 `dsh-web-app` bundle 自动挂载）：

```sh
dsh --profile prompt-tool
```

注意：`dsh web` 是 `--profile web` 的保留别名，不可与 `--profile` 组合。临时调试可用官方
`--patch` 覆盖层（不落盘、不改任何 profile）：

```sh
dsh --profile prompt-tool --patch <cordis.yml>
```

## 挂载

```yaml
- insert:
    - id: prompt-tool
      name: dsh-plugin-prompt-tool
      config:
        text: ''            # 可选：覆盖 prompt.md 文本（默认读文件）
        writeAgents: true   # 是否写 ~/.dsh/AGENTS.md（默认 true）
        writePreset: true   # 是否生成锚定注入 preset（默认 true）
        anchorFirstTurn: false  # 首轮独立锚定轮开关（默认关闭）
        anchorText: "You are a helpful software assistant.\n\nBegin every reasoning block with 'We need'."  # 锚定句文本
```

config 字段：`text`（覆盖 `prompt.md` 文本，默认读文件）、`writeAgents`（是否写 `~/.dsh/AGENTS.md`，默认 true）、`writePreset`（是否生成 `~/.dsh/.agent-presets/prompt-tool/`，默认 true）。两个写入开关相互独立。

`anchorFirstTurn`（默认 false）开启后，preset 额外挂载 `turn-anchor.mjs`：会话首个真实用户消息先原样入 `agent.inbox` 的 `next-step`，首步只把 `anchorText` 作为独立输入发给模型；模型回应锚定句后，driver 在同一轮内自动消费任务继续执行。任务绝不丢失：inbox 入队失败时回退为原样直发。

锚定句实测（deepseek-v4-pro + reasoningEffort=max，简单任务）：

- 默认句（含 "Begin every reasoning block with 'We need'."）：**12/12** 首轮 reasoning 以 "We need" 开头，prompt.md 全部走 we 确认注入；
- 裸句 "You are a helpful software assistant."：首词 "We need" 约 58-67%（12 会话 7-8 次），其余走兜底注入。

## 锚定机制实测

工具引导由 preset 层的 `tool-bootstrap.mjs`（anchored-standard 上游直引）承担（挂在 agent-plane 首行，`inject:[]` + `prepend: true`，保证 strip 是 waterfall 的最终 transform）：首轮 = Minimal 真实 schema（持久 `bash` + `str_replace_editor`）+ 剥离自动注入 → reasoning 稳定 "we" 轨迹 → 首个工具调用/助手回复落库后进入 resident 目录（bootstrap 对 + `dev_tool_search` / `skill_search` / `skill_load` + 已解锁工具）→ we 确认后（`prompt-injector.mjs`，注册在 tool-bootstrap 之后）注入 `prompt.md` 一次。prompt-tool 插件（host 层）只负责生成 preset，不直接注册工具引导事件，避免与 preset 层重复。

实测（deepseek-v4-pro + reasoningEffort=max，复杂英文任务 ×5 并行，dsh web HTTP API）：

| 断言 | 结果 |
|---|---|
| turn1 reasoning 首词 we | **5/5** |
| 首请求工具 | [bash, str_replace_editor]（5/5） |
| 首请求 maxTokens | 256000（无 cap，5/5） |
| 首请求前注入消息 | 纯净（仅 user，5/5） |
| prompt.md 注入 | 恰好一次，we 确认后同 turn 注入（5/5） |
| 晋升后目录 | resident 集：bash + str_replace_editor + dev_tool_search / skill_search / skill_load + 已解锁工具（上游 v2.2 起） |

详细设计、上游更新对照与踩坑记录见 [plan.md](plan.md)。
