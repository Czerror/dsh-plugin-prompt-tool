# dsh-plugin-prompt-tool

中文 | [English](README.en.md)

为 [DeepSeek Harness（DSH）](https://deepseek-harness.github.io/deepseek-harness/) 管理提示词与规则。用模块决定注入什么内容、何时触发，以及作用于主会话还是子代理；继续使用原有的官方会话预设。

![模块规则按条件向主会话或子代理注入内容](readme/assets/hero.svg)

## 能做什么

在提示词工具工作台中，你可以：

- 编辑提示词、人设、触发条件、变量和主会话／子代理的模型参数
- 新建、启停、复制和分享模块，编辑自定义工具与工具权限规则
- 导入 SillyTavern 预设、角色卡和世界书，转换为模块
- 在模块中按需配置账本、知识检索与持续记忆；知识库接入与持续记忆需另行授权

## 开始使用

完成下方[安装](#安装)后，从侧栏打开 **提示词工具**：

1. 工作台直接进入统一画布。在左上角搜索模块，点名称查看规则，用同一行的模块开关决定它是否参与运行。需要新建、导入或更改全局运行开关时，打开 **模块中心**。
2. 规则列表默认显示参与装配的模块，也可切到全部模块。选中规则后，画布标题显示所属模块和规则名；**启用规则** 只控制这一条规则。主会话与子代理动作可通过同一规则的作用范围和分支表达，组合视图也在画布中打开。
3. 从左侧节点库添加节点，选中条件或动作后在右侧属性浮层编辑；完整 JSON 和规则设置有独立浮层，底部提供缩放与图例。返回列表仍留在同一画布。
4. 打开 **模块中心**，搜索或筛选平铺的模块卡片，直接查看概览并打开模块规则；打开和编辑不会自动启用模块。未读取的规则按需打开后加载，已有规则草稿会显示数量和简要列表。需要排查时展开诊断并点击 **诊断一次**，结果带有规则或动作身份时可返回对应规则。

导入支持 [YAML](https://yaml.org/)／[JSON](https://www.json.org/json-en.html) 模块文件、目录／[ZIP 压缩包](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)，以及 SillyTavern 预设、[PNG 图像](https://www.w3.org/TR/png/)／JSON 角色卡和世界书。新建和导入的模块默认不启用；SillyTavern 功能的转换范围见 [导入说明](docs/SillyTavern.md)。

动作条件库点击条目只查看详情，拖入目标区域或明确添加才新增节点；右侧优先显示当前节点参数，底部可删除条件或动作，规则概要可折叠。工具预览已移除，自定义工具编辑与实际工具权限不变。

三个工作台入口共享浏览位置和规则草稿，不再分成主会话与子代理布局。模板插入保留模板自身受众，已有独立规则不会自动合并。打开或关闭模块中心不会自动保存规则；收到保存确认后再刷新浏览器。终端界面可通过 `/prompt-tool` 操作模块，`/settings` 中的 **提示词工具** 提供模块运行总开关。

## 安装

需要 DSH `0.2.2-rc.2` 或更高版本。使用命令行界面（CLI）时，还需要 Node.js `24.9.0+` 和 PATH 中可用的 pnpm；完整要求见 [package.json](package.json)。

### 桌面端或 Web

通过宿主的插件管理页安装到当前使用的配置环境（profile）：

1. 打开侧栏的 **插件**，选择 **添加插件**。
2. 输入 `dsh-plugin-prompt-tool`，点击 **安装**，按提示完成检查与安装。
3. 安装完成后选择 **立即启用**；若宿主提示需要重启，重启对应的 DSH 应用或服务。

### CLI

以下命令安装到 `web` profile，然后启动 Web 界面：

```sh
dsh plugin --profile web add dsh-plugin-prompt-tool
dsh --profile web
```

已有其他 CLI profile 时，把两处 `web` 换为它的名称。若该 profile 正在运行，安装后重启它。桌面端使用上面的插件管理页。更多安装方式见 [官方插件指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)。

## 数据与升级

模块定义保存在 `$DSH_HOME/.prompt-tool/modules/<id>/module.yml`。停用模块会撤回它的运行贡献，并保留定义与数据；导出不包含私有 `memory.md`、`data/` 或全局变量。

升级插件后，重启对应的 DSH 应用或服务以加载新代码。升级不会覆盖已有模块定义或私有数据；需要新版内置模块配置时，请显式更新用户副本。旧版内容模块也不会自动移除，升级后请检查已启用的模块。

旧模块格式的转换与数据迁移见 [参数说明](docs/architecture-params.md#旧格式与显式转换) 和 [资产交换](docs/asset-transfer.md)。

## 进一步配置

按需查阅对应文档：

| 任务 | 文档 |
| --- | --- |
| 编写模块、查看 YAML 示例 | [模块编写指南](skills/dsh-module/SKILL.md) · [字段参考](module.yml) |
| 配置变量、人设与指令策略 | [参数与存储](docs/architecture-params.md) |
| 配置注入位置、工具与高级动作 | [引擎指南](docs/engine-reuse.md) · [插入点契约](docs/injection-point-contracts.md) |
| 导入角色卡、世界书或分享模块 | [SillyTavern 转换](docs/SillyTavern.md) · [资产交换](docs/asset-transfer.md) |

## 内置模块

内置模块可按需启停或替换：

- **Ponytail**：注入精简务实的工程规则，提供 lite／full／ultra 三档；来源 [ponytail](https://github.com/DietrichGebert/ponytail)。
- **Caveman**：保留技术事实，精简回答表达，提供普通／极简／文言三档；改编自 [caveman](https://github.com/JuliusBrussee/caveman)。
- **PTC 模式**：通过官方执行器将工具呈现为 `run_code` 与 SDK。
- **技能面收窄**：隐藏完整技能目录，通过 `skill_search`／`skill_load` 按需查找和加载。
- **Soul**：提供判据、结构化账本、授权检索与动态 SELF 等持续身份能力；改编自 [dsh-agent-soul](https://github.com/cyanwell/dsh-agent-soul)。
- **工具面收窄**：保留核心工具，其余通过 `tool_search` 按需解锁。

## 本地开发

在仓库目录安装依赖并执行检查。Node.js 与 pnpm 版本以 [package.json](package.json) 为准：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
```

涉及宿主接入或发布包时，再执行 `pnpm verify:host` 和 `pnpm verify:pack`。构建后可在 DSH 插件管理页用 `link:` 加仓库绝对路径安装本地版本；更新代码后重启宿主。

## 项目状态

项目持续更新；最近发布为 [v6.1.0（2026-11-17）](https://github.com/Czerror/dsh-plugin-prompt-tool/releases/tag/v6.1.0)。

## 许可与来源

本项目采用 [MIT 许可](LICENSE)。部分能力参考或移植自 [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)、[dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) 和 [dsh-super-injector](https://github.com/yjh051108/dsh-super-injector)；版权与许可见 [第三方许可](engine/THIRD_PARTY_LICENSES)。
