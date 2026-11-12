/** Slash commands may run while Pi is streaming; tool handlers must never wait on their own run. */
export async function waitForModeCommandIdle(ctx) {
  if (ctx.isIdle?.() === true) return;
  if (typeof ctx.waitForIdle === "function") {
    await ctx.waitForIdle();
    return;
  }
  if (ctx.isIdle?.() === false) {
    throw new Error("Wait for the current agent turn to finish before changing modes.");
  }
}
