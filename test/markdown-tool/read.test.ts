import assert from "node:assert/strict";
import { test } from "node:test";
import { call, cleanupRoots, runtime, tempDir, write } from "./support.ts";
import { must } from "../support/must.ts";

/**
 * specs/markdown-tool.md Section 4: the read range, the offset check, the
 * display lines with collapsed sections, the shown lines with their bounds, the
 * end and cut markers, and the `details` shape.
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

async function read(
  text: string,
  params: Record<string, unknown>,
): Promise<{ lines: string[]; details: Record<string, unknown>; text: string; isError: boolean }> {
  const dir = tempDir();
  try {
    const name = write(dir, "a.md", text);
    const outcome = await call(runtime(), dir, { action: "read", path: name, ...params });
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

test("Section 4: a whole section, its header, and the end marker", async () => {
  const outcome = await read(DOCUMENT, { section: "One A" });
  const revision = must(outcome.details.revision);
  assert.deepEqual(outcome.lines, [
    `a.md · Doc > One > One A · lines 9-11 · revision ${revision}`,
    "### One A",
    "",
    "text a",
    "--- end of section ---",
  ]);
  assert.deepEqual(outcome.details, {
    action: "read",
    path: must(outcome.details.path),
    revision,
    address: "Doc > One > One A",
    level: 3,
    start: 9,
    end: 11,
    from: 9,
    to: 11,
  });
});

test("Section 4: the preamble is readable and has no level", async () => {
  const text = ["intro", "", "# A", "", "text", ""].join("\n");
  const outcome = await read(text, { section: "(preamble)" });
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.lines.slice(1), ["intro", "--- end of section ---"]);
  assert.equal(outcome.details.level, null);
  assert.equal(outcome.details.address, "(preamble)");
  assert.equal(outcome.details.start, 1);
  assert.equal(outcome.details.end, 1);

  const none = await read("# A\n", { section: "(preamble)" });
  assert.equal(none.isError, true);
  assert.equal(none.text, "a.md has no preamble");
});

test("Section 4: an offset outside the range is rejected", async () => {
  const outside = await read(DOCUMENT, { section: "One A", offset: 12 });
  assert.equal(outside.isError, true);
  assert.equal(outside.text, "offset 12 is outside Doc > One > One A (lines 9-11)");
  const below = await read(DOCUMENT, { section: "One A", offset: 8 });
  assert.equal(below.text, "offset 8 is outside Doc > One > One A (lines 9-11)");
});

test("Section 4: depth collapses deeper sections to their heading line and a marker", async () => {
  const outcome = await read(DOCUMENT, { section: "Doc", depth: 2 });
  assert.deepEqual(outcome.lines.slice(1), [
    "# Doc",
    "",
    "intro",
    "",
    "## One",
    "",
    "body one",
    "",
    "### One A",
    "[… 2 lines hidden: 10-11]",
    "",
    "### One B",
    "[… 2 lines hidden: 14-15]",
    "",
    "## Two",
    "",
    "body two",
    "--- end of section ---",
  ]);
  assert.equal(outcome.details.to, 19);
});

test("Section 4: a collapsed setext section shows all its heading's lines before the marker", async () => {
  const text = ["# Doc", "", "Deep", "Setext", "------", "", "body one", "", "more", ""].join("\n");
  const outcome = await read(text, { section: "Doc", depth: 1 });
  assert.deepEqual(outcome.lines.slice(1), [
    "# Doc",
    "",
    "Deep",
    "Setext",
    "------",
    "[… 4 lines hidden: 6-9]",
    "--- end of section ---",
  ]);
  assert.equal(outcome.details.to, 9);
});

test("Section 4: a collapsed heading with nothing under it gets no marker line", async () => {
  const text = ["# Doc", "", "## Empty", "", "Lone", "----", "", "## Last", "", "body", ""].join(
    "\n",
  );
  const outcome = await read(text, { section: "Doc", depth: 1 });
  assert.deepEqual(outcome.lines.slice(1), [
    "# Doc",
    "",
    "## Empty",
    "",
    "Lone",
    "----",
    "",
    "## Last",
    "[… 2 lines hidden: 9-10]",
    "--- end of section ---",
  ]);
});

test("Section 4: a collapsed section deeper than another collapsed one is not shown at all", async () => {
  const text = ["# Doc", "", "## One", "", "### One A", "", "#### Deep", "", "text", ""].join("\n");
  const outcome = await read(text, { section: "Doc", depth: 2 });
  assert.deepEqual(outcome.lines.slice(1), [
    "# Doc",
    "",
    "## One",
    "",
    "### One A",
    "[… 4 lines hidden: 6-9]",
    "--- end of section ---",
  ]);
});

test("Section 4: limit pages the display lines and the cut marker names the next offset", async () => {
  const first = await read(DOCUMENT, { section: "Doc", depth: 2, limit: 5 });
  assert.deepEqual(first.lines.slice(1), [
    "# Doc",
    "",
    "intro",
    "",
    "## One",
    "--- cut: continue with offset 6 ---",
  ]);
  assert.equal(first.details.next, 6);
  assert.equal(first.details.from, 1);
  assert.equal(first.details.to, 5);

  const second = await read(DOCUMENT, { section: "Doc", depth: 2, limit: 3, offset: 6 });
  assert.deepEqual(second.lines.slice(1), [
    "",
    "body one",
    "",
    "--- cut: continue with offset 9 ---",
  ]);
  assert.equal(second.details.next, 9);

  const marker = await read(DOCUMENT, { section: "Doc", depth: 2, limit: 1, offset: 10 });
  assert.deepEqual(marker.lines.slice(1), [
    "[… 2 lines hidden: 10-11]",
    "--- cut: continue with offset 12 ---",
  ]);
  assert.equal(marker.details.from, 10);
  assert.equal(marker.details.to, 11);
});

test("Section 4: the last display line's read has no cut marker and no next", async () => {
  const outcome = await read(DOCUMENT, { section: "Doc", depth: 2, limit: 100, offset: 17 });
  assert.deepEqual(outcome.lines.slice(1), ["## Two", "", "body two", "--- end of section ---"]);
  assert.equal("next" in outcome.details, false);
  assert.equal(outcome.details.from, 17);
  assert.equal(outcome.details.to, 19);
});

test("Section 4: the shown lines stay within 50000 characters, and a longer first line is cut", async () => {
  const line = "z".repeat(20000);
  const text = ["# Doc", "", line, line, line, ""].join("\n");
  const outcome = await read(text, { section: "Doc" });
  assert.equal(outcome.lines.length, 6);
  assert.equal(must(outcome.lines[1]), "# Doc");
  assert.equal(must(outcome.lines[3]).length, 20000);
  assert.equal(must(outcome.lines[4]).length, 20000);
  assert.equal(must(outcome.lines[5]), "--- cut: continue with offset 5 ---");
  assert.equal(outcome.details.to, 4);
  assert.equal(outcome.details.next, 5);

  const long = "q".repeat(60000);
  const cut = await read(["# Doc", "", long, ""].join("\n"), { section: "Doc", offset: 3 });
  assert.equal(must(cut.lines[1]).length, 50001);
  assert.equal(must(cut.lines[1]).endsWith("\u2026"), true);
});

test("Section 4: an unknown or ambiguous address is a tool error", async () => {
  const unknown = await read(DOCUMENT, { section: "Nope" });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.text, 'no section "Nope" in a.md. Run outline to list its sections.');
  const similar = await read(DOCUMENT, { section: "One Z" });
  assert.equal(similar.text, 'no section "One Z" in a.md. Run outline to list its sections.');
  const text = ["# A", "", "## X", "", "# B", "", "## X", ""].join("\n");
  const ambiguous = await read(text, { section: "X" });
  assert.equal(
    ambiguous.text,
    'section "X" matches 2 sections in a.md: A > X; B > X. Put more of its path before it, joined by " > ".',
  );
  const withSuggestion = await read(DOCUMENT, { section: "One" });
  assert.equal(withSuggestion.isError, false);
  const suggestion = await read(DOCUMENT, { section: "B" });
  assert.equal(suggestion.isError, true);
  assert.equal(suggestion.text, 'no section "B" in a.md. Similar: Doc > One > One B');
});
