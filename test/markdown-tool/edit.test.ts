import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { markdownRuntime } from "../../lib/markdown-tool.ts";
import { bytesOf, call, cleanupRoots, revisionOf, runtime, tempDir, write } from "./support.ts";
import { must } from "../support/must.ts";

/**
 * specs/markdown-tool.md#edit-applying, specs/markdown-tool.md#edit-line-rules, and
 * specs/markdown-tool.md#edit-operations: every operation, the line rules,
 * the line-ending rule, atomic batches, the revision check, and the checks that
 * run after the addresses resolve.
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

interface EditOutcome {
  text: string;
  lines: string[];
  details: Record<string, unknown>;
  isError: boolean;
  file: string;
}

/** Apply operations to a fresh copy of `text` and report the result and the file. */
async function edit(
  text: string,
  operations: Record<string, unknown>[],
  options: { name?: string; write?: (path: string, bytes: Uint8Array) => void } = {},
): Promise<EditOutcome> {
  const dir = tempDir();
  try {
    const name = write(dir, options.name ?? "a.md", text);
    const instance =
      options.write === undefined ? runtime() : markdownRuntime({ writeFile: options.write });
    const revision = await revisionOf(instance, dir, name);
    const outcome = await call(instance, dir, {
      action: "edit",
      path: name,
      revision,
      operations,
    });
    return {
      text: outcome.text,
      lines: outcome.lines,
      details: outcome.details,
      isError: outcome.isError,
      file: bytesOf(dir, name),
    };
  } finally {
    cleanupRoots();
  }
}

test("specs/markdown-tool.md#edit-operations: replace puts a fitted block in place of a section", async () => {
  const outcome = await edit(DOCUMENT, [
    { op: "replace", section: "One A", content: "## New A\n\ntext new" },
  ]);
  assert.equal(outcome.isError, false);
  assert.equal(
    outcome.file,
    [
      "# Doc",
      "",
      "intro",
      "",
      "## One",
      "",
      "body one",
      "",
      "### New A",
      "",
      "text new",
      "",
      "### One B",
      "",
      "text b",
      "",
      "## Two",
      "",
      "body two",
      "",
    ].join("\n"),
  );
  assert.equal(
    outcome.lines[0],
    `Edited a.md: 1 operations · 19 lines · revision ${must(outcome.details.revision)}`,
  );
});

test("specs/markdown-tool.md#edit-operations: delete removes the span and the blank lines after it", async () => {
  const outcome = await edit(DOCUMENT, [{ op: "delete", section: "One A" }]);
  assert.equal(outcome.isError, false);
  assert.equal(
    outcome.file,
    [
      "# Doc",
      "",
      "intro",
      "",
      "## One",
      "",
      "body one",
      "",
      "### One B",
      "",
      "text b",
      "",
      "## Two",
      "",
      "body two",
      "",
    ].join("\n"),
  );
});

test("specs/markdown-tool.md#edit-operations: delete of a last section leaves no trailing blank line", async () => {
  const text = ["# A", "", "one", "", "## B", "", "two", ""].join("\n");
  const outcome = await edit(text, [{ op: "delete", section: "B" }]);
  assert.equal(outcome.file, "# A\n\none\n");
});

test("specs/markdown-tool.md#edit-operations: replace_body replaces, empties, and creates the own body", async () => {
  const replaced = await edit(DOCUMENT, [
    { op: "replace_body", section: "One", content: "new body" },
  ]);
  assert.equal(
    replaced.file,
    [
      "# Doc",
      "",
      "intro",
      "",
      "## One",
      "",
      "new body",
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
    ].join("\n"),
  );
  const emptied = await edit(DOCUMENT, [{ op: "replace_body", section: "One", content: "" }]);
  assert.equal(
    emptied.file,
    [
      "# Doc",
      "",
      "intro",
      "",
      "## One",
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
    ].join("\n"),
  );
  const bodyless = await edit(["# A", "", "## B", "", "### C", "", "x", ""].join("\n"), [
    { op: "replace_body", section: "B", content: "new" },
  ]);
  assert.equal(bodyless.file, "# A\n\n## B\n\nnew\n\n### C\n\nx\n");
});

test("specs/markdown-tool.md#edit-operations: replace_body of (preamble) replaces, removes, and places it", async () => {
  const text = ["intro", "", "# A", "", "text", ""].join("\n");
  assert.equal(
    (await edit(text, [{ op: "replace_body", section: "(preamble)", content: "new intro" }])).file,
    "new intro\n\n# A\n\ntext\n",
  );
  assert.equal(
    (await edit(text, [{ op: "replace_body", section: "(preamble)", content: "" }])).file,
    "# A\n\ntext\n",
  );
  assert.equal(
    (await edit("# A\n\ntext\n", [{ op: "replace_body", section: "(preamble)", content: "intro" }]))
      .file,
    "intro\n\n# A\n\ntext\n",
  );
});

test("specs/markdown-tool.md#edit-operations: insert places a block at each position", async () => {
  const after = await edit(DOCUMENT, [
    { op: "insert", position: "after", at: "One A", content: "### Inserted\n\ntext i" },
  ]);
  assert.equal(
    after.file,
    [
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
      "### Inserted",
      "",
      "text i",
      "",
      "### One B",
      "",
      "text b",
      "",
      "## Two",
      "",
      "body two",
      "",
    ].join("\n"),
  );
  const first = await edit(DOCUMENT, [
    { op: "insert", position: "first", at: "One", content: "### Inserted\n\ntext i" },
  ]);
  assert.equal(
    first.file,
    [
      "# Doc",
      "",
      "intro",
      "",
      "## One",
      "",
      "body one",
      "",
      "### Inserted",
      "",
      "text i",
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
    ].join("\n"),
  );
  const document = await edit(DOCUMENT, [
    { op: "insert", position: "first", at: "(document)", content: "## Start\n\nfirst" },
  ]);
  assert.equal(must(document.file.split("\n")[0]), "## Start");
  assert.equal(must(document.file.split("\n")[2]), "first");
  const last = await edit(DOCUMENT, [
    { op: "insert", position: "last", at: "(document)", content: "## End\n\nlast" },
  ]);
  assert.equal(last.file.endsWith("body two\n\n## End\n\nlast\n"), true);
});

test("specs/markdown-tool.md#edit-operations: move takes a section out and fits it to its new place", async () => {
  const outcome = await edit(DOCUMENT, [
    { op: "move", section: "One A", position: "after", at: "Two" },
  ]);
  assert.equal(
    outcome.file,
    [
      "# Doc",
      "",
      "intro",
      "",
      "## One",
      "",
      "body one",
      "",
      "### One B",
      "",
      "text b",
      "",
      "## Two",
      "",
      "body two",
      "",
      "## One A",
      "",
      "text a",
      "",
    ].join("\n"),
  );
});

test("specs/markdown-tool.md#edit-operations: rename keeps a number prefix unless the new text has one", async () => {
  assert.equal(
    (await edit(DOCUMENT, [{ op: "rename", section: "One A", heading: "Renamed" }])).file.includes(
      "\n### Renamed\n",
    ),
    true,
  );
  const numbered = ["## 3.1  Filters", "", "text", ""].join("\n");
  assert.equal(
    (await edit(numbered, [{ op: "rename", section: "3.1 Filters", heading: "Matching" }])).file,
    "## 3.1  Matching\n\ntext\n",
  );
  assert.equal(
    (await edit(numbered, [{ op: "rename", section: "3.1 Filters", heading: "9. Other" }])).file,
    "## 9. Other\n\ntext\n",
  );
  const setext = ["Filters", "=======", "", "text", ""].join("\n");
  assert.equal(
    (await edit(setext, [{ op: "rename", section: "Filters", heading: "Matchers" }])).file,
    "Matchers\n=======\n\ntext\n",
  );
});

test("specs/markdown-tool.md#edit-operations: rename of an ATX heading with no raw contents writes the opening sequence", async () => {
  const text = ["##", "", "text", ""].join("\n");
  assert.equal(
    (await edit(text, [{ op: "rename", section: "(untitled)", heading: "Named" }])).file,
    "## Named\n\ntext\n",
  );
});

test("specs/markdown-tool.md#edit-operations: set_level shifts a section and its subsections", async () => {
  const outcome = await edit(DOCUMENT, [{ op: "set_level", section: "One", level: 3 }]);
  assert.equal(outcome.isError, false);
  assert.equal(
    outcome.file,
    [
      "# Doc",
      "",
      "intro",
      "",
      "### One",
      "",
      "body one",
      "",
      "#### One A",
      "",
      "text a",
      "",
      "#### One B",
      "",
      "text b",
      "",
      "## Two",
      "",
      "body two",
      "",
    ].join("\n"),
  );
});

test("specs/markdown-tool.md#edit-line-rules: fitting a setext heading to a new level rewrites it as an ATX heading", async () => {
  const text = ["Doc", "===", "", "Sub", "---", "", "text", ""].join("\n");
  const set = await edit(text, [{ op: "set_level", section: "Sub", level: 3 }]);
  assert.equal(set.isError, false);
  assert.equal(set.file, "Doc\n===\n\n### Sub\n\ntext\n");
  const inserted = await edit(["## Doc", "", "text", ""].join("\n"), [
    { op: "insert", position: "last", at: "Doc", content: "Sub\n---\n\nmore" },
  ]);
  assert.equal(inserted.isError, false);
  assert.equal(inserted.file, "## Doc\n\ntext\n\n### Sub\n\nmore\n");
});

test("specs/markdown-tool.md#edit-operations: set_level is refused when another section would change parent", async () => {
  const text = ["# Doc", "", "## One", "", "### One A", "", "## Two", ""].join("\n");
  const outcome = await edit(text, [{ op: "set_level", section: "One A", level: 1 }]);
  assert.equal(outcome.isError, true);
  assert.equal(
    outcome.text,
    "operations[0]: set_level would change the parent of 1 other sections, first Doc > Two; move Doc > One > One A first, then set its level (move fits its level to the new place)",
  );
});

test("specs/markdown-tool.md#edit-operations: a move into itself, a level-6 destination, and a level above 6 are refused", async () => {
  const inside = await edit(DOCUMENT, [
    { op: "move", section: "One", position: "after", at: "One A" },
  ]);
  assert.equal(inside.text, "operations[0]: cannot move Doc > One to a place inside itself");

  const six = ["# A", "", "###### B", "", "text", ""].join("\n");
  const noSubsection = await edit(six, [
    { op: "insert", position: "last", at: "B", content: "### C" },
  ]);
  assert.equal(
    noSubsection.text,
    "operations[0]: A > B is a level-6 section and can hold no subsection",
  );

  const deep = await edit(DOCUMENT, [{ op: "set_level", section: "One", level: 6 }]);
  assert.equal(
    deep.text,
    "operations[0]: the section would need heading level 7; levels stop at 6",
  );
});

test("specs/markdown-tool.md#edit-operations: a rename whose text cannot be written as heading text is refused", async () => {
  const outcome = await edit(DOCUMENT, [{ op: "rename", section: "One A", heading: "a #" }]);
  assert.equal(outcome.isError, true);
  assert.equal(
    outcome.text,
    'operations[0]: "a #" cannot be written as heading text; it would read "a"',
  );
});

test("specs/markdown-tool.md#edit-operations: a rename writes the prefix of a numbered heading into a refused text", async () => {
  const outcome = await edit("## 3. Foo\n\ntext\n", [
    { op: "rename", section: "3. Foo", heading: "Bar #" },
  ]);
  assert.equal(outcome.isError, true);
  assert.equal(
    outcome.text,
    'operations[0]: "3. Bar #" cannot be written as heading text; it would read "3. Bar"',
  );
});

test("specs/markdown-tool.md#edit-operations: an edit that would make the first lines frontmatter is refused", async () => {
  const outcome = await edit(["intro", "", "# A", ""].join("\n"), [
    { op: "replace_body", section: "(preamble)", content: "---\n\n---" },
  ]);
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, "operations[0]: the edited text would make lines 1-3 frontmatter");
});

test("specs/markdown-tool.md#edit-operations: content that would not parse as intended is refused", async () => {
  const outcome = await edit(DOCUMENT, [
    { op: "insert", position: "after", at: "One A", content: "### New\n\n```\ntext" },
  ]);
  assert.equal(outcome.isError, true);
  assert.equal(
    outcome.text,
    "operations[0]: the edited text would not parse as intended near line 24; check code fences and HTML blocks in the content or around line 24",
  );
});

test("specs/markdown-tool.md#edit-operations: the parse refusal names the first heading that differs from the expected ones", async () => {
  const text = ["# A", "", "## B", "", "text </pre> here", "", "## C", ""].join("\n");
  const outcome = await edit(text, [
    { op: "insert", position: "before", at: "B", content: "## New\n\n<pre>" },
  ]);
  assert.equal(outcome.isError, true);
  assert.equal(
    outcome.text,
    "operations[0]: the edited text would not parse as intended near line 11; check code fences and HTML blocks in the content or around line 11",
  );
});

test("specs/markdown-tool.md#edit-applying: a batch whose later operation fails writes nothing", async () => {
  let writes = 0;
  const outcome = await edit(
    DOCUMENT,
    [
      { op: "delete", section: "One A" },
      { op: "delete", section: "No Such Section" },
    ],
    {
      write: () => {
        writes += 1;
      },
    },
  );
  assert.equal(outcome.isError, true);
  assert.equal(
    outcome.text,
    'operations[1]: no section "No Such Section" in a.md. Run outline to list its sections.',
  );
  assert.equal(writes, 0);
});

test("specs/markdown-tool.md#edit-applying: an unchanged call writes nothing and says so", async () => {
  let writes = 0;
  const outcome = await edit(DOCUMENT, [{ op: "rename", section: "Doc", heading: "Doc" }], {
    write: () => {
      writes += 1;
    },
  });
  assert.equal(outcome.isError, false);
  assert.equal(writes, 0);
  const revision = must(outcome.details.revision);
  assert.equal(outcome.lines[0], `a.md unchanged · 19 lines · revision ${revision}`);
  assert.equal(outcome.details.changed, false);
  assert.equal(outcome.details.previousRevision, revision);
});

test("specs/markdown-tool.md#edit-applying: lines outside the touched ones keep their bytes, and endings stay per line", async () => {
  const text = [
    "# Doc\r\n",
    "\r\n",
    "## One\r\n",
    "\n",
    "body one\n",
    "\n",
    "## Two\r\n",
    "\n",
    "body two\r\n",
  ].join("");
  const outcome = await edit(text, [{ op: "rename", section: "One", heading: "Uno" }]);
  assert.equal(
    outcome.file,
    [
      "# Doc\r\n",
      "\r\n",
      "## Uno\r\n",
      "\n",
      "body one\n",
      "\n",
      "## Two\r\n",
      "\n",
      "body two\r\n",
    ].join(""),
  );
});

test("specs/markdown-tool.md#edit-applying: content lines take the file's first line ending, and moved lines keep their own", async () => {
  const text = [
    "# Doc\r\n",
    "\r\n",
    "## One\n",
    "\n",
    "body one\n",
    "\n",
    "## Two\r\n",
    "\n",
    "body two\r\n",
  ].join("");
  const inserted = await edit(text, [
    { op: "insert", position: "after", at: "One", content: "## New\n\ntext new" },
  ]);
  assert.equal(
    inserted.file,
    [
      "# Doc\r\n",
      "\r\n",
      "## One\n",
      "\n",
      "body one\n",
      "\r\n",
      "## New\r\n",
      "\r\n",
      "text new\r\n",
      "\n",
      "## Two\r\n",
      "\n",
      "body two\r\n",
    ].join(""),
  );
  const moved = await edit(text, [{ op: "move", section: "One", position: "after", at: "Two" }]);
  assert.equal(moved.isError, false);
  assert.equal(moved.file.endsWith("## Two\r\n\nbody two\r\n\r\n## One\n\nbody one\n"), true);
});

test("specs/markdown-tool.md#edit-applying: the last line's ending follows the file, and a former last line gains one", async () => {
  const text = "# A\n\ntext";
  const appended = await edit(text, [
    { op: "insert", position: "last", at: "(document)", content: "## B\n\nb" },
  ]);
  assert.equal(appended.file, "# A\n\ntext\n\n## B\n\nb");
  const removed = await edit(text, [{ op: "replace_body", section: "A", content: "" }]);
  assert.equal(removed.file, "# A");
});

test("specs/markdown-tool.md#edit-applying: an edit keeps a leading U+FEFF", async () => {
  const outcome = await edit("\uFEFF# A\n\ntext\n", [{ op: "rename", section: "A", heading: "B" }]);
  assert.equal(outcome.file, "\uFEFF# B\n\ntext\n");
});

test("specs/markdown-tool.md#edit-applying: a write failure is a tool error with the code", async () => {
  const outcome = await edit(DOCUMENT, [{ op: "rename", section: "Doc", heading: "Title" }], {
    write: () => {
      const error = new Error("denied");
      Object.assign(error, { code: "EACCES" });
      throw error;
    },
  });
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, "cannot write a.md: EACCES");
});

test("specs/markdown-tool.md#edit-applying: a later operation sees the text the earlier ones left", async () => {
  const outcome = await edit(DOCUMENT, [
    { op: "rename", section: "Two", heading: "Second" },
    { op: "delete", section: "Second" },
  ]);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.file.endsWith("text b\n"), true);
});

const SHIFT = ["# A", "", "## Dup", "", "old", "", "# B", "", "text", ""].join("\n");

test("specs/markdown-tool.md#section-addresses: a line range names the section as it was before the call, after an earlier operation shifted its lines", async () => {
  const outcome = await edit(SHIFT, [
    { op: "insert", at: "Dup", position: "before", content: "## New\n\nnew" },
    { op: "delete", section: "3-5 Dup" },
  ]);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.file.includes("## New"), true);
  assert.equal(outcome.file.includes("Dup"), false);
  const stale = await edit(SHIFT, [
    { op: "insert", at: "Dup", position: "before", content: "## New\n\nnew" },
    { op: "delete", section: "6-8 Dup" },
  ]);
  assert.equal(stale.isError, true);
  assert.equal(
    stale.text,
    'operations[1]: no section "6-8 Dup" in a.md spans that line range; without it the address matches: 3-5 A > Dup. Run outline for current line ranges.',
  );
});

test("specs/markdown-tool.md#section-addresses: a line range with a trailing ` [<n>]` resolves after an earlier operation deleted the first sibling", async () => {
  const text = ["# Doc", "", "## X", "", "first", "", "## X", "", "second", ""].join("\n");
  const outcome = await edit(text, [
    { op: "delete", section: "3-5 X" },
    { op: "replace_body", section: "7-9 X [2]", content: "changed" },
  ]);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.file.includes("changed"), true);
  assert.equal(outcome.file.includes("first"), false);
  assert.equal(outcome.file.includes("second"), false);
});

test("specs/markdown-tool.md#section-addresses: a line range is exempt from the renumbering collision that refuses its unranged form", async () => {
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
  const ranged = await edit(text, [
    { op: "delete", section: "3.1 Candidates" },
    { op: "move", section: "4.1 Examples", position: "last", at: "3. Find" },
    { op: "delete", section: "17-19 3.1" },
    { op: "delete", section: "11-13 3.1" },
  ]);
  assert.equal(ranged.isError, false);
  assert.equal(ranged.file.includes("Examples"), false);
  assert.equal(ranged.file.includes("Dup"), false);
  const unranged = await edit(text, [
    { op: "delete", section: "3.1 Candidates" },
    { op: "move", section: "4.1 Examples", position: "last", at: "3. Find" },
    { op: "delete", section: "17-19 3.1" },
    { op: "delete", section: "3.1" },
  ]);
  assert.equal(unranged.isError, true);
  assert.equal(
    unranged.text,
    'operations[3]: "3.1" now names Spec > 3. Find > 3.1 Examples, renumbered by operation 1; name it without its number, with an ancestor if needed',
  );
});

test("specs/markdown-tool.md#section-addresses: a section named twice by renumbering reports the last operation that named it", async () => {
  const text = [
    "# Spec",
    "",
    "## 1. Find",
    "",
    "### 1.1 Candidates",
    "",
    "## 2. Get",
    "",
    "### 2.1 Examples",
    "",
    "## 3. Other",
    "",
    "### 1.1 Dup",
    "",
  ].join("\n");
  const outcome = await edit(text, [
    { op: "delete", section: "1. Find" },
    { op: "insert", position: "before", at: "1.1 Examples", content: "### Pre" },
    { op: "delete", section: "1.1 Pre" },
    { op: "delete", section: "13-13 1.1" },
    { op: "delete", section: "1.1" },
  ]);
  assert.equal(outcome.isError, true);
  assert.equal(
    outcome.text,
    'operations[4]: "1.1" now names Spec > 1. Get > 1.1 Examples, renumbered by operation 2; name it without its number, with an ancestor if needed',
  );
});

test("specs/markdown-tool.md#section-addresses: a line range names a section the call wrote, as (new), in the error", async () => {
  const text = ["# A", "", "## Dup", "", "old", "", "# B", "", "text", ""].join("\n");
  const outcome = await edit(text, [
    { op: "insert", at: "B", position: "last", content: "## Dup\n\nnew" },
    { op: "delete", section: "5-9 Dup" },
  ]);
  assert.equal(outcome.isError, true);
  assert.equal(
    outcome.text,
    'operations[1]: no section "5-9 Dup" in a.md spans that line range; without it the address matches: 3-5 A > Dup; (new) B > Dup. Run outline for current line ranges.',
  );
  assert.equal(outcome.file, text);
});

test("specs/markdown-tool.md#section-addresses: (document) with a stripped marker is the end of the text for insert last", async () => {
  const expected = `${DOCUMENT}\n# B\n\nb\n`;
  for (const at of ["* (document)", "1-3 (document)"]) {
    const outcome = await edit(DOCUMENT, [
      { op: "insert", position: "last", at, content: "# B\n\nb" },
    ]);
    assert.equal(outcome.isError, false, at);
    assert.equal(outcome.file, expected, at);
  }
});

test("specs/markdown-tool.md#edit-result: the revision is the first eight hex digits of the SHA-256 of the written bytes", async () => {
  const outcome = await edit(DOCUMENT, [{ op: "rename", section: "Doc", heading: "Title" }]);
  assert.equal(outcome.isError, false);
  const digest = createHash("sha256").update(outcome.file).digest("hex").slice(0, 8);
  assert.equal(outcome.details.revision, digest);
  assert.equal(outcome.lines[0], `Edited a.md: 1 operations · 19 lines · revision ${digest}`);
});

test("specs/markdown-tool.md#section-addresses: (preamble) with a line range is replaced as the preamble in edit", async () => {
  const text = ["intro", "", "# A", "", "text", ""].join("\n");
  const outcome = await edit(text, [
    { op: "replace_body", section: "9-9 (preamble)", content: "new intro" },
  ]);
  assert.equal(outcome.isError, false);
  assert.equal(must(outcome.file.split("\n")[0]), "new intro");
});
