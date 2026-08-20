import { readFile, writeFile } from "node:fs/promises";

async function patch(path, replacements) {
  let content = await readFile(path, "utf8");
  for (const [before, after, label] of replacements) {
    if (!content.includes(before)) throw new Error(`Patch target not found (${label}): ${path}`);
    content = content.replace(before, after);
  }
  await writeFile(path, content, "utf8");
}

await patch("src/profile-matrix-ui.js", [
  [
`    const pad = (value, size) => truncateToWidth(String(value), Math.max(1, size - 1), "…").padEnd(size);\n    const selectedCell = (value, rowIndex, colIndex) => rowIndex === this.row && colIndex === this.col ? this.theme.bold(value) : value;\n    const rowLabel = (label, rowIndex) => \`${'${rowIndex === this.row ? "›" : " "}'} ${'${label}'}\`;\n\n    const header = [pad("", labelWidth)];\n    PROFILE_NAMES.forEach((profile, colIndex) => {\n      const name = PROFILE_LABELS[profile].toUpperCase();\n      header.push(pad(colIndex === this.col ? \`› ${'${name}'}\` : \`  ${'${name}'}\`, profileWidth));\n    });\n\n    const lines = [\n      this.theme.bold(this.copy.title),\n      this.theme.fg("muted", header.join(" ".repeat(gap))),\n    ];\n`,
`    const pad = (value, size) => truncateToWidth(String(value), Math.max(1, size - 1), "…").padEnd(size);\n    const isSelected = (rowIndex, colIndex) => rowIndex === this.row && colIndex === this.col;\n    const styleSelected = (value) => this.theme.fg("accent", this.theme.bold(value));\n    const renderCell = (value, rowIndex, colIndex) => {\n      const padded = pad(value, profileWidth);\n      return isSelected(rowIndex, colIndex) ? styleSelected(padded) : padded;\n    };\n    const renderRowLabel = (label, rowIndex) => {\n      const padded = pad(\`${'${rowIndex === this.row ? "›" : " "}'} ${'${label}'}\`, labelWidth);\n      return rowIndex === this.row ? this.theme.fg("accent", this.theme.bold(padded)) : padded;\n    };\n    const renderHeaderCell = (profile, colIndex) => {\n      const name = PROFILE_LABELS[profile].toUpperCase();\n      const padded = pad(colIndex === this.col ? \`› ${'${name}'}\` : \`  ${'${name}'}\`, profileWidth);\n      return colIndex === this.col\n        ? this.theme.fg("accent", this.theme.bold(padded))\n        : this.theme.fg("muted", padded);\n    };\n\n    const header = [pad("", labelWidth), ...PROFILE_NAMES.map(renderHeaderCell)];\n\n    const lines = [\n      this.theme.bold(this.copy.title),\n      header.join(" ".repeat(gap)),\n    ];\n`,
    "ANSI-safe render helpers",
  ],
  [
`    lines.push([\n      pad(rowLabel(this.copy.model, MODEL_ROW), labelWidth),\n      ...modelValues.map((value, colIndex) => pad(selectedCell(value, MODEL_ROW, colIndex), profileWidth)),\n    ].join(" ".repeat(gap)));\n`,
`    lines.push([\n      renderRowLabel(this.copy.model, MODEL_ROW),\n      ...modelValues.map((value, colIndex) => renderCell(value, MODEL_ROW, colIndex)),\n    ].join(" ".repeat(gap)));\n`,
    "Model row styling",
  ],
  [
`    lines.push([\n      pad(rowLabel(this.copy.effort, EFFORT_ROW), labelWidth),\n      ...effortValues.map((value, colIndex) => pad(selectedCell(value, EFFORT_ROW, colIndex), profileWidth)),\n    ].join(" ".repeat(gap)));\n`,
`    lines.push([\n      renderRowLabel(this.copy.effort, EFFORT_ROW),\n      ...effortValues.map((value, colIndex) => renderCell(value, EFFORT_ROW, colIndex)),\n    ].join(" ".repeat(gap)));\n`,
    "Effort row styling",
  ],
  [
`      lines.push([\n        pad(rowLabel(tool.name, rowIndex), labelWidth),\n        ...values.map((value, colIndex) => pad(selectedCell(value, rowIndex, colIndex), profileWidth)),\n      ].join(" ".repeat(gap)));\n`,
`      lines.push([\n        renderRowLabel(tool.name, rowIndex),\n        ...values.map((value, colIndex) => renderCell(value, rowIndex, colIndex)),\n      ].join(" ".repeat(gap)));\n`,
    "Tool row styling",
  ],
]);

await patch("test/profile-matrix.test.mjs", [
  [
`const theme = {\n  fg(_color, text) { return String(text); },\n  bold(text) { return String(text); },\n};\n`,
`const theme = {\n  fg(_color, text) { return String(text); },\n  bold(text) { return String(text); },\n};\nconst ansiTheme = {\n  fg(color, text) {\n    const code = color === "accent" ? 36 : color === "muted" ? 90 : 37;\n    return \`\\u001b[${'${code}'}m${'${text}'}\\u001b[39m\`;\n  },\n  bold(text) { return \`\\u001b[1m${'${text}'}\\u001b[22m\`; },\n};\nconst stripAnsi = (value) => String(value).replace(/\\u001b\\[[0-9;]*m/g, "");\n`,
    "ANSI test theme",
  ],
  [
`assert.equal(readRow?.includes("["), false, "tool toggles should not use small bracket markers");\n\n// Left/right selects the profile column; up/down selects Model/Effort/tool rows.\n`,
`assert.equal(readRow?.includes("["), false, "tool toggles should not use small bracket markers");\n\n// ANSI styling must never change visible column positions. Reproduce the\n// reported bug by selecting Normal/read while Plan remains unselected.\nconst ansiComponent = new __test.ProfileMatrixComponent({\n  tui: { requestRender() {} },\n  theme: ansiTheme,\n  done: () => {},\n  config: structuredClone(config),\n  defaults,\n  tools,\n  phaseProfiles,\n  copyText: {\n    title: "Only Tools",\n    subtitle: "",\n    model: "Model",\n    effort: "Effort",\n    modelCurrent: "Pi current",\n    effortCurrent: "Pi current",\n    selected: "Selected",\n    lockedRequired: "required",\n    lockedControl: "control",\n    unregistered: "unregistered",\n    editModel: "edit model",\n    editEffort: "edit effort",\n    help: "help",\n  },\n  initialRow: 2,\n  initialCol: 0,\n});\nconst ansiRendered = ansiComponent.render(120).map(stripAnsi);\nconst ansiModelRow = ansiRendered.find((line) => line.includes("normal/normal-model") && line.includes("planner/planner-model"));\nconst ansiReadRow = ansiRendered.find((line) => line.includes("read"));\nassert.ok(ansiModelRow && ansiReadRow);\nconst planColumn = ansiModelRow.indexOf("planner/planner-model");\nassert.equal(ansiReadRow.lastIndexOf("○"), planColumn, "Plan tool glyph must stay aligned when the Normal cell is ANSI-styled");\n\n// Selected header/row/cell should receive accent styling.\nconst ansiRaw = ansiComponent.render(120);\nassert.ok(ansiRaw.some((line) => line.includes("\\u001b[36m") && stripAnsi(line).includes("NORMAL")));\nassert.ok(ansiRaw.some((line) => line.includes("\\u001b[36m") && stripAnsi(line).includes("read")));\n\n// Left/right selects the profile column; up/down selects Model/Effort/tool rows.\n`,
    "ANSI alignment regression",
  ],
]);

await patch("package.json", [
  ['"version": "0.5.2"', '"version": "0.5.3"', "version bump"],
]);

await patch("CHANGELOG.md", [
  [
    "# Changelog\n\n",
    "# Changelog\n\n## 0.5.3\n\n- Fix Profile matrix column drift when the selected cell contains ANSI styling by padding plain text before applying color/bold.\n- Highlight the selected profile header, row label, and cell with the accent color while preserving fixed visual column widths.\n- Add an ANSI-aware regression test that locks Normal/Plan tool-column alignment.\n\n",
    "changelog",
  ],
]);

console.log("Applied ANSI-safe matrix alignment and selection highlighting.");
