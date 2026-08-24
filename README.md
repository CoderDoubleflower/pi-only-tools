# pi-only-tools

一个面向 Pi coding agent 的统一工具策略 package：既提供 Codex 风格基础工具，也统一管理 Normal 与 Plan 两个工具 Profile。有效的计划由 `plan_write` 直接发布给用户审核，只有用户选择执行后才切回 Normal 开始实现。

- `shell_command`
- `apply_patch`

两个工具使用紧凑的终端渲染：调用行显示为 `Bash(...)` / `Update(...)`，结果使用 `⎿` 前缀，长输出默认折叠，文件修改显示增删行统计和带行号的 diff。

从 **0.5.0** 开始，Normal 与 Plan 两个 Profile 在同一张工具矩阵中持久配置；计划获用户批准后直接切回 Normal 执行，不存在独立 Execution Profile。

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

## 工具 Profile 矩阵

从 **0.5.0** 开始，`/only-tools` 不再区分“当前会话禁用”和“永久禁用”。工具策略只有一个持久化来源：

```text
~/.pi/agent/tools.json
```

界面转置为 **Normal / Plan 作为列，Model / Effort / Tool 作为行**：

```text
                    Normal                  Plan
Model               provider/model          provider/model
Effort              high                    xhigh
read                ●                       ●
bash                ●                       ○
grep                ○                       ●
...                 ...                     ...
```

在 Pi TUI 中执行：

```text
/only-tools
```

操作：

- `↑ / ↓`：选择 Model / Effort / 某个工具行；
- `← / →`：选择 Normal / Plan 列；
- `Enter`：Model 行选择模型、Effort 行选择 effort、工具行切换允许状态；
- `Space`：在工具行切换允许状态；
- `M`：直接配置当前列的模型；
- `E / T`：直接配置当前列的 effort（底层仍映射到 Pi thinking level）；
- `A`：当前 Profile 全选可注册工具；
- `N`：当前 Profile 清空；
- `R`：恢复当前 Profile 的默认值；
- `Esc / S`：保存并关闭。

Normal 与 Plan 的模型/effort 都在同一界面编辑；选择 inherit 时继承 Pi 当前/default。工具单元格使用更醒目的 `●` / `○` 表示允许/不允许；锁定的控制工具使用 `◆` / `◇`，`?` 表示工具当前未注册。工具较多时列表会纵向滚动。

### Plan Mode 快捷键

在 Pi TUI 主界面按 `Shift+Tab`：

- Normal → Plan：直接进入 Plan Mode；
- Plan / Ready → Normal：退出 Plan Mode 并恢复 Normal；
- Agent 正在运行时不会中途切换，会提示等待当前 turn 结束。

Pi 默认把 `Shift+Tab` 用于循环 thinking level。`pi-only-tools` 启用后会优先消费这个按键作为 Plan toggle；thinking/effort 可以直接在 `/only-tools` 的 Effort 行配置，或者把 Pi 的 `app.thinking.cycle` 重新绑定到其他按键。

### Profile 语义

- `normal`：普通会话以及批准计划后的执行阶段共同使用的持久工具 allowlist、模型和思考强度。
- `plan`：Plan Mode 的持久调查工具 allowlist；`plan_write` 在表格中锁定为必选。

`EnterPlanMode` 只允许出现在 Normal；`plan_write` 只允许出现在 Plan。`ExitPlanMode` 不再注册或暴露给模型，旧配置中的同名项会在加载和迁移时清理。控制工具在不合法的 Profile 中显示为锁定关闭。

配置保存后立即更新当前 active profile，同时把 Normal 中启用的 Pi 内置工具同步到官方 `settings.json.defaultTools`，使下次启动的内置工具状态与矩阵一致。

### 旧配置迁移

旧版 `tools.json`：

```json
{
  "version": 1,
  "permanentlyDisabledTools": ["example"]
}
```

会在首次启动时自动迁移为 version 3：原永久禁用项会从 Normal 与 Plan 两个 Profile 的 allowlist 中移除，同时清理旧版 `ExitPlanMode` 配置。迁移后不再存在全局 denylist，也不再保存 session branch 的临时工具状态。

原 `claude-plan-mode.json` 中的 `execution` 模型与思考强度会自动作为新的 Normal 配置读取；旧的 Plan tool 列表只用于首次生成 Plan 行默认值，之后工具矩阵以 `tools.json` 为唯一真相。项目级 Plan 配置不再覆盖这个全局矩阵。

查看运行时最终工具：

```text
/only-tools status
```

### Plan workflow

```text
normal
  └─ EnterPlanMode / /plan
       └─ plan
            └─ valid plan_write
                 └─ ready（用户审核）
                      ├─ 执行计划（保留上下文） → normal / executing
                      ├─ 新会话执行             → normal / executing
                      ├─ 编辑 / 反馈             → plan
                      └─ 稍后处理                → ready
                           └─ /plan-approve
```

有效的 `plan_write` 会完成以下动作：

1. 原子写入完整 canonical plan，并固定 revision 与 SHA-256；
2. 通过结构和占位符检查后进入 `ready`；
3. 在当前工具结果中用 Pi Markdown 渲染计划正文；
4. 终止本轮 planning turn，并打开用户审核菜单。

计划正文只在 `plan_write` 阶段完整显示一次。用户批准属于内部状态动作，不会形成可见工具调用；执行 handoff 对模型可见，但在 TUI transcript 中隐藏，因此不会重复打印计划。

交互菜单提供：

- 在当前上下文执行；
- 清空上下文并在新会话执行；
- 编辑计划；
- 提供反馈并继续规划；
- 稍后审核。

非交互模式可以使用：

```text
/plan-approve keep
/plan-approve clear
```

`/plan config` 与 `/only-tools plan` 都直接打开同一个 Profile 矩阵，不再存在第二套 Plan 工具配置界面。

已安装独立 `pi-claude-plan-mode` 的用户仍应卸载旧 package，避免重复注册 Plan workflow。

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

### 与 Codex 对齐的输出限制

`shell_command` 使用与当前 Codex 原生 `shell_command` 相同的两层限制：

1. 捕获层分别保留 stdout 和 stderr 的前 `1 MiB`；即使达到上限，仍继续读取到 EOF，避免子进程因管道背压卡住。
2. stdout 与 stderr 聚合后再次限制为 `1 MiB`。两者竞争空间时，先为 stdout 保留三分之一、stderr 保留三分之二，再把 stderr 未使用的空间返还给 stdout。
3. 返回模型前按 `10,000` 个近似 token 截断；估算规则与 Codex 一致，为约 `4 bytes/token`。
4. 截断保留输出开头和结尾，并在中间插入 `…N tokens truncated…`，同时返回退出码、运行时间和原输出行数。

因此，单次工具结果的模型正文通常约为 `40 KB`，不会再把接近 `400,000` 字符的内容直接写入上下文。最终 session `details` 只保存有界的 TUI 预览和字节统计，不再重复保存完整的 stdout、stderr 与 combined output；流式更新同样只发送小型预览。

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

计划：

```text
Write Plan(User-controlled Plan review)
  ⎿  Plan r3 saved · 4 steps · awaiting your review

     # User-controlled Plan review
     ...
```

计划正文由 Pi Markdown 渲染，不会把整个文档套成灰色 `toolOutput`；标题、列表、行内代码和代码块使用对应的语义样式。

折叠输出：

```text
  ⎿  first line
     second line
     third line
     … +12 lines (ctrl+o to expand)
```

Pi 的全局工具展开快捷键仍负责展开当前保留的 TUI 预览；超出 Codex 捕获与预览限制的内容不会写入 session。

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
3. 使用 `/only-tools` 统一管理 Normal / Plan 的持久工具矩阵。
4. 需要恢复 0.1.0 的近似效果时，在 Normal 列中禁用不需要的内置工具；其他扩展工具仍按 Pi 的正常规则保留。

旧版没有创建工具选择配置文件；早期 0.2.0 开发包若产生了 `~/.pi/agent/pi-only-tools.json`，新版不会再读取它，可以安全删除。

## 安全说明

- Extension 与 shell 命令拥有当前用户权限。
- `shell_command` 可以执行任意命令。
- `apply_patch` 是本机命令，不由本插件提供或沙箱化。
- 工具启用设置只改变模型可见的工具集，不构成操作系统安全边界。
- 安装前应审查 `src/entry.js`、`src/codex-shell-command.js`、`src/index.js` 或 `dist/index.js`。
