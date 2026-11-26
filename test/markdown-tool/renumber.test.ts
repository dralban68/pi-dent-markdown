import assert from "node:assert/strict";
import { test } from "node:test";
import type { MarkdownRuntime } from "../../lib/markdown-tool.ts";
import { bytesOf, call, cleanupRoots, revisionOf, runtime, tempDir, write } from "./support.ts";
import { must } from "../support/must.ts";

/**
 * specs/markdown-tool.md#renumbering: the groups, the bases, the conditions a
 * group is renumbered under, auto-numbering, the top-down order, and the worked
 * examples of the section, verbatim.
 */

/** The headings of the file in a directory, as `#* text`, from the outline's entries (specs/markdown-tool.md#action-outline). */
async function headingsOf(instance: MarkdownRuntime, dir: string, name: string): Promise<string[]> {
  const outcome = await call(instance, dir, { action: "outline", path: name, depth: 6 });
  if (outcome.isError) throw new Error(outcome.text);
  const entries = outcome.details.entries;
  if (!Array.isArray(entries)) throw new Error(`no entries in ${outcome.text}`);
  return entries.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("address" in entry)) {
      throw new Error("entry without an address");
    }
    if (!("level" in entry) || typeof entry.level !== "number")
      throw new Error("entry without a level");
    if (typeof entry.address !== "string") throw new Error("entry address is not a string");
    // The last component of an address is the section's own component (specs/markdown-tool.md#section-addresses).
    const component = must(entry.address.split(" > ").at(-1));
    return `${"#".repeat(entry.level)} ${component}`;
  });
}

interface Edited {
  file: string;
  headings: string[];
  lines: string[];
  details: Record<string, unknown>;
  isError: boolean;
}

async function edit(text: string, operations: Record<string, unknown>[]): Promise<Edited> {
  const dir = tempDir();
  try {
    const name = write(dir, "a.md", text);
    const instance = runtime();
    const revision = await revisionOf(instance, dir, name);
    const outcome = await call(instance, dir, { action: "edit", path: name, revision, operations });
    return {
      file: bytesOf(dir, name),
      headings: await headingsOf(instance, dir, name),
      lines: outcome.lines,
      details: outcome.details,
      isError: outcome.isError,
    };
  } finally {
    cleanupRoots();
  }
}

const SPEC = [
  "# Spec",
  "",
  "intro",
  "",
  "## 1. Tool registration surface",
  "",
  "text",
  "",
  "### 1.1 Parameter schema",
  "",
  "text",
  "",
  "### 1.2 Validation",
  "",
  "text",
  "",
  "## 2. Scope",
  "",
  "text",
  "",
  "### 2.1 Reach",
  "",
  "text",
  "",
  "### 2.2 Coverage",
  "",
  "text",
  "",
  "### 2.3 Abort",
  "",
  "text",
  "",
  "## 3. Action find",
  "",
  "text",
  "",
  "### 3.1 Candidates",
  "",
  "text",
  "",
  "### 3.2 Matching",
  "",
  "text",
  "",
  "### 3.3 Evaluation",
  "",
  "text",
  "",
  "### 3.4 Result",
  "",
  "text",
  "",
  "## 4. Action get",
  "",
  "text",
  "",
  "## 5. Action sessions",
  "",
  "text",
  "",
  "## 6. Normative references",
  "",
  "text",
  "",
].join("\n");

test("specs/markdown-tool.md#renumbering: moving 3.2 Matching after 3.4 Result renumbers its group", async () => {
  const outcome = await edit(SPEC, [
    { op: "move", section: "3.2 Matching", position: "after", at: "3.4 Result" },
  ]);
  assert.equal(outcome.isError, false);
  const found = outcome.headings.filter((heading) => heading.startsWith("### 3."));
  assert.deepEqual(found, [
    "### 3.1 Candidates",
    "### 3.2 Evaluation",
    "### 3.3 Result",
    "### 3.4 Matching",
  ]);
  assert.deepEqual(outcome.details.renumbered, [
    { start: 41, level: 3, from: "3.3 Evaluation", to: "3.2 Evaluation" },
    { start: 45, level: 3, from: "3.4 Result", to: "3.3 Result" },
    { start: 49, level: 3, from: "3.2 Matching", to: "3.4 Matching" },
  ]);
});

test("specs/markdown-tool.md#renumbering: moving ## 4. Action get under ## 2. Scope renumbers it and the later sections", async () => {
  const outcome = await edit(SPEC, [
    { op: "move", section: "4. Action get", position: "last", at: "2. Scope" },
  ]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.headings, [
    "# Spec",
    "## 1. Tool registration surface",
    "### 1.1 Parameter schema",
    "### 1.2 Validation",
    "## 2. Scope",
    "### 2.1 Reach",
    "### 2.2 Coverage",
    "### 2.3 Abort",
    "### 2.4 Action get",
    "## 3. Action find",
    "### 3.1 Candidates",
    "### 3.2 Matching",
    "### 3.3 Evaluation",
    "### 3.4 Result",
    "## 4. Action sessions",
    "## 5. Normative references",
  ]);
});

test("specs/markdown-tool.md#renumbering: moving an unnumbered section auto-numbers its unnumbered and numbered subsections", async () => {
  const base = [
    "## 1. A",
    "",
    "### 1.1 X",
    "",
    "## 2. B",
    "",
    "## Notes",
    "",
    "### Alpha",
    "",
    "### Beta",
    "",
  ].join("\n");
  const first = await edit(base, [{ op: "move", section: "Notes", position: "last", at: "1. A" }]);
  assert.equal(first.isError, false);
  assert.deepEqual(first.headings.slice(first.headings.indexOf("### 1.2 Notes")), [
    "### 1.2 Notes",
    "#### 1.2.1 Alpha",
    "#### 1.2.2 Beta",
    "## 2. B",
  ]);
  const numbered = base.replace("### Alpha", "### 7.1 Alpha").replace("### Beta", "### 7.2 Beta");
  const second = await edit(numbered, [
    { op: "move", section: "Notes", position: "last", at: "1. A" },
  ]);
  assert.deepEqual(second.headings.slice(second.headings.indexOf("### 1.2 Notes")), [
    "### 1.2 Notes",
    "#### 1.2.1 Alpha",
    "#### 1.2.2 Beta",
    "## 2. B",
  ]);
  assert.deepEqual(second.details.renumbered, [
    { start: 5, level: 3, from: "Notes", to: "1.2 Notes" },
    { start: 7, level: 4, from: "7.1 Alpha", to: "1.2.1 Alpha" },
    { start: 9, level: 4, from: "7.2 Beta", to: "1.2.2 Beta" },
  ]);
});

test("specs/markdown-tool.md#renumbering: moving a numbered section carries its subsections to its new number", async () => {
  const text = [
    "# Doc",
    "",
    "## 1. One",
    "",
    "text",
    "",
    "## 2. Two",
    "",
    "text",
    "",
    "## 3. Three",
    "",
    "text",
    "",
    "### 3.1 Child",
    "",
    "text",
    "",
  ].join("\n");
  const outcome = await edit(text, [
    { op: "move", section: "3. Three", position: "last", at: "1. One" },
  ]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.headings, [
    "# Doc",
    "## 1. One",
    "### 1.1 Three",
    "#### 1.1.1 Child",
    "## 2. Two",
  ]);
});

test("specs/markdown-tool.md#renumbering: an inserted ## Overview with subsections is numbered, and the later sections shift", async () => {
  const outcome = await edit(SPEC, [
    {
      op: "insert",
      position: "after",
      at: "1. Tool registration surface",
      content: "## Overview\n\n### Goals\n\ntext\n\n### Limits\n\ntext",
    },
  ]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.headings, [
    "# Spec",
    "## 1. Tool registration surface",
    "### 1.1 Parameter schema",
    "### 1.2 Validation",
    "## 2. Overview",
    "### 2.1 Goals",
    "### 2.2 Limits",
    "## 3. Scope",
    "### 3.1 Reach",
    "### 3.2 Coverage",
    "### 3.3 Abort",
    "## 4. Action find",
    "### 4.1 Candidates",
    "### 4.2 Matching",
    "### 4.3 Evaluation",
    "### 4.4 Result",
    "## 5. Action get",
    "## 6. Action sessions",
    "## 7. Normative references",
  ]);
});

test("specs/markdown-tool.md#renumbering: written subsection numbers are corrected, and a flat group stays flat", async () => {
  const corrected = await edit(SPEC, [
    {
      op: "insert",
      position: "after",
      at: "1. Tool registration surface",
      content: "## Overview\n\n### 9.1 Goals\n\ntext\n\n### 9.3 Limits\n\ntext",
    },
  ]);
  assert.deepEqual(corrected.headings.slice(4, 7), [
    "## 2. Overview",
    "### 2.1 Goals",
    "### 2.2 Limits",
  ]);
  const flat = await edit(SPEC, [
    {
      op: "insert",
      position: "after",
      at: "1. Tool registration surface",
      content: "## Overview\n\n### 1. Goals\n\ntext\n\n### 3. Limits\n\ntext",
    },
  ]);
  assert.deepEqual(flat.headings.slice(4, 7), ["## 2. Overview", "### 1. Goals", "### 2. Limits"]);
});

test("specs/markdown-tool.md#renumbering: a changelog's version headings are left as written", async () => {
  const text = [
    "# Log",
    "",
    "## 5. Notes",
    "",
    "text",
    "",
    "### 1.2.0 Fixed",
    "",
    "fixed",
    "",
    "### 1.1.0 Added",
    "",
    "added",
    "",
  ].join("\n");
  const outcome = await edit(text, [
    { op: "insert", position: "last", at: "5. Notes", content: "### Later\n\nmore" },
  ]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.headings, [
    "# Log",
    "## 5. Notes",
    "### 1.2.0 Fixed",
    "### 1.1.0 Added",
    "### Later",
  ]);
  assert.deepEqual(outcome.details.skipped, [
    { parent: "Log > 5. Notes", numbers: ["1.2.0", "1.1.0"] },
  ]);
  assert.equal(
    must(outcome.lines[outcome.lines.length - 1]),
    "Numbering left as written under Log > 5. Notes: its numbers 1.2.0, 1.1.0 are not in sequence",
  );

  const top = ["# Log", "", "## 1.2.0 Fixed", "", "x", "", "## 1.1.0 Added", "", "y", ""].join(
    "\n",
  );
  const appended = await edit(top, [
    { op: "insert", position: "last", at: "(document)", content: "## 2.0.0 Next\n\nz" },
  ]);
  assert.deepEqual(appended.headings, [
    "# Log",
    "## 1.2.0 Fixed",
    "## 1.1.0 Added",
    "## 2.0.0 Next",
  ]);
  assert.deepEqual(appended.details.skipped, [
    { parent: "Log", numbers: ["1.2.0", "1.1.0", "2.0.0"] },
  ]);
});

test("specs/markdown-tool.md#renumbering: a 0-based group keeps its numbers", async () => {
  const text = ["# Doc", "", "## 0. Intro", "", "text", "", "## 1. Body", "", "text", ""].join(
    "\n",
  );
  const outcome = await edit(text, [
    { op: "insert", position: "last", at: "(document)", content: "## Appendix\n\nmore" },
  ]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.headings, ["# Doc", "## 0. Intro", "## 1. Body", "## 2. Appendix"]);
  assert.deepEqual(outcome.details.renumbered, [
    { start: 11, level: 2, from: "Appendix", to: "2. Appendix" },
  ]);
});

test("specs/markdown-tool.md#renumbering: a moved unnumbered section gets a number only in a numbered group with a base", async () => {
  const text = [
    "# Doc",
    "",
    "## One",
    "",
    "text",
    "",
    "## Two",
    "",
    "text",
    "",
    "## 3. Three",
    "",
    "text",
    "",
    "### 3.1 Child",
    "",
    "text",
    "",
  ].join("\n");
  const moved = await edit(text, [
    { op: "move", section: "Two", position: "after", at: "3.1 Child" },
  ]);
  assert.deepEqual(moved.headings, [
    "# Doc",
    "## One",
    "## 3. Three",
    "### 3.1 Child",
    "### 3.2 Two",
  ]);
  const within = await edit(text, [{ op: "move", section: "One", position: "after", at: "Two" }]);
  assert.deepEqual(within.headings, ["# Doc", "## Two", "## One", "## 3. Three", "### 3.1 Child"]);
});

test("specs/markdown-tool.md#renumbering: renumbering runs from the top down, so a later section's subsections follow its new number", async () => {
  const outcome = await edit(SPEC, [{ op: "delete", section: "2. Scope" }]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.headings, [
    "# Spec",
    "## 1. Tool registration surface",
    "### 1.1 Parameter schema",
    "### 1.2 Validation",
    "## 2. Action find",
    "### 2.1 Candidates",
    "### 2.2 Matching",
    "### 2.3 Evaluation",
    "### 2.4 Result",
    "## 3. Action get",
    "## 4. Action sessions",
    "## 5. Normative references",
  ]);
});

test("specs/markdown-tool.md#renumbering: a replacing section without a number takes one in a numbered group, and a deleted one is reported", async () => {
  const outcome = await edit(SPEC, [
    { op: "delete", section: "3.2 Matching" },
    { op: "replace", section: "3.3 Evaluation", content: "### Notes\n\nnew text" },
  ]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.headings.slice(8, 12), [
    "## 3. Action find",
    "### 3.1 Candidates",
    "### 3.2 Notes",
    "### 3.3 Result",
  ]);
  assert.deepEqual(outcome.details.removed, [
    { start: 41, end: 43, level: 3, text: "3.2 Matching", subsections: 0 },
    { start: 45, end: 47, level: 3, text: "3.3 Evaluation", subsections: 0 },
  ]);
});

test("specs/markdown-tool.md#renumbering: a setext member whose prefix changes is rewritten as an ATX heading of its level", async () => {
  const text = ["# Doc", "", "## 1. One", "", "text", "", "2 Two", "-----", "", "text", ""].join(
    "\n",
  );
  const outcome = await edit(text, [{ op: "delete", section: "1. One" }]);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.file, ["# Doc", "", "## 1. Two", "", "text", ""].join("\n"));
  assert.deepEqual(outcome.details.renumbered, [
    { start: 3, level: 2, from: "2 Two", to: "1. Two" },
  ]);
});

test("specs/markdown-tool.md#renumbering: an unnumbered group under an unnumbered parent stays unnumbered", async () => {
  const text = ["# Doc", "", "## One", "", "### A", "", "text", "", "### B", "", "text", ""].join(
    "\n",
  );
  const outcome = await edit(text, [
    { op: "insert", position: "last", at: "One", content: "### C\n\ntext" },
  ]);
  assert.deepEqual(outcome.headings, ["# Doc", "## One", "### A", "### B", "### C"]);
  assert.deepEqual(outcome.details.renumbered, []);
  assert.deepEqual(outcome.details.skipped, []);
});
