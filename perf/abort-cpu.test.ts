import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { markdownRuntime } from "../lib/markdown-tool.ts";

/**
 * specs/markdown-tool.md specs/markdown-tool.md#parsing: an aborted parse stops, so its worker spends no CPU time
 * afterwards. The parse would last about a second; measured after the abort,
 * the process uses a few ms of CPU time in 200 ms.
 */

function slowText(items: number): string {
  const lines: string[] = [];
  for (let index = 0; index < items; index += 1) {
    lines.push(`> quote ${index}`, "> more", `- item ${index}`, `  - nested ${index}`, "");
  }
  return ["# Slow", "", ...lines, "## Last", "", "text", ""].join("\n");
}

test("an aborted parse leaves no CPU use behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "markdown-perf-"));
  try {
    writeFileSync(join(dir, "slow.md"), slowText(20000));
    const controller = new AbortController();
    const pending = markdownRuntime().execute({
      params: { action: "outline", path: "slow.md" },
      cwd: dir,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const result = await pending;
    assert.equal(result.isError, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = process.cpuUsage();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const used = process.cpuUsage(before);
    const usedMs = (used.user + used.system) / 1000;
    assert.ok(usedMs < 50, `the process used ${usedMs} ms of CPU time after the abort`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
