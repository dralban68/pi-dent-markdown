import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piDentMarkdown from "../../extension.ts";
import { MARKDOWN_DESCRIPTION } from "../../lib/markdown-tool.ts";
import { must } from "../support/must.ts";

/**
 * specs/markdown-tool.md Section 1.5: the standalone entry registers exactly one tool, the
 * `Markdown` of Section 1 — name, label, the Section 1.4 description, the schema, and the
 * argument preparation — through the host `registerTool` API. The registered call's behaviour
 * is the library's and is owned by the other suites.
 */

interface RegisteredTool {
  name: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  parameters?: unknown;
  prepareArguments?: (args: unknown) => unknown;
}

test("Section 1.5: the entry registers exactly one Markdown tool, as Section 1's table has it", () => {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool: (tool: RegisteredTool) => tools.push(tool),
  } as unknown as ExtensionAPI;
  piDentMarkdown(pi);
  assert.equal(tools.length, 1);
  const tool = must(tools[0]);
  assert.equal(tool.name, "Markdown");
  assert.equal(tool.label, "Markdown");
  assert.equal(tool.description, MARKDOWN_DESCRIPTION);
  assert.equal(tool.promptSnippet !== undefined, true);
  assert.notEqual(tool.parameters, undefined);
  assert.equal(typeof tool.prepareArguments, "function");
});
