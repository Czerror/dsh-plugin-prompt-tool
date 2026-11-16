# Soul 资产来源与适配

来源：[cyanwell/dsh-agent-soul](https://github.com/cyanwell/dsh-agent-soul)。原项目的 package.json 与 README 声明 MIT；本地核对版本中未发现独立 LICENSE 文件。

旧参考正文镜像以 `cd58d6d` 为同步基线。本次对照原项目本地版本 `482fb3fd5664a034a542dadbd6865994ea56035f`（2026-11-13），并以旧作者稿删除前的 `57c487da8d7239f6ed8309c2fce541d97126b1c5` 核对概念。当前上游已转为独立软件，不再保留旧作者稿目录；本目录是提炼后的插件适配文档，不是该版本的原文镜像。

[精简 ECHO 说明](ECHO-权威口径.md) 保留内部分层、来源回取和自检原则。整体功能分层见 [layers.md](../layers.md)，实际操作见 [tools.md](../tools.md) 与 [ledger.md](../ledger.md)。

本插件使用自身模块规则与宿主工具，不分发上游独立运行时、kit、CLI 或安装流程，也不要求安装 mnemon。具体工具、授权、账本与预算语义以当前模块实现为准。资产更新不授权改写已有用户副本、账本、SELF 骨架或外部知识库。
