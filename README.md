# pi-only-tools

`pi-only-tools` 是一个面向 Pi coding agent 的统一工具与模式策略 package：

- 提供 Codex 风格的 `shell_command` 与 `apply_patch`；
- 用同一张 `/only-tools` 矩阵管理 Normal、Ask、Plan；
- 用 `/mode` 或 `Shift+Tab` 在三种模式之间切换；
- 通过稳定工具目录、动态权限策略和固定模式协议，避免模式切换反复破坏 provider prompt cache；
- 由 `plan_write` 发布可审核的 canonical plan，只有用户明确批准后才进入实现阶段。

## 要求

- Pi `0.84.2` 或更新版本；
- Node.js `22.19.0`+；
- 本机 `PATH` 中存在可执行的 `apply_patch`。

检查：

```bash
command -v apply_patch
```

需要指定绝对路径时：

```bash
export PI_ONLY_TOOLS_APPLY_PATCH_COMMAND=/absolute/path/to/apply_patch
```

## 安装与更新

全局安装：

```bash
pi install git:github.com/CoderDoubleflower/pi-only-tools
```

仅当前项目：

```bash
pi install -l git:github.com/CoderDoubleflower/pi-only-tools
```

更新后重启 Pi，或执行：

```text
/reload
```

已安装独立 `pi-claude-plan-mode` 的用户应卸载旧 package，避免重复注册 Plan workflow。

## 缓存稳定的工具策略

### 稳定 Tool Catalog

Normal、Ask、Plan 的工具配置仍然是三个独立 allowlist，但它们不再等同于 provider 请求中的完整 `tools` 数组。

每个 session 会建立一个稳定 Tool Catalog：

```text
Normal tools ∪ Ask tools ∪ Plan tools
```

目录按 Pi 的工具注册顺序排列。模式切换只改变当前允许调用的工具，不会因为 Normal → Ask → Plan 而删除、重排或重新生成工具定义。因此 Pi 不需要在每次模式切换时用不同的 active tools 重建 system prompt。

在同一 session 中：

- 从 Profile 中移除工具，只会立即撤销调用权限；工具定义会保留在稳定目录中，直到新 session；
- 新启用且已经注册的工具会追加到目录末尾，不会重排既有前缀；
- 新 session 会根据当前配置重新建立目录，已不再使用的工具会自然消失。

`ToolProfileController` 仍保留 `dynamic-catalog` 兼容策略供独立调用者使用；package 默认使用 `stable-catalog`。

### 运行时权限门

真正的权限边界是统一的 `tool_call` gate，而不是模型是否看见某个工具：

- Normal：只允许 Normal Profile；
- Ask：只允许 Ask Profile，并继续执行 Ask 的只读约束；
- Plan / planning：只允许 Plan Profile 与 `plan_write`；
- Plan / ready：禁止模型调用任何工具，等待用户审核；
- approved execution：回到 Normal Profile。

原 Ask 与 Plan 的专用拦截仍保留，作为第二层防御。

### OpenAI Responses

对于官方 OpenAI Responses provider，插件保留完整、稳定的 `payload.tools`，仅按当前 Profile设置：

```text
tool_choice = allowed_tools(...)
```

Plan 已发布、等待审核时使用：

```text
tool_choice = none
```

未知 OpenAI 兼容层和其他 provider 不会被强行改写；它们仍依赖固定模式协议与运行时 `tool_call` gate。

### 固定模式协议与隐藏状态

Normal、Ask、Plan 现在共享同一份固定 system mode protocol。以下动态信息不再写入 system prompt：

- 当前模式与 Plan stage；
- 当前工具 allowlist；
- canonical plan 路径；
- revision 与 SHA-256；
- approved revision/hash。

这些信息会写入隐藏的 `[PI ONLY TOOLS MODE STATE v1]` 消息。状态使用稳定 fingerprint；只有模式、权限或计划状态实际变化时才追加一次。发生 compaction 或 session tree 切换后会强制重新发送一次，避免状态消息被摘要掉。

查看当前策略：

```text
/only-tools status
```

输出中的关键字段：

- `cacheStrategy`：当前目录策略；
- `catalogTools`：实际发送给 provider 的稳定工具目录；
- `allowedTools`：当前模式真正允许调用的工具；
- `requested` / `effective`：三个 Profile 的配置与当前可用结果。

## Profile 矩阵

配置文件：

```text
~/.pi/agent/tools.json
```

打开矩阵：

```text
/only-tools
```

界面以 Normal / Ask / Plan 为列，以 Model / Effort / Tool 为行：

```text
                    Normal              Ask                 Plan
Model               provider/model      inherit Normal      provider/model
Effort              high                inherit Normal      xhigh
read                ●                   ●                   ●
shell_command       ●                   ◇                   ○
web_fetch           ○                   ●                   ●
plan_write          ◇                   ◇                   ◆
```

操作：

- `↑ / ↓`：选择行；
- `← / →`：选择 Profile；
- `Enter / Space`：编辑当前单元格；
- `M`：选择模型；
- `E / T`：选择 effort；
- `A`：全选当前 Profile 中可配置且已注册的工具；
- `N`：清空当前 Profile；
- `R`：恢复默认值；
- `Esc / S`：保存并关闭。

工具单元格使用 `●` / `○`；锁定单元格使用 `◆` / `◇`；`?` 表示工具当前未注册。Ask 的模型与 effort 固定继承 Normal。

### Ask Profile

Ask 是显式只读 allowlist。核心读取工具和确认只读的第三方/MCP 工具可以启用；以下已知命令、编辑与工作流控制工具始终锁定关闭：

```text
shell_command
apply_patch
bash
powershell
edit
write
EnterPlanMode
plan_write
ExitPlanMode
```

Pi 的通用 ToolDefinition 没有统一的只读元数据，因此第三方/MCP 工具仍需用户判断。只应在 Ask 中启用读取、搜索、列出、获取和检查类操作。

### Profile 语义

- `normal`：普通会话与批准计划后的执行阶段；
- `ask`：严格只读问答模式，模型与 effort 继承 Normal；
- `plan`：调查与规划模式，可配置独立模型、effort 与调查工具；`plan_write` 锁定必选。

`EnterPlanMode` 只允许出现在 Normal；`plan_write` 只允许出现在 Plan。`ExitPlanMode` 不注册、不暴露给模型，旧配置中的同名项会在迁移时清理。

保存矩阵后，Normal 中启用的 Pi 内置工具仍会同步到官方 `settings.json.defaultTools`，确保下次启动的默认配置一致。

## 模式切换

选择模式：

```text
/mode
```

TUI 中按 `Shift+Tab`：

```text
Normal → Ask → Plan → Normal
```

Agent 正在运行时不会中途切换；需要等待当前 turn 结束。Pi 默认将 `Shift+Tab` 用于 thinking-level cycle，启用本 package 后该按键优先用于模式切换。

## Plan workflow

```text
normal
  └─ /mode → Plan，或 EnterPlanMode / /plan
       └─ planning
            └─ valid plan_write
                 └─ ready（用户审核）
                      ├─ 当前上下文执行 → normal / executing
                      ├─ 新会话执行     → normal / executing
                      ├─ 编辑 / 反馈     → planning
                      └─ 稍后处理       → ready
```

有效的 `plan_write` 会：

1. 原子写入完整 canonical plan；
2. 固定 revision 与 SHA-256；
3. 按语义结构检查计划；
4. 在工具结果中用 Pi Markdown 显示一次完整正文；
5. 进入 `ready` 并打开用户审核菜单；
6. 终止当前 planning turn。

计划必须包含一个结果导向的 H1，以及按顺序排列的四个必需 H2：背景/目标、已验证的当前状态、有序实施步骤、验证。只有真实存在迁移、兼容、恢复、并发或回滚问题时，才允许增加第五个 H2。

非交互模式可使用：

```text
/plan-approve keep
/plan-approve clear
```

`/plan config` 与 `/only-tools` 打开同一个矩阵。

## `shell_command`

示例：

```json
{
  "command": "git status --short && npm test",
  "workdir": ".",
  "timeout_ms": 10000
}
```

- Unix 使用 `$SHELL -lc`，缺省回退到 `/bin/bash`；
- Windows 使用 `cmd.exe /d /s /c`；
- 支持流式输出、超时和 AbortSignal；
- 普通默认超时 `10000 ms`；
- 可通过 `PI_ONLY_TOOLS_SHELL` 覆盖 Unix shell。

工具结果采用有界捕获与模型输出截断：长 stdout/stderr 不会无上限写入 session 或上下文，TUI 默认只显示紧凑预览，可用 Pi 的全局工具展开快捷键查看当前保留内容。

## `apply_patch`

示例：

```json
{
  "patch": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-oldValue\n+newValue\n*** End Patch\n",
  "workdir": ".",
  "timeout_ms": 120000
}
```

支持：

```text
*** Add File:
*** Update File:
*** Delete File:
*** Move to:
```

执行前后会读取相关文本文件并计算真实差异；二进制文件、超大文件或过大的 diff 会回退到简化统计。

常见字段别名会在 schema 校验前规范化：

- `shell_command`：`cmd` → `command`，`cwd` → `workdir`，`timeout` 秒 → `timeout_ms`；
- `apply_patch`：`input` / `patch_text` / `patchText` / `command` → `patch`，`cwd` → `workdir`，`timeout` 秒 → `timeout_ms`。

## 渲染

```text
Bash(git status --short)
  ⎿  M src/index.ts
     ?? test/new.test.ts
```

```text
Update(src/index.ts)
  ⎿  Added 1 line, removed 1 line
       10 -const enabled = false;
       10 +const enabled = true;
```

```text
Write Plan(User-controlled Plan review)
  ⎿  Plan r3 saved · 4 steps · awaiting your review
```

计划正文使用 Pi Markdown 语义样式，不会整体套成灰色 tool output。

## 旧配置迁移

version 1 的 `permanentlyDisabledTools` 与 version 2/3 的 Normal/Plan 配置会迁移到 version 4：

- 保留 Normal 与 Plan allowlist；
- 新增持久 Ask allowlist；
- 清理 `ExitPlanMode`；
- 清理 Ask 中已知的命令/编辑工具；
- 原永久禁用项会从所有 Profile 中移除。

原 `claude-plan-mode.json` 的 execution 模型与 effort 会迁移为 Normal；旧 Plan tools 只用于首次默认值，之后以 `tools.json` 为唯一工具配置来源。

## 安全说明

- Extension 与 shell 命令拥有当前用户权限；
- `shell_command` 可以执行任意命令；
- `apply_patch` 是本机命令，本插件不提供沙箱；
- Ask/Plan/Normal 的运行时 gate 控制模型工具调用，但不是操作系统安全边界；
- 第三方/MCP 工具的只读属性由用户显式判断；
- 安装前应审查源码，尤其是 `src/index.js`、`src/tool-profile-controller.js` 与 `src/mode-cache-policy.js`。
