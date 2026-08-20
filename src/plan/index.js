import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ASK_USER_QUESTION_TOOL, ENTER_PLAN_MODE_TOOL, EXIT_PLAN_MODE_TOOL, PLAN_CONTINUE_MESSAGE, PLAN_HANDOFF_MESSAGE, PLAN_STATE_ENTRY, PLAN_STATUS_KEY, PLAN_WIDGET_KEY, PLAN_WRITE_TOOL, STATE_SCHEMA_VERSION, } from "./constants.js";
import { loadPlanModeConfig } from "./config.js";
import { openPlanModeConfig } from "./config-ui.js";
import { approvePlan, buildExecutionHandoffMessage, buildExecutionState, buildHandoffDetails, } from "./handoff.js";
import { createPlanDocument, ensurePlanDocument, isManagedPlanDocument, isPlanReady, refreshPlanDocument, updatePlanDocument, } from "./plan-store.js";
import { applyProfile, captureCurrentProfile, resolvePhaseProfile } from "./profile.js";
import { buildExecutionSystemPrompt, buildPlanningSystemPrompt, buildReadySystemPrompt, } from "./prompts.js";
import { restorePlanModeState, touchState } from "./state.js";
import { buildIdleTools, buildPlanningTools, getEffectivePlanningToolSelection, getMissingPlanningTools, isPlanningToolAllowed, } from "./tool-set.js";
export * from "./config.js";
export * from "./config-ui.js";
export * from "./constants.js";
export * from "./handoff.js";
export * from "./plan-store.js";
export * from "./profile.js";
export * from "./state.js";
export * from "./tool-set.js";
export * from "./types.js";
const enterPlanSchema = Type.Object({
    reason: Type.Optional(Type.String({ description: "Optional short description of why a planning pass is appropriate." })),
}, { additionalProperties: false });
const planWriteSchema = Type.Object({
    content: Type.String({
        minLength: 1,
        description: "Complete replacement content for the canonical implementation plan Markdown file.",
    }),
    expected_revision: Type.Optional(Type.Integer({
        minimum: 1,
        description: "Optional optimistic-concurrency check against the current plan revision.",
    })),
}, { additionalProperties: false });
const emptySchema = Type.Object({}, { additionalProperties: false });
function formatStateSummary(state) {
    return state?.stage === "planning" || state?.stage === "ready"
        ? "Plan Mode is active."
        : "Plan Mode is inactive.";
}
function executionSessionName(state) {
    const sourceName = state.source?.sourceSessionName?.trim();
    if (sourceName)
        return `execute-${sourceName}`.slice(0, 80);
    return `execute-plan-${state.plan?.id.slice(0, 8) ?? "session"}`;
}
function getCurrentBranch(ctx) {
    const manager = ctx.sessionManager;
    return typeof manager.getBranch === "function" ? manager.getBranch() : manager.getEntries();
}
function branchHasApprovedHandoff(ctx, current) {
    if (!current.plan || !current.approved)
        return false;
    return getCurrentBranch(ctx).some((entry) => {
        if (entry.type !== "custom_message" || entry.customType !== PLAN_HANDOFF_MESSAGE)
            return false;
        if (!entry.details || typeof entry.details !== "object")
            return false;
        const details = entry.details;
        return (details.planId === current.plan.id &&
            details.revision === current.approved.revision &&
            details.hash === current.approved.hash);
    });
}
function countLatestAssistantToolCalls(ctx) {
    const branch = getCurrentBranch(ctx);
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (entry?.type !== "message" || !entry.message || typeof entry.message !== "object")
            continue;
        const message = entry.message;
        if (message.role !== "assistant")
            continue;
        if (!Array.isArray(message.content))
            return 0;
        return message.content.filter((block) => {
            if (!block || typeof block !== "object")
                return false;
            const type = block.type;
            return type === "toolCall" || type === "tool_use";
        }).length;
    }
    return 0;
}
export function registerClaudePlanMode(pi, options = {}) {
    const toolProfiles = options.toolProfiles;
    let state;
    let pendingPlanningContinuation = false;
    let removeShiftTabListener;
    function allToolNames() {
        return new Set(pi.getAllTools().map((tool) => tool.name));
    }
    function selectedPlanningTools(current = state, names = allToolNames()) {
        if (toolProfiles)
            return getEffectivePlanningToolSelection(toolProfiles.getRequestedTools("plan"), names);
        return getEffectivePlanningToolSelection(current?.planningTools, names);
    }
    function activePlanningTools(current = state, names = allToolNames()) {
        if (!toolProfiles)
            return selectedPlanningTools(current, names);
        return getEffectivePlanningToolSelection(toolProfiles.getEffectiveTools("plan"), names);
    }
    function profileForStage() {
        return state?.stage === "planning" || state?.stage === "ready" ? "plan" : "normal";
    }
    function applyActiveTools(toolNames) {
        if (!toolProfiles) {
            pi.setActiveTools(toolNames);
            return toolNames;
        }
        const profile = profileForStage();
        // Normal is the persistent source of truth. The internal executing state
        // tracks an approved plan, but it must never overwrite the Normal allowlist.
        return profile === "normal"
            ? toolProfiles.activate("normal")
            : toolProfiles.activate("plan", toolNames);
    }
    function unavailablePlanningTools(toolNames) {
        if (toolProfiles)
            return toolProfiles.getUnavailableTools(toolNames);
        return getMissingPlanningTools(toolNames, allToolNames()).map((name) => ({ name, reason: "not registered" }));
    }
    function warnUnavailablePlanningTools(ctx, toolNames, suffix) {
        const unavailable = unavailablePlanningTools(toolNames);
        if (unavailable.length === 0)
            return;
        const details = unavailable.map((entry) => `${entry.name} (${entry.reason})`).join(", ");
        ctx.ui.notify(`Configured Plan Mode tools are unavailable and will be ${suffix}: ${details}.`, "warning");
    }
    function updateUi(ctx) {
        const planModeActive = state?.stage === "planning" || state?.stage === "ready";
        ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
        ctx.ui.setStatus(PLAN_STATUS_KEY, planModeActive ? ctx.ui.theme.fg("warning", "Plan Mode") : undefined);
    }
    function commitState(next, ctx, persist = true) {
        state = touchState(next);
        if (persist)
            pi.appendEntry(PLAN_STATE_ENTRY, state);
        updateUi(ctx);
        return state;
    }
    function warnConfig(ctx, warnings) {
        for (const warning of warnings)
            ctx.ui.notify(warning, "warning");
    }
    async function applyStateRuntime(current, ctx) {
        const names = allToolNames();
        if ((current.stage === "planning" || current.stage === "ready") && current.baseline && current.planningProfile) {
            const planningTools = selectedPlanningTools(current, names);
            warnUnavailablePlanningTools(ctx, planningTools, "unavailable");
            applyActiveTools(buildPlanningTools(planningTools, names));
            await applyProfile(pi, ctx, current.planningProfile, current.baseline.profile, "Planning profile");
            return;
        }
        if (current.stage === "executing" && current.baseline && current.executionProfile) {
            const tools = buildIdleTools(current.executionTools ?? current.baseline.tools, names);
            applyActiveTools(tools);
            await applyProfile(pi, ctx, current.executionProfile, current.baseline.profile, "Normal profile");
            return;
        }
        if (current.baseline) {
            const tools = buildIdleTools(current.executionTools ?? current.baseline.tools, names);
            const profile = current.executionProfile ?? current.baseline.profile;
            applyActiveTools(tools);
            await applyProfile(pi, ctx, profile, current.baseline.profile, "Normal profile");
            return;
        }
        applyActiveTools(buildIdleTools(pi.getActiveTools(), names));
    }
    async function applySavedConfiguration(ctx) {
        const loaded = loadPlanModeConfig(ctx.cwd, {
            agentDir: getAgentDir(),
            configDirName: CONFIG_DIR_NAME,
            loadProjectConfig: false,
        });
        warnConfig(ctx, loaded.warnings);
        const currentProfile = captureCurrentProfile(pi, ctx);
        const fallbackProfile = state?.baseline?.profile ?? currentProfile;
        const normalProfile = resolvePhaseProfile(fallbackProfile, loaded.config.normal);
        const normalTools = toolProfiles
            ? toolProfiles.getRequestedTools("normal")
            : state?.executionTools ?? state?.baseline?.tools ?? pi.getActiveTools();

        if (!state?.baseline) {
            if (toolProfiles)
                toolProfiles.activate("normal");
            await applyProfile(pi, ctx, normalProfile, currentProfile, "Normal profile");
            return;
        }

        if (state.stage === "planning" || state.stage === "ready") {
            const names = allToolNames();
            const planningTools = selectedPlanningTools(state, names);
            const next = commitState({
                ...state,
                planningTools,
                planningProfile: resolvePhaseProfile(state.baseline.profile, loaded.config.planning),
                executionProfile: normalProfile,
                executionTools: normalTools,
            }, ctx);
            await applyStateRuntime(next, ctx);
            ctx.ui.notify("Profile configuration was applied to the current Plan session.", "info");
            return;
        }

        if (state.stage === "executing") {
            const next = commitState({
                ...state,
                executionProfile: normalProfile,
                executionTools: normalTools,
            }, ctx);
            await applyStateRuntime(next, ctx);
            ctx.ui.notify("Normal profile configuration was applied to the approved-plan execution.", "info");
            return;
        }

        applyActiveTools(buildIdleTools(normalTools, allToolNames()));
        await applyProfile(pi, ctx, normalProfile, fallbackProfile, "Normal profile");
    }
    async function openConfiguration(ctx) {
        await ctx.waitForIdle?.();
        const result = options.openUnifiedConfig
            ? await options.openUnifiedConfig(ctx)
            : await openPlanModeConfig(pi, ctx, {
                agentDir: getAgentDir(),
                configDirName: CONFIG_DIR_NAME,
                toolProfiles,
            });
        if (result.saved)
            await applySavedConfiguration(ctx);
        return result;
    }
    async function restoreBranchRuntime(ctx, fallbackState, recoverMissingHandoff = true) {
        state = restorePlanModeState(getCurrentBranch(ctx));
        if (state?.plan && !isManagedPlanDocument(state.plan, getAgentDir())) {
            ctx.ui.notify(`Ignoring Plan state with an unmanaged canonical path: ${state.plan.path}`, "error");
            state = undefined;
        }
        if (state?.plan && (state.stage === "planning" || state.stage === "ready")) {
            const ensured = await ensurePlanDocument(state.plan);
            const refreshed = await refreshPlanDocument(ensured);
            if (refreshed.changed || ensured !== state.plan) {
                state = touchState({
                    ...state,
                    plan: refreshed.document,
                    stage: state.stage === "ready" ? "planning" : state.stage,
                    ready: state.stage === "ready" ? undefined : state.ready,
                    approved: undefined,
                });
                pi.appendEntry(PLAN_STATE_ENTRY, state);
            }
        }
        try {
            if (state) {
                await applyStateRuntime(state, ctx);
            }
            else if (fallbackState?.baseline) {
                // Pi restores model/thinking entries while navigating the session tree,
                // but active-tool changes are extension state. Remove Plan-only tools
                // by restoring the baseline captured before Plan Mode. A rejected
                // unsafe state may still provide the last known baseline tool snapshot.
                const baseline = fallbackState.baseline;
                const tools = buildIdleTools(fallbackState.executionTools ?? baseline.tools, allToolNames());
                const profile = fallbackState.executionProfile ?? baseline.profile;
                applyActiveTools(tools);
                await applyProfile(pi, ctx, profile, baseline.profile, "Normal profile");
            }
            else {
                if (toolProfiles)
                    toolProfiles.activate("normal");
                else
                    applyActiveTools(buildIdleTools(pi.getActiveTools(), allToolNames()));
                const loaded = loadPlanModeConfig(ctx.cwd, {
                    agentDir: getAgentDir(),
                    configDirName: CONFIG_DIR_NAME,
                    loadProjectConfig: false,
                });
                warnConfig(ctx, loaded.warnings);
                const currentProfile = captureCurrentProfile(pi, ctx);
                const normalProfile = resolvePhaseProfile(currentProfile, loaded.config.normal);
                await applyProfile(pi, ctx, normalProfile, currentProfile, "Normal profile");
            }
        }
        catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        if (recoverMissingHandoff &&
            state?.stage === "executing" &&
            state.approved &&
            state.source &&
            !branchHasApprovedHandoff(ctx, state)) {
            // Recover the exact approved snapshot if Pi was interrupted after the
            // execution state was persisted but before the handoff message landed.
            pi.sendMessage({
                customType: PLAN_HANDOFF_MESSAGE,
                content: buildExecutionHandoffMessage(state),
                display: true,
                details: buildHandoffDetails(state, state.source.clearContext),
            }, { triggerTurn: false });
        }
        updateUi(ctx);
    }
    async function synchronizePlan(ctx, invalidateReady = true) {
        const current = state;
        if (!current?.plan)
            throw new Error("No canonical plan is active.");
        let document = await ensurePlanDocument(current.plan);
        const refreshed = await refreshPlanDocument(document);
        document = refreshed.document;
        if (document !== current.plan || refreshed.changed) {
            commitState({
                ...current,
                plan: document,
                stage: invalidateReady && current.stage === "ready" ? "planning" : current.stage,
                ready: invalidateReady && current.stage === "ready" ? undefined : current.ready,
                approved: invalidateReady ? undefined : current.approved,
            }, ctx);
        }
        return refreshed.content;
    }
    async function beginPlanning(ctx, options) {
        if (state?.stage === "planning" || state?.stage === "ready") {
            return { entered: false, message: formatStateSummary(state) };
        }
        if (state?.stage === "executing") {
            return {
                entered: false,
                message: "An approved plan is currently in execution. Run /plan finish before starting another Plan session.",
            };
        }
        if (options.confirm) {
            if (!ctx.hasUI) {
                return { entered: false, message: "Interactive Plan Mode confirmation is unavailable. Run /plan explicitly." };
            }
            const accepted = await ctx.ui.confirm("Enter Plan Mode?", "Switch to the configured Plan tool allowlist and create a canonical implementation plan?");
            if (!accepted)
                return { entered: false, message: "The user declined Plan Mode." };
        }
        const names = allToolNames();
        const baselineTools = buildIdleTools(pi.getActiveTools(), names);
        const baselineProfile = captureCurrentProfile(pi, ctx);
        const loaded = loadPlanModeConfig(ctx.cwd, {
            agentDir: getAgentDir(),
            configDirName: CONFIG_DIR_NAME,
            loadProjectConfig: false,
        });
        warnConfig(ctx, loaded.warnings);
        const planningTools = selectedPlanningTools(state, names);
        warnUnavailablePlanningTools(ctx, planningTools, "skipped");
        const planningProfile = resolvePhaseProfile(baselineProfile, loaded.config.planning);
        const executionProfile = resolvePhaseProfile(baselineProfile, loaded.config.normal);
        const executionTools = toolProfiles
            ? toolProfiles.getRequestedTools("normal")
            : baselineTools;
        const plan = await createPlanDocument(getAgentDir(), options.reason);
        commitState({
            schemaVersion: STATE_SCHEMA_VERSION,
            stage: "planning",
            plan,
            baseline: { profile: baselineProfile, tools: baselineTools },
            planningTools,
            planningProfile,
            executionProfile,
            executionTools,
            updatedAt: new Date().toISOString(),
        }, ctx);
        applyActiveTools(buildPlanningTools(planningTools, names));
        await applyProfile(pi, ctx, planningProfile, baselineProfile, "Planning profile");
        updateUi(ctx);
        return {
            entered: true,
            message: "Plan Mode enabled.",
        };
    }
    async function leaveCurrentPlan(ctx) {
        const current = state;
        if (!current?.baseline) {
            state = undefined;
            applyActiveTools(buildIdleTools(pi.getActiveTools(), allToolNames()));
            updateUi(ctx);
            return;
        }
        const next = commitState({
            ...current,
            stage: "idle",
            ready: undefined,
            approved: undefined,
            source: undefined,
        }, ctx);
        applyActiveTools(buildIdleTools(next.executionTools ?? next.baseline.tools, allToolNames()));
        await applyProfile(pi, ctx, next.executionProfile ?? next.baseline.profile, next.baseline.profile, "Normal profile");
        updateUi(ctx);
    }
    async function togglePlanModeFromShortcut(ctx) {
        if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
            ctx.ui.notify("Shift+Tab can toggle Plan Mode after the current agent turn finishes.", "warning");
            return;
        }
        if (state?.stage === "planning" || state?.stage === "ready") {
            await leaveCurrentPlan(ctx);
            ctx.ui.notify("Plan Mode off · Normal profile", "info");
            return;
        }
        const result = await beginPlanning(ctx, { confirm: false });
        ctx.ui.notify(result.entered ? "Plan Mode on · Shift+Tab to return to Normal" : result.message, result.entered ? "info" : "warning");
    }
    function installShiftTabToggle(ctx) {
        removeShiftTabListener?.();
        removeShiftTabListener = undefined;
        if (ctx.mode !== "tui" || typeof ctx.ui.onTerminalInput !== "function")
            return;
        removeShiftTabListener = ctx.ui.onTerminalInput((data) => {
            if (!matchesKey(data, Key.shift("tab")))
                return;
            void togglePlanModeFromShortcut(ctx).catch((error) => {
                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            });
            return { consume: true };
        });
    }
    async function editCanonicalPlan(ctx, options = {}) {
        if (!state?.plan || (state.stage !== "planning" && state.stage !== "ready")) {
            ctx.ui.notify("There is no editable Plan session.", "warning");
            return { changed: false, ready: false };
        }
        const content = await synchronizePlan(ctx, !options.preserveReady);
        const current = state;
        const edited = await ctx.ui.editor(`Edit plan r${current.plan.revision}`, content);
        if (edited === undefined || edited === content) {
            return { changed: false, ready: current.stage === "ready" };
        }
        const normalized = edited.endsWith("\n") ? edited : `${edited}\n`;
        const plan = await updatePlanDocument(current.plan, normalized);
        const readiness = isPlanReady(normalized);
        const preserveReady = options.preserveReady === true && readiness.ready;
        const ready = preserveReady
            ? {
                revision: plan.revision,
                hash: plan.hash,
                preparedAt: new Date().toISOString(),
            }
            : undefined;
        commitState({
            ...current,
            stage: preserveReady ? "ready" : "planning",
            plan,
            ready,
            approved: undefined,
        }, ctx);
        if (preserveReady) {
            ctx.ui.notify(`Plan updated to revision ${plan.revision} and remains ready for approval.`, "info");
        }
        else if (readiness.ready) {
            ctx.ui.notify(`Plan updated to revision ${plan.revision}. Call ${EXIT_PLAN_MODE_TOOL} when ready.`, "info");
        }
        else {
            ctx.ui.notify(`Plan updated to revision ${plan.revision}, but it is not ready: ${readiness.reason}`, "warning");
        }
        return { changed: true, ready: preserveReady };
    }
    async function continueWithFeedback(ctx) {
        if (!state?.plan || (state.stage !== "planning" && state.stage !== "ready")) {
            ctx.ui.notify("There is no Plan session awaiting feedback.", "warning");
            return;
        }
        const feedback = await ctx.ui.editor("Feedback for the plan", "");
        if (!feedback?.trim())
            return;
        const next = commitState({
            ...state,
            stage: "planning",
            ready: undefined,
            approved: undefined,
            lastFeedback: feedback.trim(),
        }, ctx);
        pi.sendUserMessage(`Revise the canonical plan at ${next.plan.path} using this user feedback:\n\n${feedback.trim()}\n\n` +
            `Update the plan with ${PLAN_WRITE_TOOL}, then call ${EXIT_PLAN_MODE_TOOL} again when it is ready.`);
    }
    async function approveKeepContext(ctx, content) {
        if (!state?.plan || !state.baseline || !state.executionProfile)
            throw new Error("Plan state is incomplete.");
        const source = {
            sourceSessionId: ctx.sessionManager.getSessionId(),
            sourceSessionFile: ctx.sessionManager.getSessionFile(),
            sourceSessionName: pi.getSessionName(),
            clearContext: false,
        };
        const { state: approvedState } = approvePlan(state, content);
        const executionState = buildExecutionState(approvedState, source);
        commitState(executionState, ctx);
        applyActiveTools(buildIdleTools(executionState.executionTools ?? executionState.baseline.tools, allToolNames()));
        await applyProfile(pi, ctx, executionState.executionProfile, executionState.baseline.profile, "Normal profile");
        updateUi(ctx);
        pi.sendMessage({
            customType: PLAN_HANDOFF_MESSAGE,
            content: buildExecutionHandoffMessage(executionState),
            display: true,
            details: buildHandoffDetails(executionState, false),
        }, { triggerTurn: true });
    }
    async function approveFreshSession(ctx, content) {
        if (!state?.plan || !state.baseline || !state.executionProfile)
            throw new Error("Plan state is incomplete.");
        const source = {
            sourceSessionId: ctx.sessionManager.getSessionId(),
            sourceSessionFile: ctx.sessionManager.getSessionFile(),
            sourceSessionName: pi.getSessionName(),
            clearContext: true,
        };
        const { state: approvedState, approved } = approvePlan(state, content);
        const executionState = buildExecutionState(approvedState, source);
        const handoffMessage = buildExecutionHandoffMessage(executionState);
        const handoffDetails = buildHandoffDetails(executionState, true);
        const readyBeforeHandoff = {
            revision: approved.revision,
            hash: approved.hash,
            preparedAt: new Date().toISOString(),
        };
        commitState({
            ...approvedState,
            stage: "handed_off",
            source,
        }, ctx);
        const result = await ctx.newSession({
            ...(source.sourceSessionFile ? { parentSession: source.sourceSessionFile } : {}),
            setup: async (sessionManager) => {
                sessionManager.appendCustomEntry(PLAN_STATE_ENTRY, executionState);
                sessionManager.appendSessionInfo(executionSessionName(executionState));
            },
            withSession: async (newContext) => {
                await newContext.sendMessage({
                    customType: PLAN_HANDOFF_MESSAGE,
                    content: handoffMessage,
                    display: true,
                    details: handoffDetails,
                }, { triggerTurn: true });
            },
        });
        if (!result.cancelled)
            return;
        commitState({
            ...approvedState,
            stage: "ready",
            approved: undefined,
            source: undefined,
            ready: readyBeforeHandoff,
        }, ctx);
        ctx.ui.notify("Creating the execution session was cancelled; the plan remains ready for approval.", "warning");
    }
    async function loadReadyPlan(ctx) {
        if (state?.stage !== "ready" || !state.plan || !state.ready) {
            ctx.ui.notify("No plan is ready. Complete planning and call ExitPlanMode first.", "warning");
            return undefined;
        }
        const content = await synchronizePlan(ctx, false);
        const current = state;
        if (current?.stage !== "ready" ||
            !current.plan ||
            !current.ready ||
            current.ready.hash !== current.plan.hash ||
            current.ready.revision !== current.plan.revision) {
            if (current?.stage === "ready") {
                commitState({ ...current, stage: "planning", ready: undefined, approved: undefined }, ctx);
            }
            ctx.ui.notify("The plan changed after ExitPlanMode. Review it and call ExitPlanMode again.", "warning");
            return undefined;
        }
        const readiness = isPlanReady(content);
        if (!readiness.ready) {
            commitState({ ...current, stage: "planning", ready: undefined, approved: undefined }, ctx);
            ctx.ui.notify(`The plan is no longer ready: ${readiness.reason}`, "warning");
            return undefined;
        }
        return { current, content };
    }
    async function runApprovalCommand(args, ctx) {
        await ctx.waitForIdle();
        let requestedAction = args.trim().toLowerCase();
        while (true) {
            const loaded = await loadReadyPlan(ctx);
            if (!loaded)
                return;
            const current = loaded.current;
            let action = requestedAction;
            requestedAction = "";
            if (!action) {
                if (!ctx.hasUI) {
                    ctx.ui.notify("Use /plan-approve keep or /plan-approve clear in non-interactive mode.", "warning");
                    return;
                }
                const choice = await ctx.ui.select(`Plan r${current.plan.revision} · ${current.plan.path}`, [
                    "Execute plan (keep context)",
                    "Clear context and execute in a new session",
                    "Edit plan",
                    "Give feedback and continue planning",
                    "Stay in Plan Mode",
                ]);
                if (!choice)
                    return;
                action = choice.startsWith("Execute")
                    ? "keep"
                    : choice.startsWith("Clear")
                        ? "clear"
                        : choice.startsWith("Edit")
                            ? "edit"
                            : choice.startsWith("Give")
                                ? "feedback"
                                : "stay";
            }
            if (["keep", "execute", "same"].includes(action)) {
                const latest = await loadReadyPlan(ctx);
                if (latest)
                    await approveKeepContext(ctx, latest.content);
                return;
            }
            if (["clear", "fresh", "new"].includes(action)) {
                const latest = await loadReadyPlan(ctx);
                if (latest)
                    await approveFreshSession(ctx, latest.content);
                return;
            }
            if (action === "edit") {
                const result = await editCanonicalPlan(ctx, { preserveReady: true });
                if (!result.ready || args.trim())
                    return;
                continue;
            }
            if (["feedback", "revise"].includes(action)) {
                await continueWithFeedback(ctx);
                return;
            }
            if (["stay", "cancel"].includes(action)) {
                commitState({ ...current, stage: "planning", ready: undefined, approved: undefined }, ctx);
                ctx.ui.notify("Remaining in Plan Mode.", "info");
                return;
            }
            ctx.ui.notify("Unknown approval action. Use keep, clear, edit, feedback, or stay.", "warning");
            return;
        }
    }
    pi.registerFlag("plan", {
        description: "Start the session in Claude-style Plan Mode",
        type: "boolean",
        default: false,
    });
    pi.registerTool({
        name: ENTER_PLAN_MODE_TOOL,
        label: "Enter Plan Mode",
        description: "Ask the user to enter a planning workflow before implementing a non-trivial task. Plan Mode activates the configured tool allowlist plus the canonical plan workflow tools.",
        promptSnippet: "Enter a read-only planning workflow before complex implementation work",
        promptGuidelines: [
            "Use EnterPlanMode for non-trivial features, multi-file changes, architecture decisions, or when the user asks for a plan first.",
            "Call EnterPlanMode alone in its tool-call turn.",
            "Do not use it for tiny, obvious changes that can be implemented safely without exploration.",
        ],
        parameters: enterPlanSchema,
        executionMode: "sequential",
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const result = await beginPlanning(ctx, { reason: params.reason, confirm: true });
            if (result.entered)
                pendingPlanningContinuation = true;
            return {
                content: [{ type: "text", text: result.message }],
                details: { entered: result.entered, plan: state?.plan },
                terminate: result.entered || undefined,
            };
        },
    });
    pi.registerTool({
        name: PLAN_WRITE_TOOL,
        label: "Write Plan",
        description: "Replace the complete canonical Plan Mode Markdown document. The final plan must contain Context, ordered Implementation Steps, and Verification, and it must present only the recommended implementation.",
        promptSnippet: "Write the complete, executable canonical implementation plan",
        promptGuidelines: [
            "Use plan_write only in Plan Mode and pass the complete plan, not a patch or fragment.",
            "Use the required sections: ## Context, ## Implementation Steps, and ## Verification.",
            "Name exact file paths and existing functions, types, or utilities to reuse in the ordered implementation steps.",
            "Include only the recommended approach; remove alternatives, unresolved options, raw exploration notes, and all template placeholders.",
            "Keep the plan concise enough to scan and detailed enough to implement without rediscovering the design.",
        ],
        parameters: planWriteSchema,
        executionMode: "sequential",
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            if (!state?.plan || (state.stage !== "planning" && state.stage !== "ready")) {
                throw new Error("plan_write is only available during an active Plan session.");
            }
            const plan = await updatePlanDocument(state.plan, params.content, params.expected_revision);
            const next = commitState({
                ...state,
                stage: "planning",
                plan,
                ready: undefined,
                approved: undefined,
            }, ctx);
            return {
                content: [
                    {
                        type: "text",
                        text: `Canonical plan updated to revision ${plan.revision}.\nPath: ${plan.path}\nSHA-256: ${plan.hash}`,
                    },
                ],
                details: { plan: next.plan },
            };
        },
    });
    pi.registerTool({
        name: EXIT_PLAN_MODE_TOOL,
        label: "Exit Plan Mode",
        description: "Mark the complete, unambiguous canonical plan ready for user approval. This ends the planning agent run; the user then runs /plan-approve.",
        promptSnippet: "Finish planning and ask the user to review the canonical plan",
        promptGuidelines: [
            "Call ExitPlanMode only after all material questions are resolved and the canonical plan satisfies the final plan content contract.",
            "Call ExitPlanMode alone in its tool-call turn.",
            "Do not begin implementation after calling it.",
        ],
        parameters: emptySchema,
        executionMode: "sequential",
        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
            if (!state?.plan || (state.stage !== "planning" && state.stage !== "ready")) {
                throw new Error("ExitPlanMode is only available during an active Plan session.");
            }
            const content = await synchronizePlan(ctx, false);
            const current = state;
            const readiness = isPlanReady(content);
            if (!readiness.ready)
                throw new Error(`Plan is not ready: ${readiness.reason}`);
            const ready = {
                revision: current.plan.revision,
                hash: current.plan.hash,
                preparedAt: new Date().toISOString(),
            };
            commitState({ ...current, stage: "ready", ready, approved: undefined }, ctx);
            if (ctx.hasUI && !ctx.ui.getEditorText().trim())
                ctx.ui.setEditorText("/plan-approve");
            ctx.ui.notify("Plan is ready. Review it and run /plan-approve.", "info");
            return {
                content: [
                    {
                        type: "text",
                        text: `Planning is complete. The user must run /plan-approve before implementation.\n\n` +
                            `## Plan revision ${ready.revision}\n\n${content}`,
                    },
                ],
                details: { plan: current.plan, ready },
                terminate: true,
            };
        },
    });
    pi.registerCommand("plan", {
        description: "Start, inspect, edit, cancel, or finish Claude-style Plan Mode",
        handler: async (args, ctx) => {
            const raw = args.trim();
            if (!raw) {
                if (!state || state.stage === "idle" || state.stage === "handed_off") {
                    const result = await beginPlanning(ctx, { confirm: false });
                    ctx.ui.notify(result.message, result.entered ? "info" : "warning");
                }
                else {
                    ctx.ui.notify(formatStateSummary(state), "info");
                }
                return;
            }
            const [command = "", ...rest] = raw.split(/\s+/);
            const normalized = command.toLowerCase();
            const task = rest.join(" ").trim();
            if (normalized === "status") {
                ctx.ui.notify(formatStateSummary(state), "info");
                return;
            }
            if (["on", "start"].includes(normalized)) {
                const result = await beginPlanning(ctx, { reason: task || undefined, confirm: false });
                ctx.ui.notify(result.message, result.entered ? "info" : "warning");
                if (result.entered && task)
                    pi.sendUserMessage(task, { expandPromptTemplates: true });
                return;
            }
            if (["off", "cancel"].includes(normalized)) {
                await leaveCurrentPlan(ctx);
                ctx.ui.notify("Plan workflow ended and the Normal profile is active.", "info");
                return;
            }
            if (normalized === "finish") {
                if (state?.stage !== "executing") {
                    ctx.ui.notify("No approved plan is currently executing.", "warning");
                    return;
                }
                await leaveCurrentPlan(ctx);
                ctx.ui.notify("Approved-plan execution finished; the Normal profile remains active.", "info");
                return;
            }
            if (normalized === "edit") {
                await editCanonicalPlan(ctx);
                return;
            }
            if (normalized === "path") {
                ctx.ui.notify(state?.plan?.path ?? "No canonical plan is active.", "info");
                return;
            }
            if (normalized === "config") {
                await openConfiguration(ctx);
                return;
            }
            if (normalized === "approve") {
                await runApprovalCommand(task, ctx);
                return;
            }
            // Treat any unrecognized text as the planning task itself. This makes
            // `/plan add prompt history` enter Plan Mode and immediately start the turn.
            if (state?.stage === "ready") {
                commitState({
                    ...state,
                    stage: "planning",
                    ready: undefined,
                    approved: undefined,
                    lastFeedback: raw,
                }, ctx);
            }
            if (!state || state.stage === "idle" || state.stage === "handed_off") {
                const result = await beginPlanning(ctx, { reason: raw, confirm: false });
                if (!result.entered) {
                    ctx.ui.notify(result.message, "warning");
                    return;
                }
            }
            if (state?.stage !== "planning") {
                ctx.ui.notify(formatStateSummary(state), "warning");
                return;
            }
            pi.sendUserMessage(raw, { expandPromptTemplates: true });
        },
    });
    pi.registerCommand("plan-approve", {
        description: "Review a ready plan and execute it in the current or a fresh child session",
        handler: runApprovalCommand,
    });
    pi.on("session_start", async (event, ctx) => {
        await restoreBranchRuntime(ctx, undefined, event.reason !== "new");
        installShiftTabToggle(ctx);
        if (pi.getFlag("plan") === true && (!state || state.stage === "idle" || state.stage === "handed_off")) {
            const result = await beginPlanning(ctx, { reason: "Started with --plan", confirm: false });
            if (!result.entered)
                ctx.ui.notify(result.message, "warning");
        }
    });
    pi.on("session_shutdown", (_event, ctx) => {
        removeShiftTabListener?.();
        removeShiftTabListener = undefined;
        pendingPlanningContinuation = false;
        ctx.ui.setStatus(PLAN_STATUS_KEY, undefined);
        ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
    });
    pi.on("agent_settled", (_event, ctx) => {
        if (!pendingPlanningContinuation)
            return;
        pendingPlanningContinuation = false;
        if (state?.stage !== "planning" || !state.plan || ctx.hasPendingMessages())
            return;
        const toolNames = activePlanningTools(state);
        const toolSummary = toolNames.length > 0 ? toolNames.join(", ") : "no optional investigation tools";
        pi.sendMessage({
            customType: PLAN_CONTINUE_MESSAGE,
            content: `Continue planning the user's request in Plan Mode using the configured tools (${toolSummary}). ` +
                `Maintain the canonical plan at ${state.plan.path} with ${PLAN_WRITE_TOOL} according to the final plan content contract, ` +
                `and call ${EXIT_PLAN_MODE_TOOL} alone when the plan is complete and unambiguous.`,
            display: false,
            details: { planId: state.plan.id, revision: state.plan.revision },
        }, { triggerTurn: true });
    });
    pi.on("session_tree", async (_event, ctx) => {
        const previousState = state;
        await restoreBranchRuntime(ctx, previousState);
    });
    pi.on("before_agent_start", (event, _ctx) => {
        if (!state)
            return;
        toolProfiles?.apply();
        const names = allToolNames();
        const planningTools = activePlanningTools(state, names);
        const modePrompt = state.stage === "planning"
            ? buildPlanningSystemPrompt(state, planningTools, planningTools.includes(ASK_USER_QUESTION_TOOL) && names.has(ASK_USER_QUESTION_TOOL))
            : state.stage === "ready"
                ? buildReadySystemPrompt(state)
                : state.stage === "executing"
                    ? buildExecutionSystemPrompt(state)
                    : "";
        if (!modePrompt)
            return;
        return { systemPrompt: `${event.systemPrompt}\n\n${modePrompt}` };
    });
    pi.on("input", (event, ctx) => {
        if (state?.stage !== "ready")
            return;
        if (event.text.trim().startsWith("/"))
            return;
        commitState({
            ...state,
            stage: "planning",
            ready: undefined,
            approved: undefined,
            lastFeedback: event.text.trim() || undefined,
        }, ctx);
        ctx.ui.notify("User feedback reopened Plan Mode. Revise the plan and call ExitPlanMode again.", "info");
    });
    pi.on("tool_call", (event, ctx) => {
        if ((event.toolName === ENTER_PLAN_MODE_TOOL || event.toolName === EXIT_PLAN_MODE_TOOL) &&
            countLatestAssistantToolCalls(ctx) > 1) {
            return {
                block: true,
                reason: `${event.toolName} must be called alone in its tool-call turn.`,
            };
        }
        if (state?.stage !== "planning" && state?.stage !== "ready")
            return;
        const names = allToolNames();
        const planningTools = activePlanningTools(state, names);
        if (isPlanningToolAllowed(event.toolName, planningTools, names))
            return;
        return {
            block: true,
            reason: `Plan Mode blocks ${event.toolName}. Allowed tools: ${buildPlanningTools(planningTools, names).join(", ")}.`,
        };
    });
    pi.on("model_select", (event, ctx) => {
        if (!state)
            return;
        if (state.stage === "planning" || state.stage === "ready") {
            commitState({
                ...state,
                planningProfile: {
                    ...(state.planningProfile ?? captureCurrentProfile(pi, ctx)),
                    provider: event.model.provider,
                    model: event.model.id,
                },
            }, ctx);
        }
        else if (state.stage === "executing") {
            commitState({
                ...state,
                executionProfile: {
                    ...(state.executionProfile ?? captureCurrentProfile(pi, ctx)),
                    provider: event.model.provider,
                    model: event.model.id,
                },
            }, ctx);
        }
    });
    pi.on("thinking_level_select", (event, ctx) => {
        if (!state)
            return;
        if (state.stage === "planning" || state.stage === "ready") {
            commitState({
                ...state,
                planningProfile: {
                    ...(state.planningProfile ?? captureCurrentProfile(pi, ctx)),
                    thinkingLevel: event.level,
                },
            }, ctx);
        }
        else if (state.stage === "executing") {
            commitState({
                ...state,
                executionProfile: {
                    ...(state.executionProfile ?? captureCurrentProfile(pi, ctx)),
                    thinkingLevel: event.level,
                },
            }, ctx);
        }
    });
    return {
        enabled: true,
        openConfig: openConfiguration,
        getState: () => state,
        getStage: () => state?.stage ?? "idle",
        applySavedConfiguration,
    };
}
export default function claudePlanModeExtension(pi) {
    registerClaudePlanMode(pi);
}
