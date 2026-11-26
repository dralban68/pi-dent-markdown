import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { makeMarkdownTool, markdownRuntime } from "../../lib/markdown-tool.ts";

/**
 * specs/markdown-tool.md#rendering: `renderCall` shows the action, the path, the
 * section, and one line per operation, leaves out values that are not yet
 * strings, never throws, and returns a component with no padding and no
 * background of its own.
 */

const tool = makeMarkdownTool(markdownRuntime());

interface Rendered {
  lines: string[];
}

/** Render a call's component and report the lines it draws at width 80. */
function renderCall(args: unknown): Rendered {
  const slot = tool.renderCall;
  assert.equal(typeof slot, "function");
  const component =
    slot === undefined
      ? undefined
      : slot(
          args,
          {} as never,
          {
            lastComponent: undefined,
          } as never,
        );
  assert.equal(component instanceof Text, true);
  return { lines: (component as Text).render(80).map((line) => line.trimEnd()) };
}

test("specs/markdown-tool.md#rendering: a call line shows the action and the path, and the section after ›", () => {
  assert.deepEqual(renderCall({ action: "outline", path: "a.md" }).lines, [
    "Markdown outline a.md",
  ]);
  assert.deepEqual(renderCall({ action: "read", path: "a.md", section: "3. Two" }).lines, [
    "Markdown read a.md › 3. Two",
  ]);
});

test("specs/markdown-tool.md#rendering: an edit call adds one line per operation with its string values", () => {
  const lines = renderCall({
    action: "edit",
    path: "a.md",
    operations: [
      { op: "move", section: "A", position: "after", at: "B" },
      { op: "rename", section: "A", heading: "C" },
      { op: "insert", position: "last", at: "(document)", content: "## X" },
    ],
  }).lines;
  assert.deepEqual(lines, [
    "Markdown edit a.md",
    "  move A after B",
    "  rename A",
    "  insert last (document)",
  ]);
});

test("specs/markdown-tool.md#rendering: values that are not yet strings are left out and renderCall does not throw", () => {
  assert.deepEqual(renderCall({}).lines, ["Markdown"]);
  assert.deepEqual(renderCall({ action: "outline" }).lines, ["Markdown outline"]);
  assert.deepEqual(
    renderCall({ action: "edit", path: "a.md", operations: [null, {}, { op: "delete" }] }).lines,
    ["Markdown edit a.md", "", "", "  delete"],
  );
  assert.deepEqual(renderCall({ action: null, path: 7, section: false }).lines, ["Markdown"]);
  assert.deepEqual(renderCall(undefined).lines, ["Markdown"]);
  assert.deepEqual(renderCall("streaming").lines, ["Markdown"]);
  assert.deepEqual(renderCall({ operations: "not an array" }).lines, ["Markdown"]);
});

test("specs/markdown-tool.md#rendering: the component carries no padding and no background of its own", () => {
  const slot = tool.renderCall;
  assert.notEqual(slot, undefined);
  const component =
    slot === undefined
      ? undefined
      : slot(
          { action: "outline", path: "a.md" },
          {} as never,
          { lastComponent: undefined } as never,
        );
  assert.equal(component instanceof Text, true);
  const drawn = (component as Text).render(80).map((line) => line.trimEnd());
  assert.deepEqual(drawn, ["Markdown outline a.md"]);
  for (const line of drawn) {
    assert.equal(line.includes("\u001b["), false);
    assert.equal(line.startsWith(" "), false);
  }
});

test("specs/markdown-tool.md#rendering: the component is reused across renders of the same row", () => {
  const slot = tool.renderCall;
  assert.notEqual(slot, undefined);
  if (slot === undefined) return;
  const first = slot(
    { action: "outline", path: "a.md" },
    {} as never,
    {
      lastComponent: undefined,
    } as never,
  );
  const second = slot(
    { action: "read", path: "b.md", section: "X" },
    {} as never,
    {
      lastComponent: first,
    } as never,
  );
  assert.equal(first, second);
  assert.deepEqual(
    (second as Text).render(80).map((line) => line.trimEnd()),
    ["Markdown read b.md › X"],
  );
});
