import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  bytesOf,
  call,
  cleanupRoots,
  runtime,
  revisionOf,
  tempDir,
  write,
  type CallOutcome,
} from "./support.ts";
import { must } from "../support/must.ts";

/**
 * specs/markdown-tool.md#documents: the file's text and lines (specs/markdown-tool.md#file-access), the
 * parse (specs/markdown-tool.md#parsing), the sections (specs/markdown-tool.md#sections), and the section addresses
 * (specs/markdown-tool.md#section-addresses), checked through the outline, read, and edit actions.
 */

/** The outline of a temporary `a.md` holding `text`; the call must succeed. */
async function outlineOf(text: string): Promise<CallOutcome> {
  const dir = tempDir();
  const name = write(dir, "a.md", text);
  const outcome = await call(runtime(), dir, { action: "outline", path: name });
  assert.equal(outcome.isError, false, outcome.text);
  return outcome;
}

/** The lines of an outline after its header: the entries and the marker lines. */
async function bodyOf(text: string): Promise<string[]> {
  return (await outlineOf(text)).lines.slice(1);
}

const PARSING_FIXTURE = [
  "# Top",
  "",
  "text",
  "",
  "## Fence",
  "",
  "```markdown",
  "# inside a fence",
  "## also inside",
  "```",
  "",
  "## Quote",
  "",
  "> # inside a quote",
  "",
  "## List",
  "",
  "- item",
  "",
  "  # inside a list item",
  "",
  "## Html",
  "",
  "<div>",
  "# inside an html block",
  "</div>",
  "",
  "## Indented",
  "",
  "    # inside an indented code block",
  "",
  "## Last",
  "",
].join("\n");

test("specs/markdown-tool.md#parsing: code blocks, quotes, lists, and HTML blocks hold no heading", async () => {
  try {
    assert.deepEqual(await bodyOf(PARSING_FIXTURE), [
      "1-32 # Top (32 lines)",
      "5-10 ## Fence (6 lines)",
      "12-14 ## Quote (3 lines)",
      "16-20 ## List (5 lines)",
      "22-26 ## Html (5 lines)",
      "28-30 ## Indented (3 lines)",
      "32-32 ## Last (1 lines)",
    ]);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#parsing: setext headings take their level from the underline and keep their content lines", async () => {
  try {
    assert.deepEqual(await bodyOf("Title\n=====\n\ntext\n"), ["1-4 # Title (4 lines)"]);
    assert.deepEqual(await bodyOf("Section\n-------\n\ntext\n"), ["1-4 ## Section (4 lines)"]);
    assert.deepEqual(await bodyOf("Foo\nbar\n===\n\ntext\n"), ["1-5 # Foo bar (5 lines)"]);
    assert.deepEqual(await bodyOf("  Foo  \n  bar\t\n---\n"), ["1-3 ## Foo bar (3 lines)"]);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#parsing: an ATX heading's text is its raw contents, kept as written", async () => {
  const cases: [string, string[]][] = [
    ["## foo ##\n", ["1-1 ## foo (1 lines)"]],
    ["# foo#\n", ["1-1 # foo# (1 lines)"]],
    ["### foo \\###\n", ["1-1 ### foo \\### (1 lines)"]],
    ["# foo ##################################\n", ["1-1 # foo (1 lines)"]],
    ["# foo ### b\n", ["1-1 # foo ### b (1 lines)"]],
    ["#\n", ["1-1 # (untitled) (1 lines)"]],
    ["# *Emphasis* and `code` and &amp;\n", ["1-1 # *Emphasis* and `code` and &amp; (1 lines)"]],
    ["####### foo\n", ["1-1 (preamble)", "(no headings)"]],
    ["#5 bolt\n", ["1-1 (preamble)", "(no headings)"]],
    ["   # three\n", ["1-1 # three (1 lines)"]],
  ];
  try {
    for (const [text, expected] of cases) {
      assert.deepEqual(await bodyOf(text), expected, JSON.stringify(text));
    }
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#parsing: a table followed by a thematic break makes no setext heading", async () => {
  try {
    const text = ["| a | b |", "| - | - |", "| 1 | 2 |", "---", "", "# After", ""].join("\n");
    assert.deepEqual(await bodyOf(text), ["1-4 (preamble)", "6-6 # After (1 lines)"]);
  } finally {
    cleanupRoots();
  }
});

const DEFINED_SETEXT = "[foo]: /url\nBar\n===\n\nSee [foo].\n";

test("specs/markdown-tool.md#parsing: a setext heading after link reference definitions starts at its content line", async () => {
  try {
    assert.deepEqual(await bodyOf(DEFINED_SETEXT), ["1-1 (preamble)", "2-5 # Bar (4 lines)"]);
    assert.deepEqual(await bodyOf("[a]: /x\n[b]: /y\nBar\n---\n"), [
      "1-2 (preamble)",
      "3-4 ## Bar (2 lines)",
    ]);
    assert.deepEqual(await bodyOf('[a]: /x\n"t"\n  Bar *x*\n===\n'), [
      "1-2 (preamble)",
      "3-4 # Bar *x* (2 lines)",
    ]);
    assert.deepEqual(await bodyOf("[a]: /x\n===\n"), ["1-2 (preamble)", "(no headings)"]);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#action-read: a read of a setext heading after link reference definitions shows its own lines", async () => {
  const dir = tempDir();
  try {
    const name = write(dir, "a.md", DEFINED_SETEXT);
    const outcome = await call(runtime(), dir, { action: "read", path: name, section: "Bar" });
    assert.equal(outcome.isError, false, outcome.text);
    assert.deepEqual(outcome.lines.slice(1), [
      "Bar",
      "===",
      "",
      "See [foo].",
      "--- end of section ---",
    ]);
    assert.equal(outcome.details.start, 2);
    assert.equal(outcome.details.end, 5);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#edit-applying: renaming a setext heading after link reference definitions keeps the definitions", async () => {
  const dir = tempDir();
  try {
    const name = write(dir, "a.md", DEFINED_SETEXT);
    const instance = runtime();
    const revision = await revisionOf(instance, dir, name);
    const outcome = await call(instance, dir, {
      action: "edit",
      path: name,
      revision,
      operations: [{ op: "rename", section: "Bar", heading: "Baz" }],
    });
    assert.equal(outcome.isError, false, outcome.text);
    assert.equal(bytesOf(dir, name), "[foo]: /url\nBaz\n===\n\nSee [foo].\n");
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#parsing: frontmatter is line 1 through the first later `---` line", async () => {
  try {
    assert.deepEqual(await bodyOf(["---", "title: x", "---", "", "# A", ""].join("\n")), [
      "1-3 (frontmatter)",
      "5-5 # A (1 lines)",
    ]);
    assert.deepEqual(await bodyOf(["---", "title: x", "", "# A", ""].join("\n")), [
      "1-2 (preamble)",
      "4-4 # A (1 lines)",
    ]);
    assert.deepEqual(await bodyOf(["---  ", "x", "---\t", ""].join("\n")), [
      "1-3 (frontmatter)",
      "(no headings)",
    ]);
    assert.deepEqual(await bodyOf([" ---", "x", "---"].join("\n")), [
      "1-1 (preamble)",
      "2-3 ## x (2 lines)",
    ]);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#file-access: a leading U+FEFF is not part of line 1, and CRLF, CR, and mixed endings split lines", async () => {
  const dir = tempDir();
  try {
    writeFileSync(`${dir}/bom.md`, new Uint8Array([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x41, 0x0a]));
    const bom = await call(runtime(), dir, { action: "outline", path: "bom.md" });
    assert.equal(bom.isError, false, bom.text);
    assert.deepEqual(bom.lines.slice(1), ["1-1 # A (1 lines)"]);

    assert.deepEqual(await bodyOf("# A\r\n\r\n## B\r\n"), [
      "1-3 # A (3 lines)",
      "3-3 ## B (1 lines)",
    ]);
    assert.deepEqual(await bodyOf("# A\r\r## B\r"), ["1-3 # A (3 lines)", "3-3 ## B (1 lines)"]);
    assert.deepEqual(await bodyOf("# A\r\n\r## B\n"), ["1-3 # A (3 lines)", "3-3 ## B (1 lines)"]);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#file-access: a line ending at the end of the text starts no further line", async () => {
  const cases: [string, string][] = [
    ["", "0 lines"],
    ["a", "1 lines"],
    ["a\n", "1 lines"],
    ["a\n\n", "2 lines"],
    ["\n", "1 lines"],
  ];
  try {
    for (const [text, expected] of cases) {
      const outcome = await outlineOf(text);
      assert.equal(outcome.lines[0]?.split(" · ")[1], expected, JSON.stringify(text));
    }
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#file-access: a revision is 8 lowercase hexadecimal digits of the SHA-256 of the bytes", async () => {
  try {
    const outcome = await outlineOf("# A\n");
    const expected = createHash("sha256").update("# A\n").digest("hex").slice(0, 8);
    assert.equal(outcome.details.revision, expected);
    assert.match(expected, /^[0-9a-f]{8}$/);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#sections: a section ends at its last non-blank line before the next same-or-shallower heading", async () => {
  try {
    const text = ["# A", "", "text", "", "### B", "", "text", "", "## C", "", "text", "", ""].join(
      "\n",
    );
    assert.deepEqual(await bodyOf(text), [
      "1-11 # A (11 lines)",
      "5-7 ### B (3 lines)",
      "9-11 ## C (3 lines)",
    ]);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#sections: the preamble is the text before the first heading", async () => {
  try {
    assert.deepEqual(await bodyOf(["intro", "", "# A", "", "text", ""].join("\n")), [
      "1-1 (preamble)",
      "3-5 # A (3 lines)",
    ]);
    assert.deepEqual(await bodyOf(["", "", "intro", "more", "", "# A", ""].join("\n")), [
      "3-4 (preamble)",
      "6-6 # A (1 lines)",
    ]);
    assert.deepEqual(await bodyOf(["intro", "", "text", ""].join("\n")), [
      "1-3 (preamble)",
      "(no headings)",
    ]);
    assert.deepEqual(await bodyOf(["", " ", "\t", ""].join("\n")), ["(no headings)"]);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#sections: a section's own body stops before its first subsection", async () => {
  const dir = tempDir();
  try {
    const instance = runtime();
    const name = write(dir, "a.md", ["# A", "", "own", "body", "", "## B", "", "b", ""].join("\n"));
    const revision = await revisionOf(instance, dir, name);
    const outcome = await call(instance, dir, {
      action: "edit",
      path: name,
      revision,
      operations: [{ op: "replace_body", section: "A", content: "new" }],
    });
    assert.equal(outcome.isError, false, outcome.text);
    assert.equal(bytesOf(dir, name), ["# A", "", "new", "", "## B", "", "b", ""].join("\n"));
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#section-addresses: components carry ` [<n>]` for repeated sibling texts", async () => {
  try {
    const text = ["# A", "", "## X", "", "## X", "", "## X", "", "# B", "", "## X", ""].join("\n");
    assert.deepEqual(await bodyOf(text), [
      "1-7 # A (7 lines)",
      "3-3 ## X (1 lines)",
      "5-5 ## X [2] (1 lines)",
      "7-7 ## X [3] (1 lines)",
      "9-11 # B (3 lines)",
      "11-11 ## X (1 lines)",
    ]);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#section-addresses: an empty heading text is (untitled)", async () => {
  try {
    assert.deepEqual(await bodyOf("#\n\n##\n"), [
      "1-3 # (untitled) (3 lines)",
      "3-3 ## (untitled) (1 lines)",
    ]);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#section-addresses: a missing address lists the sections whose component contains its last component", async () => {
  const dir = tempDir();
  try {
    const instance = runtime();
    const name = write(
      dir,
      "a.md",
      ["# Doc", "", "## Matching", "", "## Match report", ""].join("\n"),
    );
    const similar = await call(instance, dir, { action: "read", path: name, section: "Match" });
    assert.equal(similar.isError, true);
    assert.equal(
      similar.text,
      'no section "Match" in a.md. Similar: Doc > Matching; Doc > Match report',
    );
    const none = await call(instance, dir, { action: "read", path: name, section: "zzz" });
    assert.equal(none.text, 'no section "zzz" in a.md. Run outline to list its sections.');
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#renumbering: only a number prefix in its form numbers a heading", async () => {
  const dir = tempDir();
  try {
    const instance = runtime();
    const text = [
      "# Doc",
      "",
      "## 0. Intro",
      "",
      "## 1.2.0 Notes",
      "",
      "## v1.2 Notes",
      "",
      "## 3. Find",
      "",
      "## 3) Find",
      "",
      "## 3.1 Filters",
      "",
      "## 3.1Filters",
      "",
      "## Section 3",
      "",
    ].join("\n");
    const name = write(dir, "a.md", text);
    const read = (section: string): Promise<CallOutcome> =>
      call(instance, dir, { action: "read", path: name, section });

    assert.equal((await read("0")).details.address, "Doc > 0. Intro");
    assert.equal((await read("3")).details.address, "Doc > 3. Find");
    assert.equal((await read("3.1")).details.address, "Doc > 3.1 Filters");
    assert.equal((await read("1.2.0")).details.address, "Doc > 1.2.0 Notes");

    const unnumbered = await read("1.2");
    assert.equal(unnumbered.isError, true);
    assert.equal(
      unnumbered.text,
      'no section "1.2" in a.md. Similar: Doc > 1.2.0 Notes; Doc > v1.2 Notes',
    );
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#parsing: an outline shows a heading's line range and a frontmatter's lines", async () => {
  const dir = tempDir();
  try {
    const name = write(
      dir,
      "a.md",
      ["---", "title: x", "---", "", "intro", "", "# A", "", "text"].join("\n"),
    );
    const outcome = await call(runtime(), dir, { action: "outline", path: name });
    assert.deepEqual(outcome.lines, [
      `${name} · 9 lines · revision ${must(outcome.details.revision)} · depth 1`,
      "1-3 (frontmatter)",
      "5-5 (preamble)",
      "7-9 # A (3 lines)",
    ]);
    assert.deepEqual(outcome.details.frontmatter, { start: 1, end: 3 });
    assert.deepEqual(outcome.details.preamble, { start: 5, end: 5 });
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#file-access: a file's bytes are read as Markdown whatever its name", async () => {
  const dir = tempDir();
  try {
    const name = write(dir, "notes.txt", "# A\n");
    const outcome = await call(runtime(), dir, { action: "outline", path: name });
    assert.equal(outcome.isError, false);
    assert.match(outcome.text, /# A/);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#file-access: the file access checks, in their order", async () => {
  const dir = tempDir();
  try {
    const instance = runtime();
    const missing = await call(instance, dir, { action: "outline", path: "nope.md" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /^cannot read nope\.md: ENOENT/);

    const big = write(dir, "big.md", "x".repeat(4194305));
    const tooBig = await call(instance, dir, { action: "outline", path: big });
    assert.equal(
      tooBig.text,
      `${big} is 4194305 bytes; Markdown reads files of at most 4194304 bytes`,
    );

    const exact = write(dir, "exact.md", "x".repeat(4194304));
    const allowed = await call(instance, dir, { action: "outline", path: exact });
    assert.equal(allowed.isError, false);

    write(dir, "nul.md", "a\u0000b");
    assert.equal(
      (await call(instance, dir, { action: "read", path: "nul.md", section: "A" })).text,
      "nul.md is not UTF-8 text",
    );

    const invalid = write(dir, "invalid.md", "");
    writeFileSync(`${dir}/${invalid}`, new Uint8Array([0x41, 0xff, 0x42]));
    assert.equal(
      (await call(instance, dir, { action: "outline", path: invalid })).text,
      "invalid.md is not UTF-8 text",
    );
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#file-access: an edit of a file whose revision differs is rejected", async () => {
  const dir = tempDir();
  try {
    const instance = runtime();
    const name = write(dir, "a.md", "# A\n\ntext\n");
    const outcome = await call(instance, dir, {
      action: "edit",
      path: name,
      revision: "00000000",
      operations: [{ op: "delete", section: "A" }],
    });
    assert.equal(outcome.isError, true);
    assert.equal(
      outcome.text,
      `${name} has changed since revision 00000000; read the sections you edit, or outline the file, again before editing`,
    );
  } finally {
    cleanupRoots();
  }
});
