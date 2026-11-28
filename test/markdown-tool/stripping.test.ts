import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesOf, call, cleanupRoots, revisionOf, runtime, tempDir, write } from "./support.ts";

/**
 * specs/markdown-tool.md#section-addresses through the tool: the stripping of an
 * address (a leading `* `, a leading line range, leading heading marks, and a
 * trailing ` (+<k> hidden)`), the number components of matching step 4, the
 * precedence of a literal heading, and the collision rejection of an address
 * that names a section renumbered by an earlier operation of the call.
 */

const NESTED = ["# Doc", "", "## One", "", "### One A", "", "text", "", "## Two", ""].join("\n");

async function read(
  text: string,
  section: string,
): Promise<Record<string, unknown> & { text: string; isError: boolean }> {
  const dir = tempDir();
  try {
    const name = write(dir, "a.md", text);
    const outcome = await call(runtime(), dir, { action: "read", path: name, section });
    return { ...outcome.details, text: outcome.text, isError: outcome.isError };
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

test("specs/markdown-tool.md#section-addresses: a leading `* ` is stripped from an address", async () => {
  const outcome = await read(NESTED, "* One A");
  assert.equal(outcome.isError, false);
  assert.equal(outcome.address, "Doc > One > One A");
  const bare = await read(NESTED, "One A");
  assert.equal(bare.address, "Doc > One > One A");
});

test("specs/markdown-tool.md#section-addresses step 2: a `*` attached to a component is removed by normalization, not stripped", async () => {
  const attached = await read(NESTED, "*One A");
  assert.equal(attached.isError, false);
  assert.equal(attached.address, "Doc > One > One A");
});

test("specs/markdown-tool.md#section-addresses: a leading line range `<a>-<b> ` is stripped, as a copied outline line gives it", async () => {
  const range = await read(NESTED, "5-7 One A");
  assert.equal(range.isError, false);
  assert.equal(range.address, "Doc > One > One A");
  assert.equal(range.start, 5);
  assert.equal(range.end, 7);
  const copied = await read(NESTED, "3-7 ## One (+1 hidden)");
  assert.equal(copied.isError, false);
  assert.equal(copied.address, "Doc > One");
});

test("specs/markdown-tool.md#section-addresses: leading heading marks `#{1,6} ` are stripped, and only once", async () => {
  const marks = await read(NESTED, "### One A");
  assert.equal(marks.isError, false);
  assert.equal(marks.address, "Doc > One > One A");
  const doubled = await read(NESTED, "## ## One A");
  assert.equal(doubled.isError, true);
  assert.equal(doubled.text, 'no section "## ## One A" in a.md. Run outline to list its sections.');
});

test("specs/markdown-tool.md#section-addresses: a trailing ` (+<k> hidden)` and ` (<n> lines)` are stripped from an address", async () => {
  const outcome = await read(NESTED, "One (+2 hidden)");
  assert.equal(outcome.isError, false);
  assert.equal(outcome.address, "Doc > One");
  const withLines = await read(NESTED, "3-7 ## One (5 lines) (+1 hidden)");
  assert.equal(withLines.isError, false);
  assert.equal(withLines.address, "Doc > One");
  const linesOnly = await read(NESTED, "5-7 ### One A (3 lines)");
  assert.equal(linesOnly.isError, false);
  assert.equal(linesOnly.address, "Doc > One > One A");
  const editLine = await read(NESTED, "* 3-7 ## One (5 lines) (+1 hidden)");
  assert.equal(editLine.isError, false);
  assert.equal(editLine.address, "Doc > One");
});

test("specs/markdown-tool.md#section-addresses: ` (<n> lines)` is not stripped without a line range, so a literal heading resolves", async () => {
  const text = ["# Notes", "", "a", "", "# Notes (2 lines)", "", "b", ""].join("\n");
  const literal = await read(text, "Notes (2 lines)");
  assert.equal(literal.isError, false);
  assert.equal(literal.address, "Notes (2 lines)");
  const copied = await read(text, "5-7 # Notes (2 lines) (3 lines)");
  assert.equal(copied.isError, false);
  assert.equal(copied.address, "Notes (2 lines)");
});

test("specs/markdown-tool.md#section-addresses: the stripping runs in order, after the trim, on the whole value", async () => {
  const padded = await read(NESTED, "   * 5-7 ### One A (+0 hidden)  ");
  assert.equal(padded.isError, false);
  assert.equal(padded.address, "Doc > One > One A");
});

test("specs/markdown-tool.md#section-addresses: an address that is not found is shown trimmed, as given", async () => {
  const outcome = await read(NESTED, "  ## Missing  ");
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, 'no section "## Missing" in a.md. Run outline to list its sections.');
});

test("specs/markdown-tool.md#section-addresses: (preamble) is recognised after stripping of `* ` and the line range, not of heading marks", async () => {
  const text = ["intro", "", "# A", "", "text", ""].join("\n");
  const copied = await read(text, "1-1 (preamble)");
  assert.equal(copied.isError, false);
  assert.equal(copied.address, "(preamble)");
  assert.equal(copied.start, 1);
  assert.equal(copied.end, 1);
  const heading = await read(text, "# (preamble)");
  assert.equal(heading.isError, true);
  assert.equal(
    heading.text,
    'no section "# (preamble)" in a.md. Run outline to list its sections.',
  );
  const hidden = await read(text, "(preamble) (+1 hidden)");
  assert.equal(hidden.isError, false);
});

test("specs/markdown-tool.md#section-addresses: (document) is refused when stripped, but not behind heading marks", async () => {
  const outcome = await read(NESTED, "(document)");
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, "(document) is not valid as the section of read");
  const marked = await read(NESTED, "# (document)");
  assert.equal(marked.isError, true);
  assert.equal(marked.text, 'no section "# (document)" in a.md. Run outline to list its sections.');
});

test("specs/markdown-tool.md#section-addresses: a heading text that starts with a line range is named by its text after the range", async () => {
  const text = ["# Doc", "", "## 2024-2025 Roadmap", "", "text", ""].join("\n");
  const outcome = await read(text, "2024-2025 Roadmap");
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /Similar: Doc > 2024-2025 Roadmap/);
  const stripped = await read(text, "Roadmap");
  assert.equal(stripped.isError, true);
});

const SPEC = [
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

test("specs/markdown-tool.md#section-addresses step 4: a number component names a section by its number, in every form", async () => {
  const cases: [string, string][] = [
    ["3.1", "Spec > 3. Find > 3.1 Candidates"],
    ["3.1 Candidates", "Spec > 3. Find > 3.1 Candidates"],
    ["Section 3.1", "Spec > 3. Find > 3.1 Candidates"],
    ["§ 3.1", "Spec > 3. Find > 3.1 Candidates"],
    ["§3.1", "Spec > 3. Find > 3.1 Candidates"],
    ["03.1", "Spec > 3. Find > 3.1 Candidates"],
    ["3.", "Spec > 3. Find"],
    ["Section 3", "Spec > 3. Find"],
    ["Section 3 > 3.1", "Spec > 3. Find > 3.1 Candidates"],
  ];
  for (const [address, expected] of cases) {
    const outcome = await read(SPEC, address);
    assert.equal(outcome.isError, false, address);
    assert.equal(outcome.address, expected, address);
  }
});

test("specs/markdown-tool.md#section-addresses step 4: a number component matches only a heading whose number is the same", async () => {
  const outcome = await read(SPEC, "3.2");
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, 'no section "3.2" in a.md. Run outline to list its sections.');
});

test("specs/markdown-tool.md#section-addresses step 4: a number that several sections share is ambiguous", async () => {
  const text = [
    "# Spec",
    "",
    "## 1. A",
    "",
    "### 3.1 X",
    "",
    "x",
    "",
    "## 2. B",
    "",
    "### 3.1 Y",
    "",
    "y",
    "",
  ].join("\n");
  const outcome = await read(text, "3.1");
  assert.equal(outcome.isError, true);
  assert.equal(
    outcome.text,
    'section "3.1" matches 2 sections in a.md: Spec > 1. A > 3.1 X; Spec > 2. B > 3.1 Y. Put more of its path before it, joined by " > ".',
  );
  const narrowed = await read(text, "2. B > 3.1");
  assert.equal(narrowed.isError, false);
  assert.equal(narrowed.address, "Spec > 2. B > 3.1 Y");
});

test("specs/markdown-tool.md#section-addresses: a literal heading `2024` is matched at step 1, before a number match", async () => {
  const text = ["# Doc", "", "## 2024", "", "text A", "", "## 2024 Roadmap", "", "text B", ""].join(
    "\n",
  );
  const literal = await read(text, "2024");
  assert.equal(literal.isError, false);
  assert.equal(literal.address, "Doc > 2024");
  const numbered = await read(text, "2024 Roadmap");
  assert.equal(numbered.address, "Doc > 2024 Roadmap");
  const number = await read(text, "Section 2024");
  assert.equal(number.isError, false);
  assert.equal(number.address, "Doc > 2024 Roadmap");
});

test("specs/markdown-tool.md#section-addresses: an address naming a section renumbered by an earlier operation is refused when another heading before the call had its number", async () => {
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
    "### 4.1 Examples",
    "",
    "text",
    "",
    "## 5. Other",
    "",
    "### 3.1 Dup",
    "",
    "text",
    "",
  ].join("\n");
  const outcome = await edit(text, [
    { op: "delete", section: "3.1 Candidates" },
    { op: "move", section: "4.1 Examples", position: "last", at: "3. Find" },
    { op: "delete", section: "3.1 Dup" },
    { op: "delete", section: "3.1" },
  ]);
  assert.equal(outcome.isError, true);
  assert.equal(
    outcome.text,
    'operations[3]: "3.1" now names Spec > 3. Find > 3.1 Examples, renumbered by operation 1; name it without its number, with an ancestor if needed',
  );
  assert.equal(outcome.file, text);
});

test("specs/markdown-tool.md#section-addresses: an address naming a renumbered section by its text is refused when another heading before the call had that text", async () => {
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
    "### 4.1 Examples",
    "",
    "text",
    "",
    "## 5. Other",
    "",
    "### 3.1 Examples",
    "",
    "text",
    "",
  ].join("\n");
  const outcome = await edit(text, [
    { op: "delete", section: "5. Other > 3.1 Examples" },
    { op: "delete", section: "3.1 Candidates" },
    { op: "move", section: "4.1 Examples", position: "last", at: "3. Find" },
    { op: "delete", section: "3.1 Examples" },
  ]);
  assert.equal(outcome.isError, true);
  assert.equal(
    outcome.text,
    'operations[3]: "3.1 Examples" now names Spec > 3. Find > 3.1 Examples, renumbered by operation 2; name it without its number, with an ancestor if needed',
  );
});

test("specs/markdown-tool.md#section-addresses: a renumbered section is named by its number when no heading before the call had that number", async () => {
  const text = ["# Spec", "", "## 3. Find", "", "text", "", "## 4. Get", "", "text", ""].join("\n");
  const outcome = await edit(text, [
    { op: "move", section: "4. Get", position: "last", at: "3. Find" },
    { op: "rename", section: "3.1", heading: "Renamed" },
  ]);
  assert.equal(outcome.isError, false);
  assert.match(outcome.file, /### 3\.1 Renamed/);
});

const MARKS = ["# Alpha", "", "## Dup", "", "one", "", "# Beta", "", "## Dup", "", "two", ""].join(
  "\n",
);

test("specs/markdown-tool.md#section-addresses: heading marks are stripped from each component of an address, once each", async () => {
  const first = await read(MARKS, "# Alpha > ## Dup");
  assert.equal(first.isError, false);
  assert.equal(first.address, "Alpha > Dup");
  assert.equal(first.start, 3);
  const second = await read(MARKS, "Beta > ### Dup");
  assert.equal(second.isError, false);
  assert.equal(second.address, "Beta > Dup");
  assert.equal(second.start, 9);
  const doubled = await read(MARKS, "Alpha > ## ## Dup");
  assert.equal(doubled.isError, true);
  assert.equal(
    doubled.text,
    'no section "Alpha > ## ## Dup" in a.md. Run outline to list its sections.',
  );
});

test("specs/markdown-tool.md#section-addresses: a bare duplicate name is ambiguous, and a line range picks one of them", async () => {
  const bare = await read(MARKS, "Dup");
  assert.equal(bare.isError, true);
  assert.equal(
    bare.text,
    'section "Dup" matches 2 sections in a.md: Alpha > Dup; Beta > Dup. Put more of its path before it, joined by " > ".',
  );
  const beta = await read(MARKS, "* 9-11 ## Dup (+1 hidden)");
  assert.equal(beta.isError, false);
  assert.equal(beta.address, "Beta > Dup");
  const alpha = await read(MARKS, "3-5 Alpha > ## Dup");
  assert.equal(alpha.isError, false);
  assert.equal(alpha.address, "Alpha > Dup");
});
