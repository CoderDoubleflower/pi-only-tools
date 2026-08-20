import { readFile, writeFile } from "node:fs/promises";

async function replaceOnce(path, search, replacement, label) {
  const content = await readFile(path, "utf8");
  const first = content.indexOf(search);
  if (first < 0) throw new Error(`Patch target not found: ${label}`);
  if (content.indexOf(search, first + search.length) >= 0) throw new Error(`Patch target not unique: ${label}`);
  await writeFile(path, content.slice(0, first) + replacement + content.slice(first + search.length), "utf8");
}

const oldOpenSettings = `  const openSettings = async (args, ctx) => {
    const requested = args.trim().toLowerCase();
    if (["plan", "plan-mode", "profile:plan"].includes(requested)) {
      await planMode.openConfig(ctx);
      return;
    }
    if (["status", "profiles", "profile"].includes(requested)) {
      if (requested === "status" || ctx.mode !== "tui") {
        ctx.ui.notify(JSON.stringify({ planStage: planMode.getStage?.(), ...toolProfiles.snapshot() }, null, 2), "info");
        return;
      }
      const labels = isChineseLocale()
        ? { title: "工具 Profile", session: "会话工具", plan: "Plan 模式", status: "显示有效 Profile", close: "关闭" }
        : { title: "Tool profiles", session: "Session tools", plan: "Plan Mode", status: "Show effective profiles", close: "Close" };
      const choice = await ctx.ui.select(labels.title, [labels.session, labels.plan, labels.status, labels.close]);
      if (choice === labels.session) await openSessionSettings(ctx);
      else if (choice === labels.plan) await planMode.openConfig(ctx);
      else if (choice === labels.status) ctx.ui.notify(JSON.stringify({ planStage: planMode.getStage?.(), ...toolProfiles.snapshot() }, null, 2), "info");
      return;
    }
    await openSessionSettings(ctx);
  };`;

const newOpenSettings = `  const openProfileMenu = async (ctx) => {
    const labels = isChineseLocale()
      ? { title: "工具 Profile", session: "会话工具", plan: "Plan 模式", status: "显示有效 Profile", close: "关闭" }
      : { title: "Tool profiles", session: "Session tools", plan: "Plan Mode", status: "Show effective profiles", close: "Close" };
    const choice = await ctx.ui.select(labels.title, [labels.session, labels.plan, labels.status, labels.close]);
    if (choice === labels.session) await openSessionSettings(ctx);
    else if (choice === labels.plan) await planMode.openConfig(ctx);
    else if (choice === labels.status) {
      ctx.ui.notify(JSON.stringify({ planStage: planMode.getStage?.(), ...toolProfiles.snapshot() }, null, 2), "info");
    }
  };

  const openSettings = async (args, ctx) => {
    const requested = args.trim().toLowerCase();
    if (["plan", "plan-mode", "profile:plan"].includes(requested)) {
      await planMode.openConfig(ctx);
      return;
    }
    if (requested === "status") {
      ctx.ui.notify(JSON.stringify({ planStage: planMode.getStage?.(), ...toolProfiles.snapshot() }, null, 2), "info");
      return;
    }
    if (requested === "" || ["profiles", "profile"].includes(requested)) {
      if (ctx.mode !== "tui") {
        if (requested === "") await openSessionSettings(ctx);
        else ctx.ui.notify(JSON.stringify({ planStage: planMode.getStage?.(), ...toolProfiles.snapshot() }, null, 2), "info");
        return;
      }
      await openProfileMenu(ctx);
      return;
    }
    await openSessionSettings(ctx);
  };`;

await replaceOnce("src/index.js", oldOpenSettings, newOpenSettings, "openSettings profile routing");

const testPath = "test/test.mjs";
let test = await readFile(testPath, "utf8");
const oldHelperCall = `  await commands.get("only-tools").handler("", {\n    mode: "tui",`;
const newHelperCall = `  await commands.get("only-tools").handler("session", {\n    mode: "tui",`;
const helperIndex = test.indexOf(oldHelperCall, test.indexOf("async function openToolSettings"));
if (helperIndex < 0) throw new Error("openToolSettings command call not found");
test = test.slice(0, helperIndex) + newHelperCall + test.slice(helperIndex + oldHelperCall.length);

const testMarker = `\nconst theme = {\n`;
if (!test.includes(testMarker)) throw new Error("test theme marker not found");
const menuRegression = `
// Bare /only-tools opens the top-level profile menu so Plan configuration is discoverable.
let topLevelMenu;
await commands.get("only-tools").handler("", {
  mode: "tui",
  cwd: temp,
  sessionManager,
  ui: {
    notify(message, type) {
      notifications.push({ message, type });
    },
    async select(title, options) {
      topLevelMenu = { title, options: [...options] };
      return "Close";
    },
  },
});
assert.equal(topLevelMenu.title, "Tool profiles");
assert.deepEqual(topLevelMenu.options, ["Session tools", "Plan Mode", "Show effective profiles", "Close"]);
`;
test = test.replace(testMarker, `${menuRegression}${testMarker}`);
await writeFile(testPath, test, "utf8");

for (const path of ["package.json", "package-lock.json"]) {
  const json = JSON.parse(await readFile(path, "utf8"));
  json.version = "0.4.2";
  if (path === "package-lock.json" && json.packages?.[""]) json.packages[""].version = "0.4.2";
  await writeFile(path, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

const changelogPath = "CHANGELOG.md";
let changelog = await readFile(changelogPath, "utf8");
const heading = "## 0.4.1";
if (!changelog.includes(heading)) throw new Error("0.4.1 changelog heading not found");
changelog = changelog.replace(
  heading,
  "## 0.4.2\n\n- Make bare `/only-tools` open the top-level Tool profiles menu.\n- Surface Plan Mode configuration directly from the default `/only-tools` UI.\n- Keep the legacy session tool editor available under Session tools and `/only-tools session`.\n- Add a regression test locking the top-level menu contents.\n\n## 0.4.1",
);
await writeFile(changelogPath, changelog, "utf8");

console.log("Default /only-tools Plan menu fix applied.");
