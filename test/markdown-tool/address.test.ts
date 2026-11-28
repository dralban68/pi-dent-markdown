import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesOf, call, cleanupRoots, revisionOf, runtime, tempDir, write } from "./support.ts";
import { must } from "../support/must.ts";

/**
 * specs/markdown-tool.md#section-addresses through the tool: the three matching
 * steps, the ` [<n>]` suffix, the preamble, and the rejection of an address an
 * earlier operation renumbered onto a heading text of the file.
 */

const NESTED = ["# Doc", "", "## One", "", "### One A", "", "text", "", "## Two", ""].join("\n");

async function read(text: string, section: string): Promise<{ text: string; isError: boolean }> {
  const dir = tempDir();
  try {
    const name = write(dir, "a.md", text);
    const outcome = await call(runtime(), dir, { action: "read", path: name, section });
    return { text: outcome.text, isError: outcome.isError };
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

test("specs/markdown-tool.md#section-addresses: an address matches exactly, then without markup and case, then without a number", async () => {
  const exact = await read(NESTED, "Doc > One > One A");
  assert.equal(exact.isError, false);
  assert.match(exact.text, /· lines 5-7 ·/);
  const markup = await read(NESTED, "doc > **one** > `one a`");
  assert.equal(markup.isError, false);
  assert.match(markup.text, /· lines 5-7 ·/);
  const bare = await read(NESTED, "One A");
  assert.equal(bare.isError, false);
  assert.match(bare.text, /· lines 5-7 ·/);
});

test("specs/markdown-tool.md#section-addresses: a repeated sibling text takes the ` [<n>]` suffix", async () => {
  const text = ["# A", "", "## X", "", "first", "", "## X", "", "second", ""].join("\n");
  const first = await read(text, "X");
  assert.match(first.text, /first/);
  const second = await read(text, "X [2]");
  assert.match(second.text, /second/);
  const lower = await read(text, "a > x [2]");
  assert.match(lower.text, /second/);
  const twoParents = ["# A", "", "## X", "", "one", "", "# B", "", "## X", "", "two", ""].join(
    "\n",
  );
  const ambiguous = await read(twoParents, "X");
  assert.equal(ambiguous.isError, true);
  assert.equal(
    ambiguous.text,
    'section "X" matches 2 sections in a.md: A > X; B > X. Put more of its path before it, joined by " > ".',
  );
});

test("specs/markdown-tool.md#section-addresses: an address an earlier operation renumbered onto an old heading text is refused", async () => {
  const text = [
    "# Doc",
    "",
    "## 1. Alpha",
    "",
    "### 1.1 Two",
    "",
    "text",
    "",
    "### 1.2 Two",
    "",
    "text",
    "",
  ].join("\n");
  const refused = await edit(text, [
    { op: "delete", section: "1.1 Two" },
    { op: "delete", section: "1.1 Two" },
  ]);
  assert.equal(refused.isError, true);
  assert.equal(
    refused.text,
    'operations[1]: "1.1 Two" now names Doc > 1. Alpha > 1.1 Two, renumbered by operation 0; name it without its number, with an ancestor if needed',
  );

  const named = await edit(text, [
    { op: "delete", section: "1.1 Two" },
    { op: "delete", section: "Two" },
  ]);
  assert.equal(named.isError, false);
  assert.equal(named.file, "# Doc\n\n## 1. Alpha\n");
});

test("specs/markdown-tool.md#section-addresses: an address the call itself wrote is not the renumbered-address rejection", async () => {
  const text = [
    "# Doc",
    "",
    "## 1. Alpha",
    "",
    "### 1.1 Two",
    "",
    "text",
    "",
    "### 1.2 Two",
    "",
    "text",
    "",
  ].join("\n");
  const outcome = await edit(text, [
    { op: "delete", section: "1.1 Two" },
    { op: "rename", section: "1.2 Two", heading: "Renamed" },
  ]);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.file.includes("### 1.1 Renamed"), true);
});

test("specs/markdown-tool.md#section-addresses: an unknown address lists similar sections or the outline advice", async () => {
  const similar = await read(NESTED, "Tw");
  assert.equal(similar.isError, true);
  assert.equal(similar.text, 'no section "Tw" in a.md. Similar: Doc > Two');
  const unmatched = await read(NESTED, "One Ax");
  assert.equal(unmatched.isError, true);
  assert.equal(unmatched.text, 'no section "One Ax" in a.md. Run outline to list its sections.');
  const contained = await read(NESTED, "Ax");
  assert.equal(contained.text, 'no section "Ax" in a.md. Run outline to list its sections.');
  const none = await read(NESTED, "zzz");
  assert.equal(none.text, 'no section "zzz" in a.md. Run outline to list its sections.');
});

test("specs/markdown-tool.md#section-addresses: (preamble) names the preamble for read and for replace_body", async () => {
  const text = ["intro", "", "# A", "", "text", ""].join("\n");
  assert.match((await read(text, "(preamble)")).text, /· \(preamble\) · lines 1-1 ·/);
  const replaced = await edit(text, [
    { op: "replace_body", section: "(preamble)", content: "new intro" },
  ]);
  assert.equal(must(replaced.file.split("\n")[0]), "new intro");
});

test("specs/markdown-tool.md#section-addresses: an ancestor component matches in order but need not be consecutive", async () => {
  const outcome = await read(NESTED, "Doc > One A");
  assert.equal(outcome.isError, false);
  assert.match(outcome.text, /· lines 5-7 ·/);
});

const RANGED = ["# Alpha", "", "## Dup", "", "one", "", "# Beta", "", "## Dup", "", "two", ""].join(
  "\n",
);

test("specs/markdown-tool.md#section-addresses: a line range matches only the section whose reference span it gives", async () => {
  const beta = await read(RANGED, "9-11 Dup");
  assert.equal(beta.isError, false);
  assert.match(beta.text, /· Beta > Dup · lines 9-11 ·/);
  const alpha = await read(RANGED, "3-5 Dup");
  assert.match(alpha.text, /· Alpha > Dup · lines 3-5 ·/);
  const mismatch = await read(RANGED, "9-10 Dup");
  assert.equal(mismatch.isError, true);
  assert.equal(
    mismatch.text,
    'no section "9-10 Dup" in a.md spans that line range; without it the address matches: 3-5 Alpha > Dup; 9-11 Beta > Dup. Run outline for current line ranges.',
  );
  const wrongParent = await read(RANGED, "3-5 Beta > Dup");
  assert.equal(wrongParent.isError, true);
  assert.equal(
    wrongParent.text,
    'no section "3-5 Beta > Dup" in a.md spans that line range; without it the address matches: 9-11 Beta > Dup. Run outline for current line ranges.',
  );
  const unknown = await read(RANGED, "5-9 Zeta");
  assert.equal(unknown.text, 'no section "5-9 Zeta" in a.md. Run outline to list its sections.');
});

test("specs/markdown-tool.md#section-addresses: a trailing ` [<n>]` is dropped from the last component only with a line range", async () => {
  const ranged = await read(RANGED, "9-11 Dup [2]");
  assert.equal(ranged.isError, false);
  assert.match(ranged.text, /· Beta > Dup · lines 9-11 ·/);
  const unranged = await read(RANGED, "Dup [2]");
  assert.equal(unranged.isError, true);
  assert.equal(unranged.text, 'no section "Dup [2]" in a.md. Run outline to list its sections.');
});

test("specs/markdown-tool.md#section-addresses step 4: a line range also holds for a number component", async () => {
  const text = [
    "# Spec",
    "",
    "## 3. Find",
    "",
    "### 3.1 Candidates",
    "",
    "text",
    "",
    "## 4. Get",
    "",
    "text",
    "",
  ].join("\n");
  const outcome = await read(text, "5-7 3.1");
  assert.match(outcome.text, /· Spec > 3\. Find > 3\.1 Candidates · lines 5-7 ·/);
  const mismatch = await read(text, "5-6 3.1");
  assert.equal(
    mismatch.text,
    'no section "5-6 3.1" in a.md spans that line range; without it the address matches: 5-7 Spec > 3. Find > 3.1 Candidates. Run outline for current line ranges.',
  );
});

test("specs/markdown-tool.md#section-addresses: (preamble) with a line range is still the preamble", async () => {
  const text = ["intro", "", "# A", "", "text", ""].join("\n");
  assert.match((await read(text, "9-9 (preamble)")).text, /· \(preamble\) · lines 1-1 ·/);
});

test("specs/markdown-tool.md#section-addresses: outline takes a line range too", async () => {
  const dir = tempDir();
  try {
    const name = write(dir, "a.md", RANGED);
    const outcome = await call(runtime(), dir, {
      action: "outline",
      path: name,
      section: "9-11 Dup",
    });
    assert.equal(outcome.isError, false);
    assert.equal(outcome.lines.includes("9-11 ## Dup (3 lines)"), true);
  } finally {
    cleanupRoots();
  }
});
