import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeDocument, splitLines } from "../lib/markdown-document.ts";

/**
 * specs/markdown-tool.md#parsing: a 128 KiB parse takes less than 5000 ms.
 * Guards the micromark pin in pnpm-workspace.yaml (docs/markdown.md): 4.0.3
 * parses these 128 KB inputs in 17-34 s, 4.0.2 in about 0.4 s.
 */

const INPUTS: Record<string, string> = {
  "block quotes": "> a\n\n".repeat(26216),
  "setext headings": "a\n=\n".repeat(32768),
  "nested lists": "- a\n - b\n".repeat(14564),
};

for (const [name, text] of Object.entries(INPUTS)) {
  test(`parses 128 KB of ${name} in linear time`, () => {
    const start = performance.now();
    analyzeDocument(splitLines(text));
    const ms = performance.now() - start;
    assert.ok(ms < 5000, `${name}: ${Math.round(ms)} ms`);
  });
}
