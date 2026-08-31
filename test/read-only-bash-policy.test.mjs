import assert from "node:assert/strict";
import {
  ASK_MODE_FORBIDDEN_TOOLS,
  DEFAULT_ASK_TOOLS,
  buildAskSystemPrompt,
  isAskToolConfigurable,
  normalizeAskTools,
} from "../src/ask-mode-policy.js";
import { STABLE_MODE_SYSTEM_PROMPT } from "../src/cache-stable-mode.js";
import { READ_ONLY_PLAN_TOOLS } from "../src/plan/constants.js";
import { buildPlanningSystemPrompt } from "../src/plan/prompts.js";

assert.equal(READ_ONLY_PLAN_TOOLS.includes("bash"), true);
assert.equal(DEFAULT_ASK_TOOLS.includes("bash"), true);
assert.equal(ASK_MODE_FORBIDDEN_TOOLS.includes("bash"), false);
assert.equal(isAskToolConfigurable("bash"), true);
assert.equal(isAskToolConfigurable("shell_command"), false);
assert.deepEqual(
  normalizeAskTools(["read", "bash", "shell_command", "apply_patch", "bash"]),
  ["read", "bash"],
);

const askPrompt = buildAskSystemPrompt(["read", "bash"]);
assert.match(
  askPrompt,
  /bash may be used only for commands required by an enabled skill or for read-only inspection/i,
);
assert.match(
  askPrompt,
  /Do not create, modify, move, rename, or delete files, including through bash/i,
);
assert.match(askPrompt, /Do not use bash to bypass a blocked editing or write tool/i);
assert.doesNotMatch(askPrompt, /Do not run shell commands, scripts, builds, tests, installers/);

const planningPrompt = buildPlanningSystemPrompt(
  {
    plan: {
      path: "/tmp/plan.md",
      revision: 1,
      hash: "abc",
    },
  },
  ["read", "bash", "plan_write"],
  false,
);
assert.match(
  planningPrompt,
  /bash may be used only for commands required by an enabled skill or for read-only repository inspection/i,
);
assert.match(
  planningPrompt,
  /Do not create, modify, move, rename, or delete project files through bash or any other tool/i,
);
assert.match(planningPrompt, /Never use bash to write it/i);
assert.match(planningPrompt, /`bash`/);

assert.match(
  STABLE_MODE_SYSTEM_PROMPT,
  /bash may be used only for commands required by an enabled skill or for read-only inspection/i,
);
assert.match(
  STABLE_MODE_SYSTEM_PROMPT,
  /Do not create, modify, move, rename, or delete project files through bash or any other tool/i,
);
assert.match(
  STABLE_MODE_SYSTEM_PROMPT,
  /Never use bash to write the canonical plan document/i,
);

console.log("Ask/Plan Bash access and no-write prompt policy tests passed");
