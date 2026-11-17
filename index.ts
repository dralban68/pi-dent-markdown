/**
 * pi-dent-markdown: the `Markdown` tool of specs/markdown-tool.md, a library consumed
 * by pi-dent (`import ... from "pi-dent-markdown"`). It is not a pi extension: the host
 * never loads this package, and pi-dent registers the tool it builds.
 */

export { makeMarkdownTool, markdownRuntime } from "./lib/markdown-tool.ts";
export type { MarkdownRuntime, ToolResult } from "./lib/markdown-tool.ts";
