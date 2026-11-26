/**
 * pi-dent-markdown, standalone (specs/markdown-tool.md, the standalone entry): the wiring a host that
 * installs this package as a pi extension loads. The tool's building blocks live in lib/, and
 * the library surface pi-dent-agent consumes is index.ts, which never loads this file.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { makeMarkdownTool, markdownRuntime } from "./index.ts";

export default function piDentMarkdown(pi: ExtensionAPI): void {
  pi.registerTool(makeMarkdownTool(markdownRuntime()));
}
