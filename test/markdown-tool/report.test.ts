import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bytesOf,
  call,
  cleanupRoots,
  revisionOf,
  runtime,
  stringField,
  tempDir,
  write,
} from "./support.ts";
import { must } from "../support/must.ts";

/**
 * specs/markdown-tool.md specs/markdown-tool.md#edit-result: the marks each operation leaves, the
 * touched sections and their ancestors, the removed, renumbered, and skipped
 * blocks, and the `details` shape.
 */

const DOCUMENT = [
  "# Doc",
  "",
  "intro",
  "",
  "## One",
  "",
  "body one",
  "",
  "### One A",
  "",
  "text a",
  "",
  "### One B",
  "",
  "text b",
  "",
  "## Two",
  "",
  "body two",
  "",
].join("\n");

interface Edited {
  lines: string[];
  details: Record<string, unknown>;
  isError: boolean;
  text: string;
}

async function edit(text: string, operations: Record<string, unknown>[]): Promise<Edited> {
  const dir = tempDir();
  try {
    const name = write(dir, "a.md", text);
    const instance = runtime();
    const revision = await revisionOf(instance, dir, name);
    const outcome = await call(instance, dir, { action: "edit", path: name, revision, operations });
    assert.equal(bytesOf(dir, name).length > 0, true);
    return {
      lines: outcome.lines,
      details: outcome.details,
      isError: outcome.isError,
      text: outcome.text,
    };
  } finally {
    cleanupRoots();
  }
}

test("specs/markdown-tool.md#edit-result: a rename lists the touched section and its ancestors in document order", async () => {
  const outcome = await edit(DOCUMENT, [{ op: "rename", section: "One A", heading: "Renamed" }]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.lines.slice(1), [
    "  1-19 # Doc (+2 hidden)",
    "  5-15 ## One (+1 hidden)",
    "* 9-11 ### Renamed",
  ]);
  assert.deepEqual(outcome.details.touched, [
    { address: "Doc > One > Renamed", level: 3, start: 9, end: 11 },
  ]);
  assert.deepEqual(outcome.details.removed, []);
  assert.deepEqual(outcome.details.renumbered, []);
  assert.deepEqual(outcome.details.skipped, []);
});

test("specs/markdown-tool.md#edit-result: a delete marks the parent, and the words stay plural for one", async () => {
  const outcome = await edit(DOCUMENT, [{ op: "delete", section: "One A" }]);
  assert.equal(outcome.isError, false);
  assert.match(
    must(outcome.lines[0]),
    /^Edited a\.md: 1 operations · 15 lines · revision [0-9a-f]{8}$/,
  );
  assert.deepEqual(outcome.lines.slice(1), [
    "  1-15 # Doc (+2 hidden)",
    "* 5-11 ## One (+1 hidden)",
    "1 sections removed or overwritten:",
    "  9-11 ### One A (3 lines, 0 subsections)",
  ]);
  assert.deepEqual(outcome.details.touched, [
    { address: "Doc > One", level: 2, start: 5, end: 11 },
  ]);
});

test("specs/markdown-tool.md#edit-result: a delete of a section with no parent leaves no mark", async () => {
  const text = ["# A", "", "text", "", "# B", "", "text", ""].join("\n");
  const outcome = await edit(text, [{ op: "delete", section: "B" }]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.lines, [
    must(outcome.lines[0]),
    "1 sections removed or overwritten:",
    "  5-7 # B (3 lines, 0 subsections)",
  ]);
  assert.deepEqual(outcome.details.touched, []);
  assert.deepEqual(outcome.details.removed, [
    { start: 5, end: 7, level: 1, text: "B", subsections: 0 },
  ]);
});

test("specs/markdown-tool.md#edit-result: replace_body of (preamble) marks no line", async () => {
  const text = ["intro", "", "# A", "", "text", ""].join("\n");
  const outcome = await edit(text, [
    { op: "replace_body", section: "(preamble)", content: "new intro" },
  ]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.lines.slice(1), []);
  assert.deepEqual(outcome.details.touched, []);
});

test("specs/markdown-tool.md#edit-result: replace and insert mark the heading line of the first heading they wrote", async () => {
  const replaced = await edit(DOCUMENT, [
    { op: "replace", section: "One A", content: "### New A\n\ntext new" },
  ]);
  assert.deepEqual(replaced.details.touched, [
    { address: "Doc > One > New A", level: 3, start: 9, end: 11 },
  ]);
  assert.deepEqual(replaced.lines.slice(1), [
    "  1-19 # Doc (+2 hidden)",
    "  5-15 ## One (+1 hidden)",
    "* 9-11 ### New A",
    "1 sections removed or overwritten:",
    "  9-11 ### One A (3 lines, 0 subsections)",
  ]);
  const inserted = await edit(DOCUMENT, [
    { op: "insert", position: "first", at: "Two", content: "### Added\n\ntext" },
  ]);
  assert.deepEqual(inserted.details.touched, [
    { address: "Doc > Two > Added", level: 3, start: 21, end: 23 },
  ]);
});

test("specs/markdown-tool.md#edit-result: a mark stays with its line through later operations", async () => {
  const outcome = await edit(DOCUMENT, [
    { op: "delete", section: "One B" },
    { op: "rename", section: "One A", heading: "Renamed" },
    { op: "move", section: "Renamed", position: "last", at: "Two" },
  ]);
  assert.equal(outcome.isError, false);
  const touched = outcome.details.touched;
  assert.equal(Array.isArray(touched), true);
  const list = touched as Record<string, unknown>[];
  assert.deepEqual(
    list.map((entry) => entry.address),
    ["Doc > One", "Doc > Two > Renamed"],
  );
});

test("specs/markdown-tool.md#edit-result: the removed block lists the headings in their order before the call", async () => {
  const outcome = await edit(DOCUMENT, [
    { op: "delete", section: "One A" },
    { op: "delete", section: "One B" },
  ]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.lines.slice(1), [
    "  1-11 # Doc (+1 hidden)",
    "* 5-7 ## One",
    "2 sections removed or overwritten:",
    "  9-11 ### One A (3 lines, 0 subsections)",
    "  13-15 ### One B (3 lines, 0 subsections)",
  ]);
  assert.deepEqual(outcome.details.removed, [
    { start: 9, end: 11, level: 3, text: "One A", subsections: 0 },
    { start: 13, end: 15, level: 3, text: "One B", subsections: 0 },
  ]);
});

test("specs/markdown-tool.md#edit-result: a deleted section's descendants are listed too, with their spans and subsections", async () => {
  const outcome = await edit(DOCUMENT, [{ op: "delete", section: "One" }]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.lines.slice(-4), [
    "3 sections removed or overwritten:",
    "  5-15 ## One (11 lines, 2 subsections)",
    "  9-11 ### One A (3 lines, 0 subsections)",
    "  13-15 ### One B (3 lines, 0 subsections)",
  ]);
  assert.deepEqual(outcome.details.removed, [
    { start: 5, end: 15, level: 2, text: "One", subsections: 2 },
    { start: 9, end: 11, level: 3, text: "One A", subsections: 0 },
    { start: 13, end: 15, level: 3, text: "One B", subsections: 0 },
  ]);
});

test("specs/markdown-tool.md#edit-result: the renumbered block names the old and the new text", async () => {
  const text = ["# Doc", "", "## 1. One", "", "text", "", "## 2. Two", "", "text", ""].join("\n");
  const outcome = await edit(text, [{ op: "delete", section: "1. One" }]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.lines.slice(1), [
    "* 1-5 # Doc (+1 hidden)",
    "1 sections removed or overwritten:",
    "  3-5 ## 1. One (3 lines, 0 subsections)",
    "1 headings renumbered; references to their old numbers elsewhere in the text were not updated:",
    "  3 ## 2. Two → 1. Two",
  ]);
  assert.deepEqual(outcome.details.renumbered, [
    { start: 3, level: 2, from: "2. Two", to: "1. Two" },
  ]);
});

test("specs/markdown-tool.md#edit-result: a section a replace rewrites is reported as removed even when the call writes its text again", async () => {
  const text = ["# Doc", "", "## One", "", "text", ""].join("\n");
  const outcome = await edit(text, [
    { op: "replace", section: "One", content: "## One\n\nnew text" },
  ]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.details.removed, [
    { start: 3, end: 5, level: 2, text: "One", subsections: 0 },
  ]);
  assert.deepEqual(outcome.lines.slice(1), [
    "  1-5 # Doc",
    "* 3-5 ## One",
    "1 sections removed or overwritten:",
    "  3-5 ## One (3 lines, 0 subsections)",
  ]);
});

test("specs/markdown-tool.md#edit-result: details carries the path, both revisions, changed, and the line count", async () => {
  const dir = tempDir();
  try {
    const name = write(dir, "a.md", DOCUMENT);
    const instance = runtime();
    const before = await revisionOf(instance, dir, name);
    const outcome = await call(instance, dir, {
      action: "edit",
      path: name,
      revision: before,
      operations: [{ op: "rename", section: "Doc", heading: "Title" }],
    });
    const revision = stringField(outcome.details, "revision");
    assert.equal(stringField(outcome.details, "previousRevision"), before);
    assert.notEqual(revision, before);
    assert.equal(outcome.details.action, "edit");
    assert.equal(outcome.details.changed, true);
    assert.equal(outcome.details.lines, 19);
    assert.equal(stringField(outcome.details, "path").endsWith("/a.md"), true);
    assert.match(revision, /^[0-9a-f]{8}$/);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#edit-result: an unchanged call keeps the revision it checked", async () => {
  const outcome = await edit(DOCUMENT, [{ op: "rename", section: "Doc", heading: "Doc" }]);
  const revision = stringField(outcome.details, "revision");
  assert.equal(stringField(outcome.details, "previousRevision"), revision);
  assert.equal(outcome.details.action, "edit");
  assert.equal(outcome.details.changed, false);
  assert.equal(outcome.details.lines, 19);
  assert.equal(stringField(outcome.details, "path").endsWith("/a.md"), true);
  assert.match(revision, /^[0-9a-f]{8}$/);
});

test("specs/markdown-tool.md#edit-result: set_level marks the heading line of the section it re-places", async () => {
  const outcome = await edit(DOCUMENT, [{ op: "set_level", section: "One", level: 3 }]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.lines.slice(1), [
    "  1-19 # Doc (+3 hidden)",
    "* 5-15 ### One (+2 hidden)",
  ]);
  assert.deepEqual(outcome.details.touched, [
    { address: "Doc > One", level: 3, start: 5, end: 15 },
  ]);
  assert.deepEqual(outcome.details.removed, []);
});

test("specs/markdown-tool.md#edit-result: replace_body marks the heading line of its section", async () => {
  const outcome = await edit(DOCUMENT, [
    { op: "replace_body", section: "One", content: "new body" },
  ]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.lines.slice(1), [
    "  1-19 # Doc (+3 hidden)",
    "* 5-15 ## One (+2 hidden)",
  ]);
  assert.deepEqual(outcome.details.touched, [
    { address: "Doc > One", level: 2, start: 5, end: 15 },
  ]);
  assert.deepEqual(outcome.details.removed, []);
});

const LOG = [
  "# 2 Scope",
  "",
  "## 1.2.0 Fixed",
  "",
  "x",
  "",
  "## 1.1.0 Added",
  "",
  "y",
  "",
  "# 5 Notes",
  "",
  "## 1.2.0 Fixed",
  "",
  "x",
  "",
  "## 1.1.0 Added",
  "",
  "y",
  "",
].join("\n");

test("specs/markdown-tool.md#edit-result: skipped groups are listed in document order of their parents, (document) first", async () => {
  const outcome = await edit(LOG, [
    { op: "insert", position: "last", at: "5 Notes", content: "## Later\n\nmore" },
    { op: "insert", position: "last", at: "2 Scope", content: "## Extra\n\nmore" },
    { op: "insert", position: "last", at: "(document)", content: "# Appendix\n\nz" },
  ]);
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.details.skipped, [
    { parent: "(document)", numbers: ["2", "5"] },
    { parent: "2 Scope", numbers: ["1.2.0", "1.1.0"] },
    { parent: "5 Notes", numbers: ["1.2.0", "1.1.0"] },
  ]);
  assert.deepEqual(outcome.lines.slice(-3), [
    "Numbering left as written under (document): its numbers 2, 5 are not in sequence",
    "Numbering left as written under 2 Scope: its numbers 1.2.0, 1.1.0 are not in sequence",
    "Numbering left as written under 5 Notes: its numbers 1.2.0, 1.1.0 are not in sequence",
  ]);
});
