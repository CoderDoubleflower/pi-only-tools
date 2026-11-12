import { spawn } from "node:child_process";

const TERMINATION_GRACE_MS = 750;
const PIPE_DRAIN_GRACE_MS = 750;

export function isProcessSuccess(details) {
  return details.exitCode === 0 && !details.spawnError && !details.aborted &&
    !details.timedOut && !details.signal;
}

// Call immediately after spawn, before invoking update callbacks or writing stdin.
// A shell can exit while a descendant still owns its pipes or ignores SIGTERM.
// Supervise the detached process group, not just the shell's exit status.
export function waitForProcess(child, { signal, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let terminating = false;
    let escalated = false;
    let timedOut = false;
    let aborted = false;
    let closed;
    let timeout;
    let forceTimer;
    let drainTimer;

    const leaderRunning = () => child.exitCode === null && child.signalCode === null;
    const groupExists = () => {
      if (process.platform === "win32" || !child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error?.code === "EPERM";
      }
    };
    const signalGroup = (name) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, name);
      } catch {
        // Never signal a recycled leader PID after the child has already exited.
        if (leaderRunning()) {
          try { child.kill(name); } catch {}
        }
      }
    };
    const finish = (terminal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      clearTimeout(drainTimer);
      signal?.removeEventListener("abort", abort);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      resolve({ ...terminal, timedOut, aborted });
    };
    const terminate = () => {
      if (terminating || settled) return;
      terminating = true;
      clearTimeout(timeout);
      if (process.platform === "win32") {
        if (child.pid) {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.on("error", () => {
            if (leaderRunning()) {
              try { child.kill(); } catch {}
            }
          });
          killer.unref();
        }
      } else {
        signalGroup("SIGTERM");
        forceTimer = setTimeout(() => {
          escalated = true;
          signalGroup("SIGKILL");
          if (closed) finish(closed);
        }, TERMINATION_GRACE_MS);
      }
      // A detached descendant can escape the group but retain inherited pipes.
      // Closing our read ends bounds cancellation even when no close event arrives.
      drainTimer = setTimeout(() => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(closed ?? {
          exitCode: child.exitCode,
          signal: child.signalCode,
          spawnError: null,
        });
      }, TERMINATION_GRACE_MS + PIPE_DRAIN_GRACE_MS);
    };
    const abort = () => {
      if (terminating || settled) return;
      aborted = true;
      terminate();
    };
    const onError = (error) => finish({
      exitCode: null,
      signal: null,
      spawnError: error.message,
    });
    const onClose = (exitCode, closeSignal) => {
      closed = { exitCode, signal: closeSignal, spawnError: null };
      // Keep escalation scheduled for surviving descendants even if all pipes close.
      if (terminating && !escalated && groupExists()) return;
      finish(closed);
    };

    child.once("error", onError);
    child.once("close", onClose);
    signal?.addEventListener("abort", abort, { once: true });
    // Abort may happen between the caller's initial check and listener installation.
    if (signal?.aborted) abort();
    if (!terminating && timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        if (terminating || settled) return;
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeout.unref?.();
    }
  });
}
