# pi-only-tools

一个面向 Pi coding agent 的轻量 package，提供两个 Codex 风格基础工具：

- `shell_command`
- `apply_patch`

两个工具使用紧凑的终端渲染：调用行显示为 `Bash(...)` / `Update(...)`，结果使用 `⎿` 前缀，长输出默认折叠，文件修改显示增删行统计和带行号的 diff。

从 **0.3.0** 开始，插件把原 `/tools` 扩展的全工具管理功能合并到 `/only-tools`。同一个 TUI 现在同时管理当前会话工具、永久禁用工具，以及 Pi 内置工具的启动默认值。

## 要求

- Pi `0.84.2` 或更新版本
- Node.js `22.19.0`+
- 本机 PATH 中存在可直接执行的 `apply_patch` 命令

检查命令：

```bash
command -v apply_patch
```

`apply_patch` 不在 PATH 中时，可指定绝对路径：

```bash
export PI_ONLY_TOOLS_APPLY_PATCH_COMMAND=/absolute/path/to/apply_patch
```

## 安装

直接从 GitHub 全局安装：

```bash
pi install git:github.com/CoderDoubleflower/pi-only-tools
```

也可以使用完整的 HTTPS 地址：

```bash
pi install https://github.com/CoderDoubleflower/pi-only-tools
```

如需仅在当前项目中启用，进入项目目录后执行：

```bash
pi install -l git:github.com/CoderDoubleflower/pi-only-tools
```

更新已安装的 package：

```bash
pi update --extensions
```

安装或升级后，重启 Pi 或执行：

```text
/reload
```

## 工具管理

在 Pi TUI 中执行：

```text
/only-tools
```

也可以使用别名：

```text
/pi-only-tools
```

界面通过 Pi 扩展 API 的 `getAllTools()` 获取当前运行时的完整工具列表，因此会包含 Pi 内置工具、普通扩展工具、SDK 工具和 MCP 工具。内置工具通过 `sourceInfo.source === "builtin"` 识别。

界面支持：

- 搜索全部工具
- 逐项切换“启用 / 当前会话禁用 / 永久禁用”
- 在 session branch 中保存当前启用列表，切换分支时恢复
- 把永久禁用列表写入 `~/.pi/agent/tools.json`
- 每次 agent 运行前重新执行永久禁用规则
- 将当前启用的内置工具设为启动默认值
- 恢复 Pi 标准默认工具集
- 一键禁用全部内置工具
- 一键启用当前检测到的全部内置工具
- 修改后立即更新当前会话的 active tools

`shell_command` 和 `apply_patch` 与其他扩展工具一样出现在列表中。选择“当前会话禁用”不会改变下一次新会话的启动设置；选择“永久禁用”会对所有会话生效。

### 状态存储

工具状态按作用域分别存储：

- 当前会话选择：session 中 `customType: "tools-config"` 的 custom entry。
- 永久禁用选择：`~/.pi/agent/tools.json` 的 `permanentlyDisabledTools`。
- 内置工具启动默认值：Pi 官方 `~/.pi/agent/settings.json` 的 `defaultTools`。

这些路径和数据格式与原独立 `/tools` 扩展兼容。删除旧的 `~/.pi/agent/extensions/tools.ts` 后，已有永久禁用和 session branch 状态会由 `/only-tools` 继续读取。

### 复用 Pi 官方配置

配置写入：

```text
~/.pi/agent/settings.json
```

设置了自定义 agent 目录时，插件遵循 Pi 的路径规则：

```bash
PI_CODING_AGENT_DIR=/custom/pi-agent-dir
```

对应配置路径：

```text
/custom/pi-agent-dir/settings.json
```

在界面中选择“将当前内置工具设为启动默认值”后，插件会把当前启用的内置工具写入 `defaultTools`。例如只启用 `read` 和 `bash` 时：

```json
{
  "defaultTools": [
    "read",
    "bash"
  ]
}
```

选择“禁用全部内置工具”会立即禁用它们并写入：

```json
{
  "defaultTools": []
}
```

选择“恢复 Pi 标准默认值”会删除 `defaultTools` 字段，并立即把当前会话的内置工具恢复为 Pi 标准集合。插件写入时会保留 `settings.json` 中的其他字段。

### Pi 自身的优先级仍然有效

`defaultTools` 只定义启动时的内置工具选择：

- 项目 `.pi/settings.json` 中的 `defaultTools` 会替换全局值；界面检测到项目覆盖时会显示警告。
- `--tools` 是所有工具的严格 allowlist。
- `--no-tools` 禁用所有工具。
- `--no-builtin-tools` 禁用内置默认工具。
- `--exclude-tools` 在最终工具集上继续排除。

因此，TUI 修改会立即作用于当前会话；下一次启动时仍按 Pi 官方的全局、项目和 CLI 优先级解析，随后再应用 `tools.json` 中的永久禁用规则。

## `shell_command`

执行一次同步 shell 命令：

```json
{
  "command": "git status --short && npm test",
  "workdir": ".",
  "timeout_ms": 10000
}
```

参数：

- `command`：必填，shell 命令。
- `workdir`：可选。相对路径以当前 Pi cwd 为基准。
- `timeout_ms`：可选，默认 `10000` 毫秒。

行为：

- Unix 默认通过 `$SHELL -lc` 执行；没有 `$SHELL` 时使用 `/bin/bash`。
- Windows 使用 `cmd.exe /d /s /c`。
- 支持流式输出、超时和 AbortSignal 中断。
- stdout、stderr 分开渲染；stderr 和非零退出状态使用错误色。
- 默认每个输出区块展示 3 行；只多 1 行时直接展示第 4 行，否则显示 `… +N lines (ctrl+o to expand)`。

覆盖 Unix shell：

```bash
export PI_ONLY_TOOLS_SHELL=/bin/zsh
```

## `apply_patch`

把完整 patch 通过 stdin 传给本机 `apply_patch` 命令：

```json
{
  "patch": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-oldValue\n+newValue\n*** End Patch\n",
  "workdir": ".",
  "timeout_ms": 120000
}
```

参数：

- `patch`：必填，必须包含 `*** Begin Patch` / `*** End Patch`。
- `workdir`：可选。相对路径以当前 Pi cwd 为基准。
- `timeout_ms`：可选，默认 `120000` 毫秒。

支持识别：

```text
*** Add File:
*** Update File:
*** Delete File:
*** Move to:
```

执行前后，插件会读取涉及的文本文件并计算真实差异，因此 UI 中的 `Added N lines, removed N lines` 不是只依赖 patch 文本估算。单文件超过 2 MiB、二进制文件或过大的 diff 会回退到简化统计。

## 工具渲染

命令：

```text
Bash(git status --short)
  ⎿  M src/index.ts
     ?? test/new.test.ts
```

文件修改：

```text
Update(src/index.ts)
  ⎿  Added 1 line, removed 1 line
       10 -const enabled = false;
       10 +const enabled = true;
```

折叠输出：

```text
  ⎿  first line
     second line
     third line
     … +12 lines (ctrl+o to expand)
```

Pi 的全局工具展开快捷键仍负责展开完整输出。

## 参数兼容

为了兼容部分模型或代理产生的常见字段，插件在 schema 校验前接受以下别名：

- `shell_command`: `cmd` → `command`, `cwd` → `workdir`, `timeout`（秒）→ `timeout_ms`
- `apply_patch`: `input` / `patch_text` / `patchText` / `command` → `patch`, `cwd` → `workdir`, `timeout`（秒）→ `timeout_ms`

模型侧正式 schema 仍只显示规范字段。

## 升级说明

0.1.0 会反复把 active tools 强制改成两个插件工具，并阻止其他工具调用。0.2.0 已删除这两项行为。

0.3.0 合并了原独立 `/tools` 扩展的能力。升级后应删除 `~/.pi/agent/extensions/tools.ts`，避免两个扩展同时恢复和覆盖 active tools。原扩展写入的 `~/.pi/agent/tools.json` 和 session `tools-config` entry 会自动沿用。

升级后：

1. Pi 按自己的 `defaultTools`、项目设置和 CLI 参数决定初始工具集。
2. `shell_command` 与 `apply_patch` 按普通 extension tool 注册。
3. 使用 `/only-tools` 统一管理会话状态、永久禁用和 Pi 官方全局 `defaultTools`。
4. 需要恢复 0.1.0 的近似效果时，在界面中选择“禁用全部内置工具”；其他扩展工具仍按 Pi 的正常规则保留。

旧版没有创建工具选择配置文件；早期 0.2.0 开发包若产生了 `~/.pi/agent/pi-only-tools.json`，新版不会再读取它，可以安全删除。

## 安全说明

- Extension 与 shell 命令拥有当前用户权限。
- `shell_command` 可以执行任意命令。
- `apply_patch` 是本机命令，不由本插件提供或沙箱化。
- 工具启用设置只改变模型可见的工具集，不构成操作系统安全边界。
- 安装前应审查 `src/index.js` 或 `dist/index.js`。
