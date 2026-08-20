export function captureCurrentProfile(pi, ctx) {
    return {
        provider: ctx.model?.provider,
        model: ctx.model?.id,
        thinkingLevel: pi.getThinkingLevel(),
    };
}
export function resolvePhaseProfile(baseline, configured) {
    return {
        provider: configured.provider ?? baseline.provider,
        model: configured.model ?? baseline.model,
        thinkingLevel: configured.thinkingLevel ?? baseline.thinkingLevel,
    };
}
function sameModel(current, profile) {
    return current !== undefined && current.provider === profile.provider && current.id === profile.model;
}
async function selectProfileModel(pi, ctx, profile) {
    if (!profile.provider || !profile.model)
        return { ok: true };
    if (sameModel(ctx.model, profile))
        return { ok: true };
    const model = ctx.modelRegistry.find(profile.provider, profile.model);
    if (!model)
        return { ok: false, reason: `Model ${profile.provider}/${profile.model} was not found.` };
    const selected = await pi.setModel(model);
    if (!selected)
        return { ok: false, reason: `No credentials are available for ${profile.provider}/${profile.model}.` };
    return { ok: true };
}
export async function applyProfile(pi, ctx, target, fallback, label) {
    const selected = await selectProfileModel(pi, ctx, target);
    if (!selected.ok) {
        ctx.ui.notify(`${label}: ${selected.reason} Falling back to the pre-Plan model.`, "warning");
        const fallbackSelection = await selectProfileModel(pi, ctx, fallback);
        if (!fallbackSelection.ok) {
            ctx.ui.notify(`${label}: ${fallbackSelection.reason} Keeping the current model.`, "warning");
        }
    }
    pi.setThinkingLevel(selected.ok ? target.thinkingLevel : fallback.thinkingLevel);
}
