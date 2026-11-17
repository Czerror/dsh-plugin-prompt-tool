# dsh-plugin-prompt-tool

[中文](README.md) | English

Manage prompts and rules in [DeepSeek Harness (DSH)](https://deepseek-harness.github.io/deepseek-harness/). Use modules to choose what to inject, when to trigger it, and whether it applies to main sessions or subagents. Keep using your existing official session preset.

## What you can do

In the Prompt Tool workspace, you can:

- Edit prompts, personas, conditions, variables, and model parameters for main sessions and subagents
- Create, enable, disable, copy, and share modules; preview available tools
- Import SillyTavern presets, character cards, and world books as modules
- Enable the Soul ledger, knowledge retrieval, and continuous memory as needed; knowledge access and continuous memory require separate authorization

## Install the plugin

Requires DSH `0.2.2-rc.2` or later. For the command-line interface (CLI), you also need Node.js `24.9.0+` and pnpm on your PATH. See [package.json](package.json) for all requirements.

### Desktop or Web

Use the host’s plugin manager to install into your current profile:

1. Open **Plugins** in the sidebar and select **Add plugin**.
2. Enter `dsh-plugin-prompt-tool`, click **Install**, and follow the prompts to complete the checks and installation.
3. Select **Enable now** after installation. If the host requests a restart, restart the corresponding DSH application or service.

### CLI

These commands install into the `web` profile and start the Web interface:

```sh
dsh plugin --profile web add dsh-plugin-prompt-tool
dsh --profile web
```

For another CLI profile, replace `web` in both commands with its name. Restart that profile if it’s already running. For Desktop, use the plugin manager above. See the [official plugin guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md) for other installation options.

## Start using modules

After installation, open **Prompt Tool** from the sidebar:

1. Create a module on the **Modules** page, or import existing files.
2. Enable the module on the **Modules** page and confirm the module runtime switch is on.
3. Edit the module’s rules on **Main session** or **Subagent**. Save the text, conditions, and actions, and enable rules as needed.
4. To check the result, click **Run diagnostics once** for rule and current-session diagnostics.

You can import [YAML](https://yaml.org/)/[JSON](https://www.json.org/json-en.html) module files, folders/[ZIP archives](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT), SillyTavern presets, [PNG images](https://www.w3.org/TR/png/)/JSON character cards, and world books. New and imported modules start disabled. See [SillyTavern import details](docs/SillyTavern.md) for conversion limits.

Save before refreshing the page: unsaved drafts may be lost. In the terminal interface, use `/prompt-tool` to manage modules. The **Prompt Tool** section in `/settings` has the module runtime switch.

## Data and upgrades

Module definitions live in `$DSH_HOME/.prompt-tool/modules/<id>/module.yml`. Disabling a module removes its runtime contributions and preserves its definition and data. Exports exclude private `memory.md`, `data/`, and global variables.

After upgrading the plugin, restart the corresponding DSH application or service to load the new code. Upgrades preserve existing module definitions and private data. Update user copies explicitly to adopt newer built-in module settings. Old content modules remain installed, so review your enabled modules after upgrading.

For old module formats and data migration, see [format conversion](docs/architecture-params.md#旧格式与显式转换) and [asset transfer](docs/asset-transfer.md).

## Configure further

These reference documents are in Chinese:

| Task | Documentation |
| --- | --- |
| Write modules and find YAML examples | [Module authoring guide](skills/dsh-module/SKILL.md) · [Field reference](module.yml) |
| Configure variables, personas, instruction policies, and Soul | [Parameters and storage](docs/architecture-params.md) |
| Configure injection points, tools, and advanced actions | [Engine guide](docs/engine-reuse.md) · [Injection point contracts](docs/injection-point-contracts.md) |
| Import character cards and world books, or share modules | [SillyTavern conversion](docs/SillyTavern.md) · [Asset transfer](docs/asset-transfer.md) |

## Develop locally

Install dependencies and run checks from the repository directory. See [package.json](package.json) for Node.js and pnpm versions:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
```

For host integration or package changes, also run `pnpm verify:host` and `pnpm verify:pack`. After building, install locally through the DSH plugin manager using `link:` followed by the repository’s absolute path. Restart the host after code changes.

## License and sources

This project uses the [MIT license](LICENSE). Some capabilities draw on or adapt [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard), [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard), and [dsh-super-injector](https://github.com/yjh051108/dsh-super-injector). See [third-party licenses](engine/THIRD_PARTY_LICENSES) for copyright and license details.
