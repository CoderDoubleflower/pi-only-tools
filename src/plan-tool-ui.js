import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import {
  claudeCallComponent,
  DynamicLinesComponent,
  RESPONSE_CONTINUATION,
  RESPONSE_PREFIX,
  responseLinesComponent,
} from "./claude-tool-ui.js";
import { isPlanReady } from "./plan/plan-store.js";
import {
  LEGACY_EXIT_PLAN_MODE_TOOL,
  PLAN_HANDOFF_MESSAGE,
} from "./plan/constants.js";

const PLAN_API_MARKER = Symbol.for("pi-only-tools.user-controlled-plan-api");
const PLAN_UI_TOOL_NAMES = new Set(["EnterPlanMode", "plan_write"]);

function textResult(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trimEnd();
}

function firstHeading(content) {
  const match = String(content ?? "").match(/^#\s+(.+?)\s*$/m);
  return match?.[1]?.trim() || "implementation plan";
}

function stepCount(content) {
  const section = String(content ?? "").split(/^##\s+Implementation Steps\s*$/im)[1] ?? "";
  const body = section.split(/^##\s+/m)[0] ?? "";
  return body.match(/^\s*\d+[.)]\s+\S+/gm)?.length ?? 0;
}

function planRevision(result) {
  const revision = result?.details?.plan?.revision;
  return Number.isInteger(revision) ? revision : undefined;
}

function planStatus(result, content, theme) {
  if (result?.isError) {
    return theme.fg("error", textResult(result) || "Plan update failed");
  }
  const revision = planRevision(result);
  const readiness = result?.details?.readiness;
  const ready = readiness?.ready === true;
  const steps = stepCount(content);
  const label = revision ? `Plan r${revision} saved` : "Plan saved";
  const summary = steps > 0 ? ` · ${steps} ${steps === 1 ? "step" : "steps"}` : "";
  const state = ready ? "awaiting your review" : readiness?.reason || "needs revision";
  return theme.fg(ready ? "success" : "warning", `${label}${summary} · ${state}`);
}

function fallbackMarkdownLines(content, width) {
  const innerWidth = Math.max(1, width);
  return String(content ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line) => {
      if (!line) return [""];
      const pieces = [];
      let rest = line;
      while (rest.length > innerWidth) {
        pieces.push(rest.slice(0, innerWidth));
        rest = rest.slice(innerWidth);
      }
      pieces.push(rest);
      return pieces;
    });
}

function planResultComponent(result, content, theme) {
  return new DynamicLinesComponent((width) => {
    const prefix = theme.fg("muted", RESPONSE_PREFIX);
    const status = planStatus(result, content, theme);
    const innerWidth = Math.max(1, width - RESPONSE_CONTINUATION.length);
    let planLines;
    try {
      planLines = new Markdown(content, 0, 0, getMarkdownTheme()).render(innerWidth);
    } catch {
      planLines = fallbackMarkdownLines(content, innerWidth);
    }
    return [
      truncateToWidth(`${prefix}${status}`, width, "…"),
      "",
      ...planLines.map((line) =>
        truncateToWidth(`${RESPONSE_CONTINUATION}${line}`, width, "…"),
      ),
    ];
  });
}

function renderEnterResult(result, options, theme) {
  if (options.isPartial) {
    return responseLinesComponent([theme.fg("muted", "Entering Plan Mode…")], theme);
  }
  const status = textResult(result) || "Plan Mode enabled";
  return responseLinesComponent(
    [theme.fg(result?.isError ? "error" : "muted", status)],
    theme,
  );
}

export function wrapPlanToolDefinition(tool) {
  if (!tool || !PLAN_UI_TOOL_NAMES.has(tool.name)) return tool;
  const wrapped = { ...tool, renderShell: "self" };

  if (tool.name === "EnterPlanMode") {
    return {
      ...wrapped,
      renderCall(args, theme) {
        const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
        return claudeCallComponent("Enter Plan Mode", [reason || "planning workflow"], theme);
      },
      renderResult: renderEnterResult,
    };
  }

  return {
    ...wrapped,
    renderCall(args, theme) {
      return claudeCallComponent("Write Plan", [firstHeading(args?.content)], theme);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) {
        return responseLinesComponent([theme.fg("muted", "Writing plan…")], theme);
      }
      if (result?.isError) {
        return responseLinesComponent(
          [theme.fg("error", textResult(result) || "Plan update failed")],
          theme,
        );
      }
      const planContent =
        typeof context?.args?.content === "string" ? context.args.content.trimEnd() : "";
      if (!planContent && typeof tool.renderResult === "function") {
        return tool.renderResult(result, options, theme, context);
      }
      if (!planContent) {
        return responseLinesComponent(
          [theme.fg(result?.isError ? "error" : "muted", textResult(result))],
          theme,
        );
      }
      return planResultComponent(result, planContent, theme);
    },
  };
}

function sanitizeLegacyExitText(value) {
  if (typeof value !== "string" || !value.includes(LEGACY_EXIT_PLAN_MODE_TOOL)) {
    return value;
  }
  return value
    .replace(/Complete planning and call ExitPlanMode first\.?/gi, "Complete and publish a valid plan first.")
    .replace(/call ExitPlanMode again when it is ready\.?/gi, "republish the complete plan with plan_write when it is ready.")
    .replace(/Call ExitPlanMode when ready\.?/gi, "Publish the complete plan with plan_write when ready.")
    .replace(/after ExitPlanMode/gi, "after plan publication")
    .replace(/ExitPlanMode/gi, "the removed legacy exit action");
}

function hidePlanHandoff(message) {
  if (!message || typeof message !== "object" || message.customType !== PLAN_HANDOFF_MESSAGE) {
    return message;
  }
  return { ...message, display: false };
}

function mapReviewChoice(choice) {
  if (choice === "Execute plan (keep context)") return "Execute plan (keep context)";
  if (choice === "Clear context and execute in a new session") {
    return "Clear context and execute in a new session";
  }
  if (choice === "Edit plan") return "Edit plan";
  if (choice === "Give feedback and continue planning") {
    return "Give feedback and continue planning";
  }
  if (choice === "Keep reviewing for now") return undefined;
  return choice;
}

function reviewChoices(choices) {
  if (!Array.isArray(choices) || !choices.includes("Execute plan (keep context)")) {
    return undefined;
  }
  return [
    "Execute plan (keep context)",
    "Clear context and execute in a new session",
    "Edit plan",
    "Give feedback and continue planning",
    "Keep reviewing for now",
  ];
}

export function createPlanToolUiExtensionApi(pi) {
  if (pi?.[PLAN_API_MARKER]) return pi;

  const registerTool = pi.registerTool.bind(pi);
  const registerCommand = pi.registerCommand?.bind(pi);
  const registerEvent = pi.on?.bind(pi);
  const rawSendMessage = pi.sendMessage?.bind(pi);
  const rawSendUserMessage = pi.sendUserMessage?.bind(pi);
  const contextCache = new WeakMap();
  let exitPlanTool;
  let reviewCommandRegistered = false;
  let pendingPlanReview = false;

  function wrapContext(ctx) {
    if (!ctx || typeof ctx !== "object") return ctx;
    const cached = contextCache.get(ctx);
    if (cached) return cached;

    let wrapped;
    const ui = ctx.ui && typeof ctx.ui === "object"
      ? new Proxy(ctx.ui, {
          get(target, property) {
            if (property === "notify") {
              return (message, type) => target.notify(sanitizeLegacyExitText(message), type);
            }
            if (property === "select") {
              return async (title, choices) => {
                const replacement = reviewChoices(choices);
                const selected = await target.select(title, replacement ?? choices);
                return replacement ? mapReviewChoice(selected) : selected;
              };
            }
            if (property === "setEditorText") {
              return (text) => {
                if (text === "/plan-approve") return undefined;
                return target.setEditorText(text);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : ctx.ui;

    wrapped = new Proxy(ctx, {
      get(target, property) {
        if (property === "ui") return ui;
        if (property === "sendMessage" && typeof target.sendMessage === "function") {
          return (message, options) =>
            target.sendMessage(hidePlanHandoff(message), options);
        }
        if (property === "newSession" && typeof target.newSession === "function") {
          return async (options) => {
            const withSession = options?.withSession;
            return target.newSession({
              ...options,
              ...(typeof withSession === "function"
                ? {
                    withSession: (newContext) => withSession(wrapContext(newContext)),
                  }
                : {}),
            });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    contextCache.set(ctx, wrapped);
    return wrapped;
  }

  if (registerEvent) {
    registerEvent("agent_settled", async (_event, ctx) => {
      if (!pendingPlanReview || ctx.hasPendingMessages?.()) return;
      pendingPlanReview = false;
      const wrappedCtx = wrapContext(ctx);
      if (wrappedCtx.hasUI && reviewCommandRegistered && rawSendUserMessage) {
        rawSendUserMessage("/plan-approve", { expandPromptTemplates: true });
      } else {
        wrappedCtx.ui?.notify(
          "Plan is ready. Run /plan-approve keep or /plan-approve clear.",
          "info",
        );
      }
    });
    registerEvent("session_shutdown", () => {
      pendingPlanReview = false;
    });
  }

  const proxy = new Proxy(pi, {
    get(target, property) {
      if (property === PLAN_API_MARKER) return true;
      if (property === "registerTool") {
        return (tool) => {
          if (tool?.name === LEGACY_EXIT_PLAN_MODE_TOOL) {
            exitPlanTool = tool;
            return undefined;
          }
          if (tool?.name === "plan_write") {
            const rendered = wrapPlanToolDefinition(tool);
            const originalExecute = rendered.execute.bind(rendered);
            return registerTool({
              ...rendered,
              async execute(toolCallId, params, signal, onUpdate, ctx) {
                const wrappedCtx = wrapContext(ctx);
                const saved = await originalExecute(
                  toolCallId,
                  params,
                  signal,
                  onUpdate,
                  wrappedCtx,
                );
                const readiness = isPlanReady(params.content);
                if (!readiness.ready) {
                  return {
                    ...saved,
                    content: [
                      {
                        type: "text",
                        text: `Plan revision ${saved?.details?.plan?.revision ?? "?"} was saved but is not ready for review: ${readiness.reason}`,
                      },
                    ],
                    details: { ...saved?.details, readiness },
                    terminate: undefined,
                  };
                }
                if (!exitPlanTool?.execute) {
                  throw new Error("The internal Plan publication action is unavailable.");
                }
                const published = await exitPlanTool.execute(
                  `${toolCallId}:publish`,
                  {},
                  signal,
                  undefined,
                  wrappedCtx,
                );
                pendingPlanReview = true;
                const plan = published?.details?.plan ?? saved?.details?.plan;
                const ready = published?.details?.ready;
                return {
                  content: [
                    {
                      type: "text",
                      text: `Plan revision ${plan?.revision ?? "?"} was saved and is awaiting user review. Do not begin implementation.`,
                    },
                  ],
                  details: { ...saved?.details, ...published?.details, plan, ready, readiness },
                  terminate: true,
                };
              },
            });
          }
          return registerTool(wrapPlanToolDefinition(tool));
        };
      }
      if (property === "registerCommand" && registerCommand) {
        return (name, command) => {
          const wrappedCommand = {
            ...command,
            handler: async (args, ctx) => {
              if (name === "plan-approve") pendingPlanReview = false;
              return command.handler(args, wrapContext(ctx));
            },
          };
          if (name === "plan-approve") reviewCommandRegistered = true;
          return registerCommand(name, wrappedCommand);
        };
      }
      if (property === "on" && registerEvent) {
        return (event, handler) =>
          registerEvent(event, (payload, ctx) => {
            if (
              event === "tool_call" &&
              payload?.toolName === LEGACY_EXIT_PLAN_MODE_TOOL
            ) {
              return {
                block: true,
                reason:
                  "Plan approval is user-controlled. Publish the complete plan with plan_write and wait for the user review action.",
              };
            }
            return handler(payload, wrapContext(ctx));
          });
      }
      if (property === "sendMessage" && rawSendMessage) {
        return (message, options) => {
          const next = hidePlanHandoff(message);
          if (next && typeof next === "object" && typeof next.content === "string") {
            return rawSendMessage(
              { ...next, content: sanitizeLegacyExitText(next.content) },
              options,
            );
          }
          return rawSendMessage(next, options);
        };
      }
      if (property === "sendUserMessage" && rawSendUserMessage) {
        return (content, options) =>
          rawSendUserMessage(sanitizeLegacyExitText(content), options);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return proxy;
}

export const __test = {
  firstHeading,
  mapReviewChoice,
  planStatus,
  reviewChoices,
  sanitizeLegacyExitText,
  stepCount,
  textResult,
  wrapPlanToolDefinition,
};
