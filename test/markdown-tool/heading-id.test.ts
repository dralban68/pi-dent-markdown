import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesOf, call, cleanupRoots, revisionOf, runtime, tempDir, write } from "./support.ts";

/**
 * specs/markdown-tool.md#parsing and specs/markdown-tool.md#section-addresses: a heading's
 * trailing `{#<id>}` attribute stays in its text and component, an address matches the heading
 * with or without it, and `#<id>` names the section by its id. specs/markdown-tool.md#edit-operations:
 * `rename` keeps the attribute.
 */

const SPEC = [
  "# Spec",
  "",
  "## 1. Intro {#intro}",
  "",
  "text",
  "",
  "## 5. Checks {#checks}",
  "",
  "### 5.1 File checks {#file-checks}",
  "",
  "body",
  "",
  "## Odd {#1x}",
  "",
  "## Tight{#tight}",
  "",
].join("\n");

async function addressOf(
  text: string,
  section: string,
): Promise<{ address: unknown; error: string | undefined }> {
  const dir = tempDir();
  try {
    const name = write(dir, "a.md", text);
    const outcome = await call(runtime(), dir, { action: "read", path: name, section });
    return { address: outcome.details.address, error: outcome.isError ? outcome.text : undefined };
  } finally {
    cleanupRoots();
  }
}

async function edit(
  text: string,
  operations: Record<string, unknown>[],
): Promise<{ text: string; isError: boolean; file: string }> {
  const dir = tempDir();
  try {
    const name = write(dir, "a.md", text);
    const instance = runtime();
    const revision = await revisionOf(instance, dir, name);
    const outcome = await call(instance, dir, { action: "edit", path: name, revision, operations });
    return { text: outcome.text, isError: outcome.isError, file: bytesOf(dir, name) };
  } finally {
    cleanupRoots();
  }
}

test("specs/markdown-tool.md#section-addresses: a component matches the heading text without its id attribute, at every step", async () => {
  for (const section of ["5. Checks", "5. checks", "Checks", "5", "5. Checks {#checks}"]) {
    assert.deepEqual(
      await addressOf(SPEC, section),
      { address: "Spec > 5. Checks {#checks}", error: undefined },
      section,
    );
  }
});

test("specs/markdown-tool.md#section-addresses: ancestors match without their id attribute too", async () => {
  assert.deepEqual(await addressOf(SPEC, "5. Checks > 5.1 File checks"), {
    address: "Spec > 5. Checks {#checks} > 5.1 File checks {#file-checks}",
    error: undefined,
  });
});

test("specs/markdown-tool.md#section-addresses: an id component names the section whose heading holds that id", async () => {
  assert.deepEqual(await addressOf(SPEC, "#file-checks"), {
    address: "Spec > 5. Checks {#checks} > 5.1 File checks {#file-checks}",
    error: undefined,
  });
  assert.deepEqual(await addressOf(SPEC, "Spec > #intro"), {
    address: "Spec > 1. Intro {#intro}",
    error: undefined,
  });
  const missing = await addressOf(SPEC, "#missing");
  assert.match(missing.error ?? "", /^no section "#missing" in /);
});

test("specs/markdown-tool.md#parsing: an id that starts with a digit, or a {#…} not after a space, is no id attribute", async () => {
  assert.match((await addressOf(SPEC, "Odd")).error ?? "", /^no section "Odd"/);
  assert.match((await addressOf(SPEC, "#1x")).error ?? "", /^no section "#1x"/);
  assert.match((await addressOf(SPEC, "Tight")).error ?? "", /^no section "Tight"/);
  assert.match((await addressOf(SPEC, "#tight")).error ?? "", /^no section "#tight"/);
});

test("specs/markdown-tool.md#parsing: an outline shows the id attribute in the entry line", async () => {
  const dir = tempDir();
  try {
    const name = write(dir, "a.md", SPEC);
    const outcome = await call(runtime(), dir, { action: "outline", path: name, depth: 3 });
    assert.equal(outcome.isError, false, outcome.text);
    assert.equal(outcome.lines.includes("7-11 ## 5. Checks {#checks}"), true, outcome.text);
    assert.equal(
      outcome.lines.includes("9-11 ### 5.1 File checks {#file-checks}"),
      true,
      outcome.text,
    );
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#edit-operations: rename keeps the id attribute unless the new text brings its own", async () => {
  const kept = await edit(SPEC, [{ op: "rename", section: "5. Checks", heading: "Verification" }]);
  assert.equal(kept.isError, false, kept.text);
  assert.equal(kept.file.includes("## 5. Verification {#checks}\n"), true, kept.file);
  const replaced = await edit(SPEC, [
    { op: "rename", section: "#checks", heading: "Verification {#verify}" },
  ]);
  assert.equal(replaced.isError, false, replaced.text);
  assert.equal(replaced.file.includes("## 5. Verification {#verify}\n"), true, replaced.file);
});

test("specs/markdown-tool.md#section-addresses: an id component is exempt from the renumbering collision", async () => {
  const text = ["# D", "", "## 1. A {#a}", "", "## 2. B {#b}", ""].join("\n");
  const move = { op: "move", section: "1. A", position: "after", at: "2. B" };
  const byNumber = await edit(text, [move, { op: "rename", section: "2", heading: "Alpha" }]);
  assert.equal(byNumber.isError, true);
  assert.match(byNumber.text, /now names D > 2\. A \{#a\}, renumbered by operation 0/);
  const byId = await edit(text, [move, { op: "rename", section: "#a", heading: "Alpha" }]);
  assert.equal(byId.isError, false, byId.text);
  assert.equal(byId.file, ["# D", "", "## 1. B {#b}", "", "## 2. Alpha {#a}", ""].join("\n"));
});
