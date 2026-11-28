import assert from "node:assert/strict";
import { test } from "node:test";
import { call, cleanupRoots, runtime, tempDir, write } from "./support.ts";
import { must } from "../support/must.ts";

/**
 * specs/markdown-tool.md#action-outline: the candidates, the default and given
 * `depth`, the entries with their hidden counts and preview lines, pagination,
 * the "no headings" lines, and the `details` shape.
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
  "text",
  "",
  "### One B",
  "",
  "text",
  "",
  "## Two",
  "",
  "body two",
  "",
].join("\n");

async function outline(
  text: string,
  params: Record<string, unknown>,
): Promise<{ lines: string[]; details: Record<string, unknown>; text: string; isError: boolean }> {
  const dir = tempDir();
  try {
    const name = write(dir, "a.md", text);
    const outcome = await call(runtime(), dir, { action: "outline", path: name, ...params });
    return {
      lines: outcome.lines,
      details: outcome.details,
      text: outcome.text,
      isError: outcome.isError,
    };
  } finally {
    cleanupRoots();
  }
}

test("specs/markdown-tool.md#action-outline: the header, the entries, and the details of a whole-file outline", async () => {
  const outcome = await outline(DOCUMENT, {});
  const revision = must(outcome.details.revision);
  assert.deepEqual(outcome.lines, [
    `a.md · 19 lines · revision ${revision} · depth 3`,
    "1-19 # Doc (19 lines)",
    "5-15 ## One (11 lines)",
    "9-11 ### One A (3 lines)",
    "13-15 ### One B (3 lines)",
    "17-19 ## Two (3 lines)",
  ]);
  const path = must(outcome.details.path);
  assert.equal(typeof path, "string");
  if (typeof path !== "string") return;
  assert.equal(path.endsWith("/a.md"), true);
  assert.deepEqual(outcome.details, {
    action: "outline",
    path,
    revision,
    lines: 19,
    depth: 3,
    total: 5,
    offset: 0,
    more: false,
    entries: [
      { address: "Doc", level: 1, start: 1, end: 19, hidden: 0 },
      { address: "Doc > One", level: 2, start: 5, end: 15, hidden: 0 },
      { address: "Doc > One > One A", level: 3, start: 9, end: 11, hidden: 0 },
      { address: "Doc > One > One B", level: 3, start: 13, end: 15, hidden: 0 },
      { address: "Doc > Two", level: 2, start: 17, end: 19, hidden: 0 },
    ],
  });
});

test("specs/markdown-tool.md#action-outline: the default depth is the deepest level whose entries fit in the greater of limit and 100", async () => {
  // DOCUMENT has five sections, so every level fits in 100 and a small limit still
  // lists the deepest level by paging.
  const small = await outline(DOCUMENT, { limit: 2 });
  assert.equal(must(small.lines[0]).endsWith("depth 3"), true);
  assert.deepEqual(small.lines.slice(1), [
    "1-19 # Doc (19 lines)",
    "5-15 ## One (11 lines)",
    "More entries follow: repeat the call with offset: 2",
  ]);
  assert.equal(small.details.depth, 3);
  assert.equal(small.details.more, true);
});

test("specs/markdown-tool.md#action-outline: a small limit pages through every entry of the default depth", async () => {
  const second = await outline(DOCUMENT, { limit: 2, offset: 2 });
  assert.deepEqual(second.lines.slice(1), [
    "9-11 ### One A (3 lines)",
    "13-15 ### One B (3 lines)",
    "More entries follow: repeat the call with offset: 4",
  ]);
  const last = await outline(DOCUMENT, { limit: 2, offset: 4 });
  assert.deepEqual(last.lines.slice(1), ["17-19 ## Two (3 lines)"]);
  assert.equal(last.details.more, false);
});

test("specs/markdown-tool.md#action-outline: a default depth with more than 100 entries at every level falls back to the shallowest level", async () => {
  const headings = Array.from({ length: 101 }, (_, index) => `# H${index}\n`).join("\n");
  const outcome = await outline(headings, { limit: 1 });
  assert.equal(must(outcome.lines[0]).endsWith("depth 1"), true);
  assert.equal(outcome.details.total, 101);
});

test("specs/markdown-tool.md#action-outline: the default depth counts up to the greater of limit and 100 candidates", async () => {
  // One `#` over 150 `##` sections: depth 2 has 151 candidates, which fits a limit of 200 only.
  const subsections = Array.from({ length: 150 }, (_, index) => `## S${index}`);
  const text = ["# Top", "", ...subsections, ""].join("\n");
  const wide = await outline(text, { limit: 200 });
  assert.equal(wide.isError, false, wide.text);
  assert.equal(must(wide.lines[0]).endsWith("depth 2"), true);
  assert.equal(wide.details.total, 151);
  assert.equal(wide.details.more, false);
  const narrow = await outline(text, {});
  assert.equal(must(narrow.lines[0]).endsWith("depth 1"), true);
  assert.deepEqual(narrow.lines.slice(1), ["1-152 # Top (152 lines) (+150 hidden)"]);
});

test("specs/markdown-tool.md#action-outline: a given depth lists the entries down to it, with hidden counts", async () => {
  const outcome = await outline(DOCUMENT, { depth: 2 });
  assert.deepEqual(outcome.lines.slice(1), [
    "1-19 # Doc (19 lines) (+2 hidden)",
    "5-15 ## One (11 lines) (+2 hidden)",
    "17-19 ## Two (3 lines)",
  ]);
  assert.deepEqual(outcome.details.entries, [
    { address: "Doc", level: 1, start: 1, end: 19, hidden: 2 },
    { address: "Doc > One", level: 2, start: 5, end: 15, hidden: 2 },
    { address: "Doc > Two", level: 2, start: 17, end: 19, hidden: 0 },
  ]);
});

test("specs/markdown-tool.md#action-outline: a section-scoped outline lists it and its descendants, and it whatever its level", async () => {
  const outcome = await outline(DOCUMENT, { section: "One", depth: 1 });
  assert.deepEqual(outcome.lines.slice(1), ["5-15 ## One (11 lines) (+2 hidden)"]);
  assert.equal(outcome.details.total, 1);
  const deep = await outline(DOCUMENT, { section: "Doc > One", depth: 3 });
  assert.deepEqual(deep.lines.slice(1), [
    "5-15 ## One (11 lines)",
    "9-11 ### One A (3 lines)",
    "13-15 ### One B (3 lines)",
  ]);
});

test("specs/markdown-tool.md#action-outline: preview lines join wrapped prose, stop at the first sentence within 160 characters, or cut at 160", async () => {
  const text = [
    "# Doc",
    "",
    "  alpha   beta  ",
    "gamma. Second sentence.",
    "",
    "## Empty",
    "",
    "### Child",
    "",
    "x",
    "",
  ].join("\n");
  const outcome = await outline(text, { preview: true });
  assert.deepEqual(outcome.lines, [
    must(outcome.lines[0]),
    "1-10 # Doc (10 lines)",
    "    alpha beta gamma.",
    "6-10 ## Empty (5 lines)",
    "8-10 ### Child (3 lines)",
    "    x",
  ]);
  const entries = outcome.details.entries;
  assert.equal(Array.isArray(entries), true);
  const list = entries as Record<string, unknown>[];
  assert.equal(list[0]?.preview, "alpha beta gamma.");
  assert.equal("preview" in (list[1] ?? {}), false);
  assert.equal(list[2]?.preview, "x");

  const long = ["# Doc", "", "y".repeat(200), ""].join("\n");
  const cut = await outline(long, { preview: true });
  assert.equal(cut.lines[2], `    ${"y".repeat(160)}\u2026`);

  const nbsp = ["# Doc", "", "\u00a0", ""].join("\n");
  const emptyFlattened = await outline(nbsp, { preview: true });
  assert.deepEqual(emptyFlattened.lines.slice(1), ["1-3 # Doc (3 lines)"]);
  assert.equal(
    "preview" in ((emptyFlattened.details.entries as Record<string, unknown>[])[0] ?? {}),
    false,
  );
});

test("specs/markdown-tool.md#action-outline: pagination reports the next offset, and an offset past the last entry is rejected", async () => {
  const first = await outline(DOCUMENT, { depth: 3, limit: 2 });
  assert.deepEqual(first.lines, [
    must(first.lines[0]),
    "1-19 # Doc (19 lines)",
    "5-15 ## One (11 lines)",
    "More entries follow: repeat the call with offset: 2",
  ]);
  assert.equal(first.details.more, true);
  assert.equal(first.details.offset, 0);
  assert.equal(first.details.total, 5);
  assert.equal(
    first.details.entries && Array.isArray(first.details.entries)
      ? first.details.entries.length
      : -1,
    2,
  );

  const last = await outline(DOCUMENT, { depth: 3, limit: 2, offset: 4 });
  assert.deepEqual(last.lines.slice(1), ["17-19 ## Two (3 lines)"]);
  assert.equal(last.details.more, false);
  assert.equal(last.details.offset, 4);

  const past = await outline(DOCUMENT, { depth: 3, offset: 5 });
  assert.equal(past.isError, true);
  assert.equal(past.text, "offset 5 is past the last entry (5 entries)");
  assert.deepEqual(past.details, {});

  const zero = await outline(DOCUMENT, { depth: 3, offset: 0 });
  assert.equal(zero.isError, false);
});

test("specs/markdown-tool.md#action-outline: (no headings) and the shallowest-level line", async () => {
  const none = await outline("just text\n", {});
  assert.deepEqual(none.lines.slice(1), ["1-1 (preamble)", "(no headings)"]);
  assert.equal(none.details.total, 0);
  assert.equal(none.details.depth, 6);

  const shallow = await outline("## A\n\ntext\n", { depth: 1 });
  assert.deepEqual(shallow.lines.slice(1), [
    "(no headings down to level 1; the shallowest is level 2)",
  ]);
});

test("specs/markdown-tool.md#action-outline: the frontmatter and preamble lines appear only without section and offset 0", async () => {
  const text = ["---", "x: y", "---", "", "intro", "", "# A", "", "text", ""].join("\n");
  const whole = await outline(text, {});
  assert.deepEqual(whole.lines.slice(1, 4), [
    "1-3 (frontmatter)",
    "5-5 (preamble)",
    "7-9 # A (3 lines)",
  ]);
  assert.deepEqual(whole.details.frontmatter, { start: 1, end: 3 });
  assert.deepEqual(whole.details.preamble, { start: 5, end: 5 });

  const scoped = await outline(text, { section: "A" });
  assert.deepEqual(scoped.lines.slice(1), ["7-9 # A (3 lines)"]);
  assert.equal("frontmatter" in scoped.details, false);
  assert.equal("preamble" in scoped.details, false);

  const longer = [
    "---",
    "x: y",
    "---",
    "",
    "intro",
    "",
    "# A",
    "",
    "text",
    "",
    "## B",
    "",
    "more",
    "",
  ].join("\n");
  const paged = await outline(longer, { depth: 3, offset: 1 });
  assert.equal(paged.lines.includes("1-3 (frontmatter)"), false);
  assert.equal(paged.lines.includes("5-5 (preamble)"), false);
  assert.deepEqual(paged.lines.slice(1), ["11-13 ## B (3 lines)"]);
});

test("specs/markdown-tool.md#action-outline: an unknown section address is a tool error with a suggestion when one is similar", async () => {
  const unknown = await outline(DOCUMENT, { section: "One Z" });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.text, 'no section "One Z" in a.md. Run outline to list its sections.');
  const exact = await outline(DOCUMENT, { section: "One A" });
  assert.equal(exact.isError, false);
  const similar = await outline(DOCUMENT, { section: "B" });
  assert.equal(similar.isError, true);
  assert.equal(similar.text, 'no section "B" in a.md. Similar: Doc > One > One B');
  const ambiguous = await outline(["# A", "", "## X", "", "# B", "", "## X", ""].join("\n"), {
    section: "X",
  });
  assert.equal(ambiguous.isError, true);
  assert.equal(
    ambiguous.text,
    'section "X" matches 2 sections in a.md: A > X; B > X. Put more of its path before it, joined by " > ".',
  );
});

test("specs/markdown-tool.md#action-outline: an empty file has no heading and 0 lines", async () => {
  const outcome = await outline("", {});
  assert.deepEqual(outcome.lines.slice(1), ["(no headings)"]);
  assert.equal(outcome.details.lines, 0);
  assert.equal(outcome.details.depth, 6);
});
