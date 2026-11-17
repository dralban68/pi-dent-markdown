import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownRuntime, type MarkdownRuntime, type ToolResult } from "../../lib/markdown-tool.ts";

/**
 * Fixtures for specs/markdown-tool.md: a throwaway directory per test, a
 * Markdown file written into it, and a call wrapper that reports the result
 * text, its lines, its details, and whether it is a tool error. No test touches
 * a repository file.
 */

const roots: string[] = [];

/** Remove every temporary directory a test made. */
export function cleanupRoots(): void {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
}

/** A temporary directory, removed by `cleanupRoots`. */
export function tempDir(prefix = "markdown-tool-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

/** A runtime over the real file system and the host's file mutation queue. */
export function runtime(): MarkdownRuntime {
  return markdownRuntime();
}

/** What one call returned. */
export interface CallOutcome {
  text: string;
  lines: string[];
  details: Record<string, unknown>;
  isError: boolean;
}

/** One call of the tool against `cwd`, reported as text, lines, details, and error state. */
export async function call(
  instance: MarkdownRuntime,
  cwd: string,
  params: Record<string, unknown>,
): Promise<CallOutcome> {
  const result: ToolResult = await instance.execute({ params, cwd, signal: undefined });
  const first = result.content[0];
  const text = first !== undefined && first.type === "text" ? first.text : "";
  return {
    text,
    lines: text === "" ? [] : text.split("\n"),
    details: result.details,
    isError: result.isError === true,
  };
}

/** Write a Markdown file of a directory and return its name. */
export function write(dir: string, name: string, text: string): string {
  writeFileSync(join(dir, name), text);
  return name;
}

/** A string field of a result's details, failing the test when it is not a string. */
export function stringField(details: Record<string, unknown>, name: string): string {
  const value = details[name];
  if (typeof value !== "string") throw new Error(`details.${name} is not a string`);
  return value;
}

/** The revision an outline of a file shows (Section 2.1). */
export async function revisionOf(
  instance: MarkdownRuntime,
  cwd: string,
  path: string,
): Promise<string> {
  const outcome = await call(instance, cwd, { action: "outline", path });
  const revision = outcome.details.revision;
  if (typeof revision !== "string") throw new Error(`no revision in ${outcome.text}`);
  return revision;
}

/** A repository file's text. */
export function repoFile(relative: string): string {
  return readFileSync(join(process.cwd(), relative), "utf8");
}

/** The bytes of a file in a directory. */
export function bytesOf(dir: string, name: string): string {
  return readFileSync(join(dir, name), "utf8");
}
