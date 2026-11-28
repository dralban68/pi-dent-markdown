/**
 * The `Markdown` tool (specs/markdown-tool.md): the registration surface
 * (specs/markdown-tool.md#registration), the file access (specs/markdown-tool.md#file-access), and the call's ends (specs/markdown-tool.md#action-outline
 * to 6 and 7). The checks, the results, and the structural edits are the pure
 * modules `lib/markdown-run.ts` and `lib/markdown-edit.ts`; the parses run on a
 * worker thread (`lib/markdown-worker.ts`, specs/markdown-tool.md#parsing), created per call.
 *
 * Everything host-specific — the working directory, the file system, and the
 * host's file mutation queue — is a parameter, so every rule is testable
 * without the host.
 */

import { constants, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { errorCode, errorMessage, isPlainObject } from "./util.ts";
import { typeStrippingOptions } from "./worker-options.ts";
import {
  MARKDOWN_MAX_BYTES,
  PARSE_BUDGET_MS,
  decodeMarkdown,
  revisionOf,
} from "./markdown-document.ts";
import {
  MARKDOWN_ACTIONS,
  MARKDOWN_OPERATIONS,
  MARKDOWN_POSITIONS,
  MARKDOWN_TOOL_NAME,
  failure,
  type MarkdownJob,
  type MarkdownReply,
} from "./markdown-run.ts";

export {
  MARKDOWN_ACTIONS,
  MARKDOWN_OPERATIONS,
  MARKDOWN_POSITIONS,
  MARKDOWN_TOOL_NAME,
  checkMarkdownCall,
} from "./markdown-run.ts";

/** The result a tool's `execute` returns: text content and details. */
export type ToolResult = AgentToolResult<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#model-facing-texts: model-facing texts, verbatim
// ---------------------------------------------------------------------------

/** The tool's `description` (specs/markdown-tool.md#model-facing-texts). */
export const MARKDOWN_DESCRIPTION =
  'Outline, read, and restructure a Markdown file by its headings; use it instead of the `read` tool for Markdown files. For a long file, outline first and read only the sections you need. Its outline action lists the sections with their line ranges; read returns one or more sections; links lists the links, images, autolinks, and link definitions of the file or a section with their lines and destinations, plus unused definitions and references to missing ones, for you to check, and checks no target itself; edit replaces, inserts, deletes, moves, renames, or re-levels whole sections without quoting their old text, fits each placed section to the level of its new place, and applies its operations in order, all or none. Name a section by its heading text, its number ("3.1", "§3.1"), or a line copied from an outline or edit result; when that is not unique, put ancestor headings before it, joined by " > ". Numbered headings ("3.", "3.1") are renumbered to stay in sequence, and a section placed among them without a number gets one; a later operation of the same call names a renumbered section by its text without the number. To change words inside a section, use the `edit` tool.';

/** The tool's `promptSnippet` (specs/markdown-tool.md#model-facing-texts). */
export const MARKDOWN_PROMPT_SNIPPET =
  "Outline, read, and edit Markdown files section by section: the default for reading and restructuring Markdown";

/** The `description` of each parameter, verbatim from specs/markdown-tool.md#model-facing-texts. */
export const MARKDOWN_PARAMETER_DESCRIPTIONS = {
  action:
    "outline: list the sections with their line ranges. read: return one or more sections' text. edit: apply structural operations. links: list the links and their destinations.",
  path: "Path to the Markdown file (relative or absolute).",
  section:
    "outline and links: only this section and its subsections. read: the section to return (required unless sections is given); (preamble) names the text before the first heading, for read and links.",
  sections:
    "For read: multiple sections to return in one call, sharing the line and character budget; exclusive with section and offset. To continue a cut section, call read with section and that section's offset.",
  depth:
    "A heading level, 1 to 6. outline: the deepest level listed (1: # only, 2: # and ##, and so on); default: the deepest that fits in limit or 100 entries, whichever is greater. read: subsections deeper than this level are shown as their heading only.",
  preview: "For outline: true also shows a short preview of each section's body. Default false.",
  offset:
    'outline and links: how many entries or items to skip; copy it from the "More entries follow" or "More items follow" line. read: the file line to start at (not valid with sections); copy it from the "cut: continue with offset" line.',
  limit:
    "outline and links: the most entries or items to list, 1 to 500, default 100. read: the most lines to return, 1 to 2000, default 500 (shared across sections).",
  revision:
    "Required for edit: the revision shown by your latest outline, read, or edit of this file.",
  operations:
    "Required for edit: 1 to 50 operations, each applied to the result of the ones before it.",
  op: "replace: the whole section, with content. replace_body: the text under the heading, before its subsections, with content (empty removes it). insert: content at position relative to at. delete: the section with its subsections. move: the section to position relative to at. rename: set its heading text. set_level: set its heading level; its subsections shift with it, and it is refused when other sections would change parent.",
  opSection: "The section acted on; (preamble) only for replace_body.",
  position:
    "For insert and move: before or after the at section, or as its first or last subsection.",
  at: "For insert and move: the section to place relative to; (document) with first places before the first heading, with last at the end of the file, levels unchanged.",
  content:
    "For replace and insert: Markdown starting with its heading line, one section with any subsections; its heading levels are fitted to the destination, and its numbers are corrected where the destination's are in sequence. For replace_body: Markdown without headings.",
  heading:
    "For rename: the new heading text, one line, without the # marks. A number prefix such as 3.1 is kept unless you write one.",
  level: "For set_level: the new level, 1 to 6.",
} as const;

const DESCRIPTIONS = MARKDOWN_PARAMETER_DESCRIPTIONS;

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#parameters: parameter schema
// ---------------------------------------------------------------------------

/**
 * The schema of one operation. Its properties carry the descriptions of
 * specs/markdown-tool.md#model-facing-texts; the element schema and the alternatives inside a property carry
 * none.
 */
export const markdownOperationSchema = Type.Object(
  {
    op: StringEnum(MARKDOWN_OPERATIONS, { description: DESCRIPTIONS.op }),
    section: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { description: DESCRIPTIONS.opSection }),
    ),
    position: Type.Optional(
      Type.Union([StringEnum(MARKDOWN_POSITIONS), Type.Null()], {
        description: DESCRIPTIONS.position,
      }),
    ),
    at: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: DESCRIPTIONS.at })),
    content: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { description: DESCRIPTIONS.content }),
    ),
    heading: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { description: DESCRIPTIONS.heading }),
    ),
    level: Type.Optional(
      Type.Union([Type.Number(), Type.Null()], { description: DESCRIPTIONS.level }),
    ),
  },
  { additionalProperties: false },
);

/**
 * The parameter schema of specs/markdown-tool.md#parameters: an object with `action` and `path`
 * required, every other field optional and admitting `null`, and no property
 * beyond the table's.
 */
export const markdownParameterSchema: TSchema = Type.Object(
  {
    action: StringEnum(MARKDOWN_ACTIONS, { description: DESCRIPTIONS.action }),
    path: Type.String({ description: DESCRIPTIONS.path }),
    section: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { description: DESCRIPTIONS.section }),
    ),
    sections: Type.Optional(
      Type.Union([Type.Array(Type.String(), { minItems: 1 }), Type.Null()], {
        description: DESCRIPTIONS.sections,
      }),
    ),
    depth: Type.Optional(
      Type.Union([Type.Number(), Type.Null()], { description: DESCRIPTIONS.depth }),
    ),
    preview: Type.Optional(
      Type.Union([Type.Boolean(), Type.Null()], { description: DESCRIPTIONS.preview }),
    ),
    offset: Type.Optional(
      Type.Union([Type.Number(), Type.Null()], { description: DESCRIPTIONS.offset }),
    ),
    limit: Type.Optional(
      Type.Union([Type.Number(), Type.Null()], { description: DESCRIPTIONS.limit }),
    ),
    revision: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { description: DESCRIPTIONS.revision }),
    ),
    operations: Type.Optional(
      Type.Union(
        [Type.Array(markdownOperationSchema, { minItems: 1, maxItems: 50 }), Type.Null()],
        { description: DESCRIPTIONS.operations },
      ),
    ),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#argument-preparation: argument preparation
// ---------------------------------------------------------------------------

/**
 * Prepare a call's arguments before the host validates them (specs/markdown-tool.md#argument-preparation):
 * `operations` sent as a JSON string or as a lone object becomes the array it
 * stands for; every other argument is left as it is.
 */
export function prepareMarkdownArguments(args: unknown): unknown {
  if (!isPlainObject(args)) return args;
  const operations = args.operations;
  if (typeof operations === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(operations);
    } catch {
      return args;
    }
    if (Array.isArray(parsed)) return { ...args, operations: parsed };
    if (isPlainObject(parsed)) return { ...args, operations: [parsed] };
    return args;
  }
  if (isPlainObject(operations)) return { ...args, operations: [operations] };
  return args;
}

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#file-access: file access
// ---------------------------------------------------------------------------

/** The absolute path a call's `path` names (specs/markdown-tool.md#file-access). */
export function resolveMarkdownPath(display: string, cwd: string, home: string): string {
  let text = display.trim();
  if (text.startsWith("@")) text = text.slice(1);
  if (text === "~") text = home;
  else if (text.startsWith("~/")) text = join(home, text.slice(2));
  return resolve(cwd, text);
}

/** A file as the call read it (specs/markdown-tool.md#file-access). */
export interface LoadedFile {
  bytes: Uint8Array;
  text: string;
  hadBom: boolean;
  revision: string;
}

/** The error text of a file the call cannot use (specs/markdown-tool.md#file-access). */
export interface LoadFailure {
  error: string;
}

/** How the tool reaches the file system and the host's file mutation queue. */
export interface MarkdownRuntimeOptions {
  /** The user's home directory, for a `~` path. Default `homedir()`. */
  home?: string;
  /** Read a file's bytes; throws when it cannot. Default `readFileSync`. */
  readFile?: (path: string) => Uint8Array | Promise<Uint8Array>;
  /** Write a file's bytes. Default `writeFileSync`. */
  writeFile?: (path: string, bytes: Uint8Array) => void;
  /** The host's per-file serialization. Default the host's `withFileMutationQueue`. */
  mutationQueue?: <T>(path: string, body: () => Promise<T>) => Promise<T>;
  /** The parse time one call may spend, in milliseconds (specs/markdown-tool.md#parsing). Default 10000. */
  parseBudgetMs?: number;
}

/** One call of the tool. */
export interface MarkdownInvocation {
  params: unknown;
  /** The working directory of the invoking session (specs/markdown-tool.md#file-access). */
  cwd: string;
  signal: AbortSignal | undefined;
}

/** The tool of one extension instance. */
export interface MarkdownRuntime {
  execute(invocation: MarkdownInvocation): Promise<ToolResult>;
}

/** How a worker's job ended: its reply, or why it ended without one (specs/markdown-tool.md#parsing). */
type JobEnd =
  | { kind: "reply"; reply: MarkdownReply }
  | { kind: "budget" }
  | { kind: "aborted" }
  | { kind: "failed"; message: string };

/** A reply the worker posted, checked as a reply (specs/markdown-tool.md#parsing). */
function replyOf(value: unknown): MarkdownReply | undefined {
  if (!isPlainObject(value)) return;
  const { text, details, isError, bytes } = value;
  if (typeof text !== "string" || !isPlainObject(details) || typeof isError !== "boolean") return;
  return {
    text,
    details,
    isError,
    ...(bytes instanceof Uint8Array ? { bytes } : {}),
  };
}

/**
 * The worker thread of one call (specs/markdown-tool.md#parsing): the parses run there, off the
 * host's main thread, and the call's parse time is kept across its jobs. A job
 * ends by its reply, by the parse budget, by the call's abort, or by a failure;
 * the last three end the thread too, which is how a parse stops.
 */
class CallWorker {
  private readonly limitMs: number;
  private spentMs = 0;
  private worker: Worker | undefined;
  private pending: ((end: JobEnd) => void) | undefined;

  constructor(limitMs: number) {
    this.limitMs = limitMs;
  }

  /** Run one job; the job's time is charged to the call, which the budget then bounds. */
  run(job: MarkdownJob, signal: AbortSignal | undefined): Promise<JobEnd> {
    if (signal?.aborted === true) return Promise.resolve({ kind: "aborted" });
    const remaining = Math.max(0, this.limitMs - this.spentMs);
    const worker = this.start();
    return new Promise<JobEnd>((done) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = performance.now();
      const onAbort = (): void => settle({ kind: "aborted" });
      const settle = (end: JobEnd): void => {
        if (this.pending !== settle) return;
        this.pending = undefined;
        this.spentMs += performance.now() - started;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (end.kind !== "reply") this.stop();
        done(end);
      };
      this.pending = settle;
      timer = setTimeout(() => settle({ kind: "budget" }), remaining);
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.postMessage({ job, spentMs: this.spentMs, limitMs: this.limitMs });
    });
  }

  /** The text a job's end gives the call (#validation, #parsing). */
  reply(end: JobEnd, display: string): MarkdownReply {
    if (end.kind === "reply") return end.reply;
    if (end.kind === "aborted") return failure("Markdown aborted");
    if (end.kind === "budget") {
      return failure(
        `${display} could not be parsed within ${this.limitMs} ms; Markdown cannot handle this file`,
      );
    }
    return failure(end.message);
  }

  /** End the call's thread. */
  close(): void {
    this.stop();
  }

  private start(): Worker {
    if (this.worker !== undefined) return this.worker;
    const workerUrl = new URL("./markdown-worker.ts", import.meta.url);
    const worker = new Worker(workerUrl, typeStrippingOptions(workerUrl));
    worker.on("message", (message: unknown) => this.onMessage(message));
    worker.on("error", (error: unknown) => {
      this.pending?.({ kind: "failed", message: errorMessage(error) });
    });
    worker.on("exit", () => {
      if (this.worker === worker) this.worker = undefined;
      this.pending?.({ kind: "failed", message: "Markdown worker stopped" });
    });
    this.worker = worker;
    return worker;
  }

  private onMessage(message: unknown): void {
    const pending = this.pending;
    if (!isPlainObject(message) || typeof message.spentMs !== "number") {
      pending?.({ kind: "failed", message: "malformed worker message" });
      return;
    }
    this.spentMs = message.spentMs;
    if (message.budget === true) {
      pending?.({ kind: "budget" });
      return;
    }
    if (typeof message.failure === "string") {
      pending?.({ kind: "failed", message: message.failure });
      return;
    }
    const reply = replyOf(message.reply);
    pending?.(
      reply === undefined
        ? { kind: "failed", message: "malformed worker reply" }
        : { kind: "reply", reply },
    );
  }

  private stop(): void {
    const worker = this.worker;
    this.worker = undefined;
    void worker?.terminate();
  }
}

/** A job with no file: the check of a call's fields and operations (specs/markdown-tool.md#validation). */
function blankJob(kind: MarkdownJob["kind"], params: unknown): MarkdownJob {
  return { kind, params, text: "", revision: "", hadBom: false, display: "", absolute: "" };
}

/** A job that runs a call on a file the call has read (#action-outline, #action-read, #action-edit). */
function fileJob(
  kind: MarkdownJob["kind"],
  params: unknown,
  loaded: LoadedFile,
  display: string,
  absolute: string,
): MarkdownJob {
  return {
    kind,
    params,
    text: loaded.text,
    revision: loaded.revision,
    hadBom: loaded.hadBom,
    display,
    absolute,
  };
}

/** The path a call names, trimmed as given (specs/markdown-tool.md#file-access), for error texts before the check. */
function pathOf(params: unknown): string {
  if (!isPlainObject(params) || typeof params.path !== "string") return "";
  return params.path.trim();
}

/** A reply as the tool's result (specs/markdown-tool.md#registration). */
function toolResult(reply: MarkdownReply): ToolResult {
  const content: ToolResult["content"] = [{ type: "text", text: reply.text }];
  return reply.isError
    ? { content, details: {}, isError: true }
    : { content, details: reply.details };
}

/** A file read as specs/markdown-tool.md#file-access bounds it: its bytes, or why the call does not read them. */
type ReadOutcome = { bytes: Uint8Array } | { size: number } | { notRegular: true };

/**
 * Read a file without blocking the main thread or reading more than one byte past the
 * size limit (specs/markdown-tool.md#file-access). `O_NONBLOCK` keeps opening a FIFO from waiting for a writer.
 */
async function readBounded(path: string): Promise<ReadOutcome> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stats = await handle.stat();
    if (stats.isDirectory()) throw Object.assign(new Error("is a directory"), { code: "EISDIR" });
    if (!stats.isFile()) return { notRegular: true };
    if (stats.size > MARKDOWN_MAX_BYTES) return { size: stats.size };
    const buffer = new Uint8Array(MARKDOWN_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MARKDOWN_MAX_BYTES) return { size: Math.max(length, stats.size) };
    return { bytes: buffer.slice(0, length) };
  } finally {
    await handle.close();
  }
}

/** The `Markdown` tool's runtime. */
export function markdownRuntime(options: MarkdownRuntimeOptions = {}): MarkdownRuntime {
  const home = options.home ?? homedir();
  const injected = options.readFile;
  const read =
    injected === undefined
      ? readBounded
      : async (path: string): Promise<ReadOutcome> => ({ bytes: await injected(path) });
  const write =
    options.writeFile ??
    ((path: string, bytes: Uint8Array) => {
      writeFileSync(path, bytes);
    });
  const parseBudgetMs = options.parseBudgetMs ?? PARSE_BUDGET_MS;
  const queue =
    options.mutationQueue ??
    (<T>(path: string, body: () => Promise<T>) => withFileMutationQueue(path, body));

  /** Read a file and check it is a Markdown text the tool reads (specs/markdown-tool.md#file-access). */
  async function load(absolute: string, display: string): Promise<LoadedFile | LoadFailure> {
    let outcome: ReadOutcome;
    try {
      outcome = await read(absolute);
    } catch (error) {
      return { error: `cannot read ${display}: ${errorCode(error) ?? errorMessage(error)}` };
    }
    if ("notRegular" in outcome) return { error: `${display} is not a regular file` };
    const size = "size" in outcome ? outcome.size : outcome.bytes.length;
    if (size > MARKDOWN_MAX_BYTES) {
      return {
        error: `${display} is ${size} bytes; Markdown reads files of at most ${MARKDOWN_MAX_BYTES} bytes`,
      };
    }
    if (!("bytes" in outcome)) return { error: `cannot read ${display}` };
    const bytes = outcome.bytes;
    const decoded = decodeMarkdown(bytes);
    if (decoded === undefined) return { error: `${display} is not UTF-8 text` };
    return {
      bytes,
      text: decoded.text,
      hadBom: decoded.hadBom,
      revision: revisionOf(bytes),
    };
  }

  async function execute(invocation: MarkdownInvocation): Promise<ToolResult> {
    const worker = new CallWorker(parseBudgetMs);
    try {
      return await executeOn(worker, invocation);
    } finally {
      worker.close();
    }
  }

  /** The flow of a call on its worker: the check, the file, then the action (#validation, #file-access). */
  async function executeOn(
    worker: CallWorker,
    invocation: MarkdownInvocation,
  ): Promise<ToolResult> {
    const signal = invocation.signal;
    const display = pathOf(invocation.params);
    const checked = worker.reply(
      await worker.run(blankJob("check", invocation.params), signal),
      display,
    );
    if (checked.isError) return toolResult(checked);
    const kind = checked.details.kind;
    const revision = checked.details.revision;
    if (typeof kind !== "string" || typeof revision !== "string") {
      return toolResult(failure("Markdown cannot run this call"));
    }
    const absolute = resolveMarkdownPath(display, invocation.cwd, home);
    if (kind === "edit") {
      return queue(absolute, async () => {
        const loaded = await load(absolute, display);
        if ("error" in loaded) return toolResult(failure(loaded.error));
        if (loaded.revision !== revision) {
          return toolResult(
            failure(
              `${display} has changed since revision ${revision}; read the sections you edit, or outline the file, again before editing`,
            ),
          );
        }
        const reply = worker.reply(
          await worker.run(fileJob("edit", invocation.params, loaded, display, absolute), signal),
          display,
        );
        if (!reply.isError && reply.bytes !== undefined) {
          if (signal?.aborted === true) return toolResult(failure("Markdown aborted"));
          try {
            write(absolute, reply.bytes);
          } catch (error) {
            return toolResult(
              failure(`cannot write ${display}: ${errorCode(error) ?? errorMessage(error)}`),
            );
          }
        }
        return toolResult(reply);
      });
    }
    if (kind !== "outline" && kind !== "read" && kind !== "links") {
      return toolResult(failure("Markdown cannot run this call"));
    }
    if (signal?.aborted === true) return toolResult(failure("Markdown aborted"));
    const loaded = await load(absolute, display);
    if ("error" in loaded) return toolResult(failure(loaded.error));
    const reply = worker.reply(
      await worker.run(fileJob(kind, invocation.params, loaded, display, absolute), signal),
      display,
    );
    return toolResult(reply);
  }

  return { execute };
}

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#rendering: rendering, and the registration of specs/markdown-tool.md#registration
// ---------------------------------------------------------------------------

/** The lines `renderCall` shows for a call (specs/markdown-tool.md#rendering). */
export function renderMarkdownCallLines(args: unknown): string[] {
  const fields: Record<string, unknown> = isPlainObject(args) ? args : {};
  const parts: string[] = ["Markdown"];
  const action = fields.action;
  if (typeof action === "string") parts.push(action);
  const path = fields.path;
  if (typeof path === "string") parts.push(path);
  let head = parts.join(" ");
  const section = fields.section;
  if (typeof section === "string") {
    head += ` \u203a ${section}`;
  } else if (Array.isArray(fields.sections)) {
    const names = fields.sections.filter((item): item is string => typeof item === "string");
    if (names.length > 0) head += ` \u203a ${names.join(", ")}`;
  }
  const lines: string[] = [head];
  const operations = fields.operations;
  if (Array.isArray(operations)) {
    for (const operation of operations) {
      if (!isPlainObject(operation)) {
        lines.push("  ");
        continue;
      }
      const values: string[] = [];
      for (const field of ["op", "section", "position", "at"]) {
        const value = operation[field];
        if (typeof value === "string") values.push(value);
      }
      lines.push(`  ${values.join(" ")}`);
    }
  }
  return lines;
}

/** The `Markdown` tool definition the host registers (specs/markdown-tool.md#registration). */
export function makeMarkdownTool(runtime: MarkdownRuntime) {
  return defineTool({
    name: MARKDOWN_TOOL_NAME,
    label: MARKDOWN_TOOL_NAME,
    description: MARKDOWN_DESCRIPTION,
    promptSnippet: MARKDOWN_PROMPT_SNIPPET,
    parameters: markdownParameterSchema,
    prepareArguments: (args: unknown) => prepareMarkdownArguments(args),
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: ((partial: ToolResult) => void) | undefined,
      ctx: ExtensionToolContext,
    ): Promise<ToolResult> {
      return runtime.execute({ params, cwd: ctx.cwd, signal });
    },
    renderCall(args: unknown, _theme, context) {
      const component =
        context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      component.setText(renderMarkdownCallLines(args).join("\n"));
      return component;
    },
  });
}
