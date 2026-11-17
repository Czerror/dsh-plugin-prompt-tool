# dsh-plugin-prompt-tool

中文 | [English](README.en.md)

为 [DeepSeek Harness（DSH）](https://deepseek-harness.github.io/deepseek-harness/) 管理提示词与规则。用模块决定注入什么内容、何时触发，以及作用于主会话还是子代理；继续使用原有的官方会话预设。

## 能做什么

在提示词工具工作台中，你可以：

- 编辑提示词、人设、触发条件、变量和主会话／子代理的模型参数
- 新建、启停、复制和分享模块，预览当前可用工具
- 导入 SillyTavern 预设、角色卡和世界书，转换为模块
- 按需启用 Soul 账本、知识检索和持续记忆；知识库接入与持续记忆需另行授权

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

## 开始使用

安装后，从侧栏打开 **提示词工具**：

1. 在 **模块** 页新建模块，或导入已有文件。
2. 启用模块，并确认模块运行总开关已打开。
3. 在 **主会话** 或 **子代理** 页编辑模块规则，设置正文、条件和动作后保存，按需启用规则。
4. 需要排查效果时，点击 **诊断一次**，查看规则与当前会话的诊断结果。

导入支持 [YAML](https://yaml.org/)／[JSON](https://www.json.org/json-en.html) 模块文件、目录／[ZIP 压缩包](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)，以及 SillyTavern 预设、[PNG 图像](https://www.w3.org/TR/png/)／JSON 角色卡和世界书。新建和导入的模块默认不启用；SillyTavern 功能的转换范围见 [导入说明](docs/SillyTavern.md)。

保存后再刷新页面，未保存草稿不保证恢复。终端界面可通过 `/prompt-tool` 操作模块，`/settings` 中的 **提示词工具** 提供模块运行总开关。

## 数据与升级

模块定义保存在 `$DSH_HOME/.prompt-tool/modules/<id>/module.yml`。停用模块会撤回它的运行贡献，并保留定义与数据；导出不包含私有 `memory.md`、`data/` 或全局变量。

升级插件后，重启对应的 DSH 应用或服务以加载新代码。升级不会覆盖已有模块定义或私有数据；需要新版内置模块配置时，请显式更新用户副本。旧版内容模块也不会自动移除，升级后请检查已启用的模块。

旧模块格式的转换与数据迁移见 [参数说明](docs/architecture-params.md#旧格式与显式转换) 和 [资产交换](docs/asset-transfer.md)。

## 进一步配置

按需查阅对应文档：

| 任务 | 文档 |
| --- | --- |
| 编写模块、查看 YAML 示例 | [模块编写指南](skills/dsh-module/SKILL.md) · [字段参考](module.yml) |
| 配置变量、人设、指令策略与 Soul | [参数与存储](docs/architecture-params.md) |
| 配置注入位置、工具与高级动作 | [引擎指南](docs/engine-reuse.md) · [插入点契约](docs/injection-point-contracts.md) |
| 导入角色卡、世界书或分享模块 | [SillyTavern 转换](docs/SillyTavern.md) · [资产交换](docs/asset-transfer.md) |

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

## 许可与来源

本项目采用 [MIT 许可](LICENSE)。部分能力参考或移植自 [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)、[dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) 和 [dsh-super-injector](https://github.com/yjh051108/dsh-super-injector)；版权与许可见 [第三方许可](engine/THIRD_PARTY_LICENSES)。
