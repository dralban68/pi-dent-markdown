import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { MarkdownRuntime } from "../../lib/markdown-tool.ts";
import {
  bytesOf,
  call,
  cleanupRoots,
  revisionOf,
  runtime,
  tempDir,
  write,
  type CallOutcome,
} from "./support.ts";
import { must } from "../support/must.ts";

/**
 * specs/markdown-tool.md on copies of three Markdown files of this repository:
 * the outline's entries and their line spans, the read of every section, and a
 * structural edit that renumbers without touching anything else. The repository
 * files are never edited: each test copies its file into a throwaway directory
 * and checks the original's bytes afterwards.
 */

const FILES = ["specs/markdown-tool.md", "docs/markdown.md", "AGENTS.md"];
const SPEC = "specs/markdown-tool.md";

/** The bytes of a repository file. */
function repoBytes(relative: string): Buffer {
  return readFileSync(join(process.cwd(), relative));
}

/** The lines of a text (specs/markdown-tool.md#file-access): line endings end lines, and a final one starts none. */
function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The last component of a full address (specs/markdown-tool.md#section-addresses). */
function componentOf(address: string): string {
  return must(address.split(" > ").at(-1));
}

/** One entry of an outline (specs/markdown-tool.md#action-outline). */
interface Entry {
  address: string;
  level: number;
  start: number;
  end: number;
  hidden: number;
}

function fieldOf(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || !(name in value)) {
    throw new Error(`entry has no ${name}`);
  }
  return Reflect.get(value, name);
}

function entriesOf(details: Record<string, unknown>): Entry[] {
  const entries = details.entries;
  if (!Array.isArray(entries)) throw new Error("details.entries is not an array");
  return entries.map((value: unknown) => {
    const address = fieldOf(value, "address");
    const level = fieldOf(value, "level");
    const start = fieldOf(value, "start");
    const end = fieldOf(value, "end");
    const hidden = fieldOf(value, "hidden");
    if (
      typeof address !== "string" ||
      typeof level !== "number" ||
      typeof start !== "number" ||
      typeof end !== "number" ||
      typeof hidden !== "number"
    ) {
      throw new Error("malformed outline entry");
    }
    return { address, level, start, end, hidden };
  });
}

/** The outline of a file at a depth, with its entries parsed from the details. */
async function outline(
  instance: MarkdownRuntime,
  dir: string,
  name: string,
  depth: number,
): Promise<{ outcome: CallOutcome; entries: Entry[] }> {
  const outcome = await call(instance, dir, { action: "outline", path: name, depth, limit: 500 });
  assert.equal(outcome.isError, false, outcome.text);
  return { outcome, entries: entriesOf(outcome.details) };
}

/** The entries under an entry, whatever their level. */
function descendantsOf(entries: Entry[], entry: Entry): Entry[] {
  return entries.filter((other) => other.address.startsWith(`${entry.address} > `));
}

/** Whether a line is a heading line of an entry's marks and text (specs/markdown-tool.md#parsing). */
function isHeadingLine(lines: string[], entry: Entry): boolean {
  const first = lines[entry.start - 1] ?? "";
  const atx = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(first);
  if (atx !== null) {
    const rest = first
      .slice(atx[0].length)
      .trim()
      .replace(/(^|[ \t]+)#+$/, "")
      .trim();
    return atx[1]?.length === entry.level && rest === componentOf(entry.address);
  }
  const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[entry.start] ?? "");
  const setextLevel = underline?.[1]?.startsWith("=") === true ? 1 : 2;
  return (
    underline !== null &&
    setextLevel === entry.level &&
    componentOf(entry.address).startsWith(first.trim())
  );
}

for (const relative of FILES) {
  test(`outline of ${relative} gives each section's span, level, and hidden count`, async () => {
    const original = repoBytes(relative);
    const text = original.toString("utf8");
    const lines = linesOf(text);
    const revision = createHash("sha256").update(original).digest("hex").slice(0, 8);
    const dir = tempDir();
    try {
      const name = write(dir, "copy.md", text);
      const instance = runtime();
      const full = await outline(instance, dir, name, 6);
      const shallow = await outline(instance, dir, name, 2);

      assert.equal(shallow.outcome.details.revision, revision);
      assert.equal(shallow.outcome.details.lines, lines.length);
      assert.equal(shallow.outcome.details.depth, 2);
      assert.equal(shallow.outcome.details.total, shallow.entries.length);
      assert.equal(
        shallow.outcome.lines[0],
        `${name} · ${lines.length} lines · revision ${revision} · depth 2`,
      );

      // Depth 2 lists exactly the entries of depth 6 that are at most level 2, in document order.
      const shallowLevels = full.entries.filter((entry) => entry.level <= 2);
      assert.deepEqual(
        shallow.entries.map((entry) => entry.address),
        shallowLevels.map((entry) => entry.address),
      );
      const starts = shallow.entries.map((entry) => entry.start);
      assert.deepEqual(
        starts,
        starts.toSorted((a, b) => a - b),
      );

      // The entry lines are the entries' spans, marks, components, and hidden counts.
      assert.deepEqual(
        shallow.outcome.lines.slice(1),
        shallow.entries.map(
          (entry) =>
            `${entry.start}-${entry.end} ${"#".repeat(entry.level)} ${componentOf(entry.address)} (${entry.end - entry.start + 1} lines)${
              entry.hidden > 0 ? ` (+${entry.hidden} hidden)` : ""
            }`,
        ),
      );

      for (const entry of shallow.entries) {
        // A hidden count is the descendants below the depth, and nothing is hidden at depth 6.
        const below = descendantsOf(full.entries, entry).filter((other) => other.level > 2);
        assert.equal(entry.hidden, below.length, entry.address);
      }
      for (const entry of full.entries) {
        assert.equal(entry.hidden, 0, entry.address);
        assert.equal(isHeadingLine(lines, entry), true, entry.address);
        assert.ok(entry.start <= entry.end && entry.end <= lines.length, entry.address);

        // A span ends at its last non-blank line before the next heading of its level or less.
        const following = full.entries
          .filter((other) => other.start > entry.start && other.level <= entry.level)
          .map((other) => other.start);
        const boundary = following.length === 0 ? lines.length + 1 : Math.min(...following);
        assert.notEqual(must(lines[entry.end - 1]).trim(), "", entry.address);
        for (let line = entry.end + 1; line < boundary; line += 1) {
          assert.equal(must(lines[line - 1]).trim(), "", `${entry.address} line ${line}`);
        }
      }
    } finally {
      cleanupRoots();
    }
    assert.equal(repoBytes(relative).equals(original), true);
  });

  test(`read of each section of ${relative} shows exactly that section's lines`, async () => {
    const original = repoBytes(relative);
    const text = original.toString("utf8");
    const lines = linesOf(text);
    const dir = tempDir();
    try {
      const name = write(dir, "copy.md", text);
      const instance = runtime();
      const { entries } = await outline(instance, dir, name, 6);
      for (const entry of entries) {
        const shown: string[] = [];
        let offset: number | undefined;
        for (let round = 0; ; round += 1) {
          assert.ok(round < 10000, entry.address);
          const outcome = await call(instance, dir, {
            action: "read",
            path: name,
            section: entry.address,
            ...(offset === undefined ? {} : { offset }),
          });
          assert.equal(outcome.isError, false, `${entry.address}: ${outcome.text}`);
          assert.equal(outcome.details.start, entry.start, entry.address);
          assert.equal(outcome.details.end, entry.end, entry.address);
          assert.equal(outcome.details.level, entry.level, entry.address);
          shown.push(...outcome.lines.slice(1, -1));
          const marker = must(outcome.lines[outcome.lines.length - 1]);
          if (marker === "--- end of section ---") {
            assert.equal(outcome.details.to, entry.end, entry.address);
            break;
          }
          const cut = /^--- cut: continue with offset ([0-9]+) ---$/.exec(marker);
          assert.notEqual(cut, null, `${entry.address}: ${marker}`);
          offset = Number(must(cut?.[1]));
        }
        assert.deepEqual(shown, lines.slice(entry.start - 1, entry.end), entry.address);
      }
    } finally {
      cleanupRoots();
    }
    assert.equal(repoBytes(relative).equals(original), true);
  });
}

test(`edit of ${SPEC} moves its first top-level section last, renumbers the top-level sections, and leaves the other lines as they were`, async () => {
  const original = repoBytes(SPEC);
  const text = original.toString("utf8");
  const lines = linesOf(text);
  const dir = tempDir();
  try {
    const name = write(dir, "copy.md", text);
    const instance = runtime();
    const before = await outline(instance, dir, name, 6);
    const topLevel = before.entries.filter((entry) => entry.level === 2);
    const first = must(topLevel[0]);
    const lastTop = must(topLevel[topLevel.length - 1]);
    const revision = await revisionOf(instance, dir, name);
    const outcome = await call(instance, dir, {
      action: "edit",
      path: name,
      revision,
      operations: [{ op: "move", section: first.address, position: "after", at: lastTop.address }],
    });
    assert.equal(outcome.isError, false, outcome.text);

    const after = await outline(instance, dir, name, 6);
    const top = after.entries.filter((entry) => entry.level === 2);
    assert.equal(top.length, topLevel.length);
    const content = (value: string): string => value.replace(/^[0-9]+\. /, "");
    assert.deepEqual(
      top.map((entry) => content(componentOf(entry.address))),
      [...topLevel.slice(1), first].map((entry) => content(componentOf(entry.address))),
    );
    const numbers = top.map((entry) => {
      const match = /^([0-9]+)\. /.exec(componentOf(entry.address));
      return match === null ? undefined : Number(match[1]);
    });
    assert.deepEqual(
      numbers,
      numbers.map((_value, index) => index + 1),
    );

    // Every leaf section keeps its lines below its heading line, which renumbering rewrites.
    const edited = linesOf(bytesOf(dir, name));
    const editedText = edited.join("\n");
    for (const entry of before.entries) {
      if (descendantsOf(before.entries, entry).length > 0) continue;
      const body = lines.slice(entry.start, entry.end).join("\n");
      if (body.trim() === "") continue;
      assert.equal(editedText.includes(body), true, entry.address);
    }
  } finally {
    cleanupRoots();
  }
  assert.equal(repoBytes(SPEC).equals(original), true);
});
