/** Dispatch automatic review through Pi so it receives a command context, not an event context. */
export function createPlanReviewController(pi) {
  let pending = false;

  pi.on("agent_settled", (_event, ctx) => {
    if (!pending || ctx.hasPendingMessages?.()) return;
    pending = false;
    if (ctx.hasUI && typeof pi.sendUserMessage === "function") {
      pi.sendUserMessage("/plan-approve", { expandPromptTemplates: true });
    } else {
      ctx.ui?.notify("Plan is ready. Run /plan-approve keep or /plan-approve clear.", "info");
    }
  });
  for (const event of ["session_start", "session_tree", "session_shutdown"]) {
    pi.on(event, () => { pending = false; });
  }

  return {
    request() { pending = true; },
    clear() { pending = false; },
  };
}
