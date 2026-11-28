import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { call, cleanupRoots, revisionOf, runtime, tempDir, write } from "./support.ts";

/**
 * specs/markdown-tool.md#validation: every execution-time check, in its order,
 * with its exact error text, reported before the file is read. Each call goes
 * through the tool; the file named is missing, so any text but the check's own
 * would show the check did not run first.
 */

/** The error text of a call through the tool, failing when the call is not a tool error. */
async function errorOf(params: Record<string, unknown>): Promise<string> {
  const dir = tempDir();
  try {
    const outcome = await call(runtime(), dir, params);
    assert.equal(outcome.isError, true, `expected a tool error for ${JSON.stringify(params)}`);
    return outcome.text;
  } finally {
    cleanupRoots();
  }
}

interface Case {
  name: string;
  params: Record<string, unknown>;
  error: string;
}

const head = "a.md";

const cases: Case[] = [
  // 1: a field the action does not accept, first in table order.
  {
    name: "outline rejects revision",
    params: { action: "outline", path: head, revision: "deadbeef" },
    error: "revision is not valid for action outline",
  },
  {
    name: "read rejects preview",
    params: { action: "read", path: head, section: "A", preview: true },
    error: "preview is not valid for action read",
  },
  {
    name: "edit rejects depth",
    params: { action: "edit", path: head, depth: 2, revision: "deadbeef", operations: [] },
    error: "depth is not valid for action edit",
  },
  {
    name: "the first unaccepted field in table order is reported",
    params: { action: "read", path: head, section: "A", preview: true, revision: "deadbeef" },
    error: "preview is not valid for action read",
  },
  // 2: path.
  {
    name: "path of spaces",
    params: { action: "outline", path: "   " },
    error: "path must be a non-empty string",
  },
  {
    name: "path missing",
    params: { action: "outline" },
    error: "path must be a non-empty string",
  },
  // 3: section.
  {
    name: "links rejects an empty section",
    params: { action: "links", path: head, section: "  " },
    error: "section must be a non-empty string",
  },
  {
    name: "read without section or sections",
    params: { action: "read", path: head },
    error: "read requires section or sections",
  },
  {
    name: "read with both section and sections",
    params: { action: "read", path: head, section: "A", sections: ["A"] },
    error: "section and sections cannot both be given",
  },
  {
    name: "read with an empty sections array",
    params: { action: "read", path: head, sections: [] },
    error: "sections must be a non-empty array of strings",
  },
  {
    name: "read with a blank element in sections",
    params: { action: "read", path: head, sections: ["A", "  "] },
    error: "sections[1] must be a non-empty string",
  },
  {
    name: "read with (document) in sections",
    params: { action: "read", path: head, sections: ["(document)"] },
    error: "sections[0]: (document) is not valid as the section of read",
  },
  {
    name: "read with sections and offset",
    params: { action: "read", path: head, sections: ["A"], offset: 1 },
    error: "offset is not valid with sections",
  },
  {
    name: "read with an empty section",
    params: { action: "read", path: head, section: " \t " },
    error: "section must be a non-empty string",
  },
  {
    name: "outline with an empty section",
    params: { action: "outline", path: head, section: "" },
    error: "section must be a non-empty string",
  },
  // 4: the named section.
  {
    name: "outline names (document)",
    params: { action: "outline", path: head, section: "(document)" },
    error: "(document) is not valid as the section of outline",
  },
  {
    name: "outline names (preamble)",
    params: { action: "outline", path: head, section: " (preamble) " },
    error: "(preamble) is not valid as the section of outline",
  },
  {
    name: "read names (document)",
    params: { action: "read", path: head, section: "(document)" },
    error: "(document) is not valid as the section of read",
  },
  // 5: depth.
  {
    name: "depth of 0",
    params: { action: "outline", path: head, depth: 0 },
    error: "depth must be an integer from 1 to 6",
  },
  {
    name: "depth of 7",
    params: { action: "read", path: head, section: "A", depth: 7 },
    error: "depth must be an integer from 1 to 6",
  },
  {
    name: "fractional depth",
    params: { action: "outline", path: head, depth: 2.5 },
    error: "depth must be an integer from 1 to 6",
  },
  // 6 and 7: offset.
  {
    name: "links rejects a negative offset",
    params: { action: "links", path: head, offset: -1 },
    error: "offset must be a non-negative integer",
  },
  {
    name: "outline offset below zero",
    params: { action: "outline", path: head, offset: -1 },
    error: "offset must be a non-negative integer",
  },
  {
    name: "outline fractional offset",
    params: { action: "outline", path: head, offset: 1.5 },
    error: "offset must be a non-negative integer",
  },
  {
    name: "read offset of zero",
    params: { action: "read", path: head, section: "A", offset: 0 },
    error: "offset must be a positive integer",
  },
  {
    name: "read negative offset",
    params: { action: "read", path: head, section: "A", offset: -3 },
    error: "offset must be a positive integer",
  },
  // 8 and 9: limit.
  {
    name: "links rejects a limit above 500",
    params: { action: "links", path: head, limit: 501 },
    error: "limit must be an integer from 1 to 500",
  },
  {
    name: "outline limit of 0",
    params: { action: "outline", path: head, limit: 0 },
    error: "limit must be an integer from 1 to 500",
  },
  {
    name: "outline limit of 501",
    params: { action: "outline", path: head, limit: 501 },
    error: "limit must be an integer from 1 to 500",
  },
  {
    name: "read limit of 0",
    params: { action: "read", path: head, section: "A", limit: 0 },
    error: "limit must be an integer from 1 to 2000",
  },
  {
    name: "read limit of 2001",
    params: { action: "read", path: head, section: "A", limit: 2001 },
    error: "limit must be an integer from 1 to 2000",
  },
  // 10 and 11: revision and operations.
  {
    name: "edit without revision",
    params: { action: "edit", path: head, operations: [{ op: "delete", section: "A" }] },
    error:
      "revision must be the 8-digit revision an outline, read, or edit result showed for this file",
  },
  {
    name: "edit with an upper-case revision",
    params: {
      action: "edit",
      path: head,
      revision: "DEADBEEF",
      operations: [{ op: "delete", section: "A" }],
    },
    error:
      "revision must be the 8-digit revision an outline, read, or edit result showed for this file",
  },
  {
    name: "edit with a short revision",
    params: {
      action: "edit",
      path: head,
      revision: "abc",
      operations: [{ op: "delete", section: "A" }],
    },
    error:
      "revision must be the 8-digit revision an outline, read, or edit result showed for this file",
  },
  {
    name: "edit without operations",
    params: { action: "edit", path: head, revision: "deadbeef" },
    error: "operations must hold 1 to 50 operations",
  },
  // 12: a field the op does not accept.
  {
    name: "delete rejects content",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "delete", section: "A", content: "x" }],
    },
    error: "operations[0]: content is not valid for op delete",
  },
  {
    name: "the first unaccepted op field in table order is reported",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "rename", section: "A", heading: "B", content: "x" }],
    },
    error: "operations[0]: content is not valid for op rename",
  },
  // 13: a field the op requires.
  {
    name: "rename without heading",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "rename", section: "A" }],
    },
    error: "operations[0]: op rename requires heading",
  },
  {
    name: "insert without position",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "insert", at: "A", content: "## B" }],
    },
    error: "operations[0]: op insert requires position",
  },
  {
    name: "the first missing op field in table order is reported",
    params: { action: "edit", path: head, revision: "deadbeef", operations: [{ op: "insert" }] },
    error: "operations[0]: op insert requires position",
  },
  // 14: an empty address.
  {
    name: "delete with a blank section",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "delete", section: "  " }],
    },
    error: "operations[0]: section must be a non-empty string",
  },
  {
    name: "insert with a blank at",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "insert", position: "after", at: "", content: "## B" }],
    },
    error: "operations[0]: at must be a non-empty string",
  },
  // 15: a named address.
  {
    name: "delete names (document)",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "delete", section: "(document)" }],
    },
    error: "operations[0]: (document) is not valid as the section of op delete",
  },
  {
    name: "delete names (preamble)",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "delete", section: "(preamble)" }],
    },
    error: "operations[0]: (preamble) is not valid as the section of op delete",
  },
  {
    name: "at names (preamble)",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "insert", position: "after", at: "(preamble)", content: "## B" }],
    },
    error: "operations[0]: (preamble) is not valid as the at of op insert",
  },
  // 16: at (document) with a side position.
  {
    name: "at (document) before",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "insert", position: "before", at: "(document)", content: "## B" }],
    },
    error: "operations[0]: at (document) takes position first or last",
  },
  // 17: the heading.
  {
    name: "blank heading",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "rename", section: "A", heading: " \t " }],
    },
    error: "operations[0]: heading must be one non-empty line",
  },
  {
    name: "two-line heading",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "rename", section: "A", heading: "one\ntwo" }],
    },
    error: "operations[0]: heading must be one non-empty line",
  },
  {
    name: "heading ending with a line ending",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "rename", section: "A", heading: "Q\n" }],
    },
    error: "operations[0]: heading must be one non-empty line",
  },
  // 18: the level.
  {
    name: "level of 7",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "set_level", section: "A", level: 7 }],
    },
    error: "operations[0]: level must be an integer from 1 to 6",
  },
  // 19: content that does not start with a heading line.
  {
    name: "insert content without a heading",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "insert", position: "after", at: "A", content: "plain text" }],
    },
    error: "operations[0]: content must start with a heading line",
  },
  {
    name: "insert content that is empty",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "insert", position: "after", at: "A", content: "\n \n" }],
    },
    error: "operations[0]: content must start with a heading line",
  },
  {
    name: "insert content whose heading line is not its first line",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "insert", position: "after", at: "A", content: "text\n## B" }],
    },
    error: "operations[0]: content must start with a heading line",
  },
  // 20: content of more than one section.
  {
    name: "insert content with a second heading at the same level",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "insert", position: "after", at: "A", content: "## B\n\ntext\n\n## C" }],
    },
    error: "operations[0]: content must be one section: line 5 is a heading of level 2",
  },
  {
    name: "the line number counts from the content as given",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [
        { op: "insert", position: "after", at: "A", content: "\n\n## B\n\n### C\n\n## D" },
      ],
    },
    error: "operations[0]: content must be one section: line 7 is a heading of level 2",
  },
  // 21: replace_body content with a heading.
  {
    name: "replace_body content with a heading",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "replace_body", section: "A", content: "text\n\n## B" }],
    },
    error: "operations[0]: replace_body content must contain no heading: line 3 is one",
  },
  // 22: a marker of a read result.
  {
    name: "content with the end marker",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [
        { op: "insert", position: "after", at: "A", content: "## B\n\n--- end of section ---" },
      ],
    },
    error:
      "operations[0]: content line 3 is a marker of read, not file text; read the section without depth and to its end first",
  },
  {
    name: "content with the hidden-lines marker",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [{ op: "replace_body", section: "A", content: "[… 12 lines hidden: 5-16]" }],
    },
    error:
      "operations[0]: content line 1 is a marker of read, not file text; read the section without depth and to its end first",
  },
  {
    name: "content with the cut marker",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [
        {
          op: "replace_body",
          section: "A",
          content: "text\n\n--- cut: continue with offset 40 ---",
        },
      ],
    },
    error:
      "operations[0]: content line 3 is a marker of read, not file text; read the section without depth and to its end first",
  },
  {
    name: "content with a result header",
    params: {
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [
        {
          op: "insert",
          position: "after",
          at: "A",
          content: "## B\n\nspec.md · A · lines 3-9 · revision deadbeef",
        },
      ],
    },
    error:
      "operations[0]: content line 3 is a marker of read, not file text; read the section without depth and to its end first",
  },
];

for (const one of cases) {
  test(`specs/markdown-tool.md#validation: ${one.name}`, async () => {
    assert.equal(await errorOf(one.params), one.error);
  });
}

test("specs/markdown-tool.md#validation: non-breaking space before marker text is accepted as content", async () => {
  const dir = tempDir();
  try {
    write(dir, "a.md", "# A\n\nold\n");
    const instance = runtime();
    const outcome = await call(instance, dir, {
      action: "edit",
      path: "a.md",
      revision: await revisionOf(instance, dir, "a.md"),
      operations: [{ op: "replace_body", section: "A", content: "\u00a0--- end of section ---" }],
    });
    assert.equal(outcome.isError, false, outcome.text);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#validation: operations that hold no operation or too many are rejected", async () => {
  for (const operations of [
    [],
    "x",
    7,
    Array.from({ length: 51 }, () => ({ op: "delete", section: "A" })),
  ]) {
    assert.equal(
      await errorOf({ action: "edit", path: head, revision: "deadbeef", operations }),
      "operations must hold 1 to 50 operations",
    );
  }
});

test("specs/markdown-tool.md#validation: the checks of the call run before those of its operations", async () => {
  assert.equal(
    await errorOf({
      action: "edit",
      path: head,
      revision: "bad",
      operations: [{ op: "delete", section: "A", content: "x" }],
    }),
    "revision must be the 8-digit revision an outline, read, or edit result showed for this file",
  );
});

test("specs/markdown-tool.md#validation: the first failing operation is reported, not a later one", async () => {
  assert.equal(
    await errorOf({
      action: "edit",
      path: head,
      revision: "deadbeef",
      operations: [
        { op: "delete", section: "A" },
        { op: "rename", section: "A" },
      ],
    }),
    "operations[1]: op rename requires heading",
  );
});

test("specs/markdown-tool.md#validation: a call is rejected before the file is read", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "a.md"), Buffer.from([0xff, 0xfe, 0x00]));
    const outcome = await call(runtime(), dir, {
      action: "outline",
      path: "a.md",
      revision: "deadbeef",
    });
    assert.equal(outcome.isError, true);
    assert.equal(outcome.text, "revision is not valid for action outline");
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#validation: a valid call of each action passes the checks", async () => {
  const dir = tempDir();
  try {
    const instance = runtime();
    write(dir, "a.md", "pre\n\n# A\n\ntext\n\n## B\n\nmore\n");
    const links = await call(instance, dir, { action: "links", path: "a.md" });
    assert.equal(links.isError, false, links.text);
    const outline = await call(instance, dir, { action: "outline", path: "a.md" });
    assert.equal(outline.isError, false, outline.text);
    const read = await call(instance, dir, { action: "read", path: "a.md", section: "A" });
    assert.equal(read.isError, false, read.text);
    const preamble = await call(instance, dir, {
      action: "edit",
      path: "a.md",
      revision: await revisionOf(instance, dir, "a.md"),
      operations: [{ op: "replace_body", section: "(preamble)", content: "" }],
    });
    assert.equal(preamble.isError, false, preamble.text);
    const move = await call(instance, dir, {
      action: "edit",
      path: "a.md",
      revision: await revisionOf(instance, dir, "a.md"),
      operations: [{ op: "move", section: "A", position: "last", at: "(document)" }],
    });
    assert.equal(move.isError, false, move.text);
  } finally {
    cleanupRoots();
  }
});
