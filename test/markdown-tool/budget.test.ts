import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesOf, call, cleanupRoots, revisionOf, runtime, tempDir, write } from "./support.ts";
import { revisionOf as revisionOfBytes } from "../../lib/markdown-document.ts";
import { markdownRuntime } from "../../lib/markdown-tool.ts";

/**
 * specs/markdown-tool.md#parsing: the parses run off the host's main thread,
 * the parses of one call are bounded by a total budget and end the call as a
 * tool error when they reach it without writing the file, and a parse running
 * when the tool-call signal aborts stops at once.
 */

/** A file whose parse takes hundreds of milliseconds: many nested lists and block quotes. */
function slowText(items: number): string {
  const lines: string[] = [];
  for (let index = 0; index < items; index += 1) {
    lines.push(`> quote ${index}`, "> more", `- item ${index}`, `  - nested ${index}`, "");
  }
  return ["# Slow", "", ...lines, "## Last", "", "text", ""].join("\n");
}

test("specs/markdown-tool.md#parsing: a call whose parses reach the budget is a tool error and writes nothing", async () => {
  const dir = tempDir();
  try {
    const text = slowText(8000);
    const name = write(dir, "slow.md", text);
    const instance = markdownRuntime({ parseBudgetMs: 100 });
    const revision = revisionOfBytes(new TextEncoder().encode(text));
    const outcome = await call(instance, dir, {
      action: "edit",
      path: name,
      revision,
      operations: [{ op: "rename", section: "Last", heading: "Renamed" }],
    });
    assert.equal(outcome.isError, true);
    assert.equal(
      outcome.text,
      "slow.md could not be parsed within 100 ms; Markdown cannot handle this file",
    );
    assert.deepEqual(outcome.details, {});
    assert.equal(bytesOf(dir, name), text);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#parsing: a read that reaches the budget is a tool error", async () => {
  const dir = tempDir();
  try {
    const name = write(dir, "slow.md", slowText(8000));
    const outcome = await call(markdownRuntime({ parseBudgetMs: 100 }), dir, {
      action: "read",
      path: name,
      section: "Slow",
    });
    assert.equal(outcome.isError, true);
    assert.equal(
      outcome.text,
      "slow.md could not be parsed within 100 ms; Markdown cannot handle this file",
    );
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#parsing: the parse runs off the main thread, so the event loop turns during it", async () => {
  const dir = tempDir();
  try {
    const name = write(dir, "slow.md", slowText(8000));
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    const started = performance.now();
    const outcome = await call(runtime(), dir, { action: "outline", path: name });
    const elapsed = performance.now() - started;
    clearInterval(timer);
    assert.equal(outcome.isError, false);
    assert.ok(elapsed > 200, `the parse should take a while, took ${elapsed} ms`);
    assert.ok(ticks >= 10, `the main thread should tick during the parse, ticked ${ticks}`);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#parsing: a parse running when the signal aborts stops within 100 ms and the call is aborted", async () => {
  const dir = tempDir();
  try {
    const name = write(dir, "slow.md", slowText(8000));
    const controller = new AbortController();
    const pending = markdownRuntime().execute({
      params: { action: "outline", path: name },
      cwd: dir,
      signal: controller.signal,
    });
    // Abort once the worker is parsing: its start takes a few ms, the parse several hundred.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const aborted = performance.now();
    controller.abort();
    const result = await pending;
    const stopped = performance.now() - aborted;
    assert.equal(result.isError, true);
    assert.equal(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      "Markdown aborted",
    );
    assert.ok(stopped < 100, `the call ended after ${stopped} ms`);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#parsing: an edit aborted during its parse writes nothing", async () => {
  const dir = tempDir();
  try {
    const text = slowText(8000);
    const name = write(dir, "slow.md", text);
    const instance = runtime();
    const revision = await revisionOf(instance, dir, name);
    const controller = new AbortController();
    const pending = instance.execute({
      params: {
        action: "edit",
        path: name,
        revision,
        operations: [{ op: "rename", section: "Last", heading: "Renamed" }],
      },
      cwd: dir,
      signal: controller.signal,
    });
    // Abort once the worker is parsing: its start takes a few ms, the parse several hundred.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(bytesOf(dir, name), text);
  } finally {
    cleanupRoots();
  }
});
