/**
 * The pure part of the `Markdown` tool (specs/markdown-tool.md): the call's
 * validation (Section 1.3), the `outline` (Section 3) and `read` (Section 4)
 * results, `links` (Section 6), and the job a worker thread runs for them and
 * for `edit` (Section 5). Nothing here imports the host: the worker of `lib/markdown-worker.ts`
 * loads this module alone, so every parse runs off the host's main thread
 * (Section 2.2).
 */

import { flattenText } from "./text.ts";
import { documentLinks } from "./markdown-links.ts";
import { isPlainObject } from "./util.ts";
import {
  REVISION,
  revisionOf,
  joinLines,
  analyzeDocument,
  isBlank,
  isWithin,
  noSectionMessage,
  parseHeadings,
  resolveAddress,
  splitLines,
  stripAddress,
  type DocModel,
  type DocSection,
  type TextLine,
} from "./markdown-document.ts";
import {
  applyOperations,
  type ContentBlock,
  type Operation,
  type OperationName,
  type OperationPosition,
} from "./markdown-edit.ts";

/** The tool name (Section 1). */
export const MARKDOWN_TOOL_NAME = "Markdown";

/** The `action` values (Section 1.1). */
export const MARKDOWN_ACTIONS = ["outline", "read", "edit", "links"] as const;

/** The `op` values (Section 1.1). */
export const MARKDOWN_OPERATIONS: readonly OperationName[] = [
  "replace",
  "replace_body",
  "insert",
  "delete",
  "move",
  "rename",
  "set_level",
];

/** The `position` values (Section 1.1). */
export const MARKDOWN_POSITIONS: readonly OperationPosition[] = [
  "before",
  "after",
  "first",
  "last",
];

/** The outline limit's default (Section 1.1). */
const OUTLINE_LIMIT = 100;

/** The read limit's default (Section 1.1). */
const READ_LIMIT = 500;

/** The longest preview line's text, in characters (Section 3). */
const PREVIEW_LENGTH = 100;

/** The most characters a `read` returns (Section 4). */
const READ_CHARACTERS = 50000;

/** The most lines a `read` returns (Section 4). */
const READ_LINES = 2000;

/** The most entries an outline lists (Section 1.1). */
const OUTLINE_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Section 1.3: validation
// ---------------------------------------------------------------------------

/** The parameter fields in the table order of Section 1.1, `action` and `path` excluded. */
const FIELD_ORDER = [
  "section",
  "depth",
  "preview",
  "offset",
  "limit",
  "revision",
  "operations",
] as const;

/** The operation fields in the table order of Section 1.1, `op` excluded. */
const OP_FIELD_ORDER = ["section", "position", "at", "content", "heading", "level"] as const;

/** The fields each action accepts (Section 1.1). */
const ACCEPTED: Readonly<Record<string, ReadonlySet<string>>> = {
  outline: new Set(["section", "depth", "preview", "offset", "limit"]),
  read: new Set(["section", "depth", "offset", "limit"]),
  links: new Set(["section", "offset", "limit"]),
  edit: new Set(["revision", "operations"]),
};

/** The fields each op accepts (Section 1.1); every one of them is required. */
const OP_ACCEPTED: Readonly<Record<string, readonly string[]>> = {
  replace: ["section", "content"],
  replace_body: ["section", "content"],
  insert: ["position", "at", "content"],
  delete: ["section"],
  move: ["section", "position", "at"],
  rename: ["section", "heading"],
  set_level: ["section", "level"],
};

/** A field value that counts as present: neither absent nor `null` (Section 1.1). */
function present(fields: Record<string, unknown>, name: string): unknown {
  const value = fields[name];
  return value === undefined || value === null ? undefined : value;
}

/** A present value as a trimmed string, or undefined when it is no string. */
function trimmedText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

/** True when `value` is a number for which `Number.isInteger` holds, between the bounds (Section 1.1). */
function isIntegerBetween(value: unknown, low: number, high: number): value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  return value >= low && value <= high;
}

/** True when a present value is `(document)` or `(preamble)` (Section 1.3). */
function isNamed(value: string | undefined, name: string): boolean {
  return value !== undefined && stripAddress(value) === name;
}

/** The action a call names, or undefined. */
function actionOf(value: unknown): string | undefined {
  for (const action of MARKDOWN_ACTIONS) {
    if (action === value) return action;
  }
  return;
}

/** The op a call names, or undefined. */
function operationOf(value: unknown): OperationName | undefined {
  for (const op of MARKDOWN_OPERATIONS) {
    if (op === value) return op;
  }
  return;
}

/** The position a call names, or undefined. */
function positionOf(value: unknown): OperationPosition | undefined {
  for (const position of MARKDOWN_POSITIONS) {
    if (position === value) return position;
  }
  return;
}

/** The content block of a `content` value: its lines without leading and trailing blank lines (Section 5.2). */
export function contentBlockOf(content: string): ContentBlock {
  const raw = splitLines(content).map((line) => line.text);
  let start = 0;
  let end = raw.length;
  while (start < end) {
    const line = raw[start];
    if (line === undefined || !isBlank(line)) break;
    start += 1;
  }
  while (end > start) {
    const line = raw[end - 1];
    if (line === undefined || !isBlank(line)) break;
    end -= 1;
  }
  return { lines: raw.slice(start, end), offset: start };
}

/** A line of a content block is a marker a `read` result left, not file text (Section 1.3, check 22). */
const READ_MARKERS: readonly RegExp[] = [
  /^\[\u2026 [0-9]+ lines hidden: [0-9]+-[0-9]+\]$/,
  /^--- cut: continue with offset [0-9]+ ---$/,
  /^--- end of section ---$/,
  / · lines [0-9]+-[0-9]+ · revision [0-9a-f]{8}$/,
];

/** The line of a content block that is a marker of a `read` result, or undefined (Section 1.3, check 22). */
function markerLine(block: ContentBlock): number | undefined {
  for (let index = 0; index < block.lines.length; index += 1) {
    const line = block.lines[index];
    if (line === undefined) continue;
    const text = line.replace(/^[ \t]+|[ \t]+$/g, "");
    for (const marker of READ_MARKERS) {
      if (!marker.test(text)) continue;
      return index + 1 + block.offset;
    }
  }
  return;
}

/** The validated shape of one operation, or the error text of the first failing check (Section 1.3). */
function checkOperation(value: unknown, index: number): Operation | { error: string } {
  const prefix = `operations[${index}]: `;
  const fields: Record<string, unknown> = isPlainObject(value) ? value : {};
  const op = operationOf(fields.op);
  if (op === undefined)
    return { error: `${prefix}op must be one of ${MARKDOWN_OPERATIONS.join(", ")}` };
  const accepted = OP_ACCEPTED[op] ?? [];
  for (const field of OP_FIELD_ORDER) {
    if (accepted.includes(field)) continue;
    if (present(fields, field) !== undefined) {
      return { error: `${prefix}${field} is not valid for op ${op}` };
    }
  }
  for (const field of OP_FIELD_ORDER) {
    if (!accepted.includes(field)) continue;
    if (present(fields, field) === undefined)
      return { error: `${prefix}op ${op} requires ${field}` };
  }
  const section = present(fields, "section");
  const at = present(fields, "at");
  if (section !== undefined) {
    const text = trimmedText(section);
    if (text === undefined || text === "") {
      return { error: `${prefix}section must be a non-empty string` };
    }
  }
  if (at !== undefined) {
    const text = trimmedText(at);
    if (text === undefined || text === "") {
      return { error: `${prefix}at must be a non-empty string` };
    }
  }
  const sectionText = trimmedText(section);
  const atText = trimmedText(at);
  if (isNamed(sectionText, "(document)")) {
    return { error: `${prefix}(document) is not valid as the section of op ${op}` };
  }
  if (isNamed(sectionText, "(preamble)") && op !== "replace_body") {
    return { error: `${prefix}(preamble) is not valid as the section of op ${op}` };
  }
  if (isNamed(atText, "(preamble)")) {
    return { error: `${prefix}(preamble) is not valid as the at of op ${op}` };
  }
  const position = positionOf(present(fields, "position"));
  if (isNamed(atText, "(document)") && (position === "before" || position === "after")) {
    return { error: `${prefix}at (document) takes position first or last` };
  }
  const headingValue = present(fields, "heading");
  let heading: string | undefined;
  if (headingValue !== undefined) {
    const raw = typeof headingValue === "string" ? headingValue : "";
    const text = raw.trim();
    if (text === "" || raw.includes("\n") || raw.includes("\r")) {
      return { error: `${prefix}heading must be one non-empty line` };
    }
    heading = text;
  }
  const levelValue = present(fields, "level");
  let level: number | undefined;
  if (levelValue !== undefined) {
    if (!isIntegerBetween(levelValue, 1, 6)) {
      return { error: `${prefix}level must be an integer from 1 to 6` };
    }
    level = levelValue;
  }
  const contentValue = present(fields, "content");
  const content = typeof contentValue === "string" ? contentValue : "";
  const block = contentBlockOf(content);
  if (op === "replace" || op === "insert") {
    const headings = parseHeadings(block.lines);
    const first = headings[0];
    if (block.lines.length === 0 || first === undefined || first.start !== 1) {
      return { error: `${prefix}content must start with a heading line` };
    }
    for (const other of headings.slice(1)) {
      if (other.level > first.level) continue;
      return {
        error: `${prefix}content must be one section: line ${other.start + block.offset} is a heading of level ${other.level}`,
      };
    }
  }
  if (op === "replace_body") {
    const headings = parseHeadings(block.lines);
    const first = headings[0];
    if (first !== undefined) {
      return {
        error: `${prefix}replace_body content must contain no heading: line ${first.start + block.offset} is one`,
      };
    }
  }
  const marker = markerLine(block);
  if (marker !== undefined) {
    return {
      error: `${prefix}content line ${marker} is a marker of read, not file text; read the section without depth and to its end first`,
    };
  }
  return {
    op,
    section: sectionText,
    position,
    at: atText,
    heading,
    level,
    block,
  };
}

/** A validated call, or the error text of the first failing check (Section 1.3). */
export type ValidatedCall =
  | { kind: "error"; message: string }
  | {
      kind: "outline";
      path: string;
      section: string | undefined;
      depth: number | undefined;
      preview: boolean;
      offset: number;
      limit: number;
    }
  | {
      kind: "read";
      path: string;
      section: string;
      depth: number | undefined;
      offset: number | undefined;
      limit: number;
    }
  | { kind: "links"; path: string; section: string | undefined; offset: number; limit: number }
  | { kind: "edit"; path: string; revision: string; operations: Operation[] };

/**
 * The checks of Section 1.3, in their order, the first failure reported: the
 * call's fields first, then each operation's.
 */
export function checkMarkdownCall(params: unknown): ValidatedCall {
  const fields: Record<string, unknown> = isPlainObject(params) ? params : {};
  const action = actionOf(fields.action);
  if (action === undefined) {
    return { kind: "error", message: `action must be one of ${MARKDOWN_ACTIONS.join(", ")}` };
  }
  const accepted = ACCEPTED[action] ?? new Set<string>();
  for (const field of FIELD_ORDER) {
    if (accepted.has(field)) continue;
    if (present(fields, field) !== undefined) {
      return { kind: "error", message: `${field} is not valid for action ${action}` };
    }
  }
  const path = trimmedText(fields.path);
  if (path === undefined || path === "") {
    return { kind: "error", message: "path must be a non-empty string" };
  }
  const sectionValue = present(fields, "section");
  const section = trimmedText(sectionValue);
  if (action === "read" && (section === undefined || section === "")) {
    return { kind: "error", message: "section must be a non-empty string" };
  }
  if (
    (action === "outline" || action === "links") &&
    sectionValue !== undefined &&
    section === ""
  ) {
    return { kind: "error", message: "section must be a non-empty string" };
  }
  if (isNamed(section, "(document)")) {
    return { kind: "error", message: `(document) is not valid as the section of ${action}` };
  }
  if (action === "outline" && isNamed(section, "(preamble)")) {
    return { kind: "error", message: `(preamble) is not valid as the section of ${action}` };
  }
  const depthValue = present(fields, "depth");
  let depth: number | undefined;
  if (depthValue !== undefined) {
    if (!isIntegerBetween(depthValue, 1, 6)) {
      return { kind: "error", message: "depth must be an integer from 1 to 6" };
    }
    depth = depthValue;
  }
  const offsetValue = present(fields, "offset");
  let offset: number | undefined;
  if (offsetValue !== undefined) {
    if (action === "outline" || action === "links") {
      if (typeof offsetValue !== "number" || !Number.isInteger(offsetValue) || offsetValue < 0) {
        return { kind: "error", message: "offset must be a non-negative integer" };
      }
      offset = offsetValue;
    }
    if (action === "read") {
      if (typeof offsetValue !== "number" || !Number.isInteger(offsetValue) || offsetValue <= 0) {
        return { kind: "error", message: "offset must be a positive integer" };
      }
      offset = offsetValue;
    }
  }
  const limitValue = present(fields, "limit");
  let limit: number | undefined;
  if (limitValue !== undefined) {
    if (action === "outline" || action === "links") {
      if (!isIntegerBetween(limitValue, 1, OUTLINE_ENTRIES)) {
        return { kind: "error", message: `limit must be an integer from 1 to ${OUTLINE_ENTRIES}` };
      }
      limit = limitValue;
    }
    if (action === "read") {
      if (!isIntegerBetween(limitValue, 1, READ_LINES)) {
        return { kind: "error", message: `limit must be an integer from 1 to ${READ_LINES}` };
      }
      limit = limitValue;
    }
  }
  if (action === "outline") {
    return {
      kind: "outline",
      path,
      section,
      depth,
      preview: present(fields, "preview") === true,
      offset: offset ?? 0,
      limit: limit ?? OUTLINE_LIMIT,
    };
  }
  if (action === "read") {
    return {
      kind: "read",
      path,
      section: section ?? "",
      depth,
      offset,
      limit: limit ?? READ_LIMIT,
    };
  }
  if (action === "links") {
    return { kind: "links", path, section, offset: offset ?? 0, limit: limit ?? OUTLINE_LIMIT };
  }
  const revisionValue = present(fields, "revision");
  const revision = trimmedText(revisionValue);
  if (revision === undefined || !REVISION.test(revision)) {
    return {
      kind: "error",
      message:
        "revision must be the 8-digit revision an outline, read, or edit result showed for this file",
    };
  }
  const operationsValue = present(fields, "operations");
  if (operationsValue === undefined) {
    return { kind: "error", message: "operations must hold 1 to 50 operations" };
  }
  const list = Array.isArray(operationsValue) ? operationsValue : [];
  if (list.length === 0 || list.length > 50) {
    return { kind: "error", message: "operations must hold 1 to 50 operations" };
  }
  const operations: Operation[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const checked = checkOperation(list[index], index);
    if ("error" in checked) return { kind: "error", message: checked.error };
    operations.push(checked);
  }
  return { kind: "edit", path, revision, operations };
}

// ---------------------------------------------------------------------------
// Sections 3 and 4: results
// ---------------------------------------------------------------------------

export /** The result of an `outline` call (Section 3). */
function outlineResult(
  loaded: LoadedText,
  validated: {
    path: string;
    section: string | undefined;
    depth: number | undefined;
    preview: boolean;
    offset: number;
    limit: number;
  },
  display: string,
  absolute: string,
): MarkdownReply {
  const model = analyzeDocument(loaded.lines);
  let candidates: number[] = [];
  let addressed: number | undefined;
  if (validated.section === undefined) {
    candidates = model.sections.map((section) => section.index);
  } else {
    const resolved = resolveForRead(model, validated.section, display);
    if ("error" in resolved) return failure(resolved.error);
    addressed = resolved.index;
    candidates = [resolved.index, ...descendantsOf(model, resolved.index)];
  }
  // The default depth fits the greater of `limit` and 100 entries (Section 3).
  const depth = validated.depth ?? defaultDepth(model, candidates, Math.max(validated.limit, 100));
  const entries: number[] = [];
  for (const index of candidates) {
    const section = model.sections[index];
    if (section === undefined) continue;
    if (section.level <= depth || index === addressed) entries.push(index);
  }
  const total = entries.length;
  if (validated.offset > 0 && validated.offset >= total) {
    return failure(`offset ${validated.offset} is past the last entry (${total} entries)`);
  }
  const shown = entries.slice(validated.offset, validated.offset + validated.limit);
  const lines: string[] = [
    `${display} \u00b7 ${model.lineCount} lines \u00b7 revision ${loaded.revision} \u00b7 depth ${depth}`,
  ];
  const frontmatter = model.frontmatter;
  if (frontmatter !== undefined && validated.section === undefined && validated.offset === 0) {
    lines.push(`${frontmatter.start}-${frontmatter.end} (frontmatter)`);
  }
  const preamble = model.preamble;
  if (preamble !== undefined && validated.section === undefined && validated.offset === 0) {
    lines.push(`${preamble.start}-${preamble.end} (preamble)`);
  }
  const entryDetails: Record<string, unknown>[] = [];
  const entrySet = new Set<number>(entries);
  for (const index of shown) {
    const section = model.sections[index];
    if (section === undefined) continue;
    const hidden = countHidden(model, section.index, entrySet);
    const hiddenText = hidden > 0 ? ` (+${hidden} hidden)` : "";
    lines.push(
      `${section.start}-${section.end} ${"#".repeat(section.level)} ${section.component}${hiddenText}`,
    );
    const detail: Record<string, unknown> = {
      address: section.address,
      level: section.level,
      start: section.start,
      end: section.end,
      hidden,
    };
    const preview = validated.preview ? previewOf(loaded.lines, section) : undefined;
    if (preview !== undefined) {
      lines.push(`    ${preview}`);
      detail.preview = preview;
    }
    entryDetails.push(detail);
  }
  if (model.sections.length === 0) lines.push("(no headings)");
  if (model.sections.length > 0 && entries.length === 0) {
    let shallowest = 6;
    for (const section of model.sections) shallowest = Math.min(shallowest, section.level);
    lines.push(`(no headings down to level ${depth}; the shallowest is level ${shallowest})`);
  }
  const next = validated.offset + shown.length;
  const more = next < total;
  if (more) lines.push(`More entries follow: repeat the call with offset: ${next}`);
  const details: Record<string, unknown> = {
    action: "outline",
    path: absolute,
    revision: loaded.revision,
    lines: model.lineCount,
    depth,
    total,
    offset: validated.offset,
    more,
    entries: entryDetails,
  };
  if (frontmatter !== undefined && validated.section === undefined && validated.offset === 0) {
    details.frontmatter = { start: frontmatter.start, end: frontmatter.end };
  }
  if (preamble !== undefined && validated.section === undefined && validated.offset === 0) {
    details.preamble = { start: preamble.start, end: preamble.end };
  }
  return { text: lines.join("\n"), details, isError: false };
}

export /** The result of a `read` call (Section 4). */
function readResult(
  loaded: LoadedText,
  validated: {
    path: string;
    section: string;
    depth: number | undefined;
    offset: number | undefined;
    limit: number;
  },
  display: string,
  absolute: string,
): MarkdownReply {
  const model = analyzeDocument(loaded.lines);
  let start: number;
  let end: number;
  let address: string;
  let level: number | null;
  let addressed: number | undefined;
  if (stripAddress(validated.section) === "(preamble)") {
    const preamble = model.preamble;
    if (preamble === undefined) return failure(`${display} has no preamble`);
    start = preamble.start;
    end = preamble.end;
    address = "(preamble)";
    level = null;
  } else {
    const resolved = resolveForRead(model, validated.section, display);
    if ("error" in resolved) return failure(resolved.error);
    const section = model.sections[resolved.index];
    if (section === undefined) {
      return failure(noSectionMessage(model, validated.section, display));
    }
    addressed = section.index;
    start = section.start;
    end = section.end;
    address = section.address;
    level = section.level;
  }
  const offset = validated.offset ?? start;
  if (offset < start || offset > end) {
    return failure(`offset ${offset} is outside ${address} (lines ${start}-${end})`);
  }
  const display_ = displayLines(model, loaded.lines, addressed, validated.depth, start, end);
  let position = 0;
  while (position < display_.length) {
    const line = display_[position];
    if (line !== undefined && line.last >= offset) break;
    position += 1;
  }
  const shown: DisplayLine[] = [];
  let length = 0;
  while (position < display_.length && shown.length < validated.limit) {
    const line = display_[position];
    if (line === undefined) break;
    if (shown.length === 0) {
      const text =
        line.text.length > READ_CHARACTERS
          ? `${line.text.slice(0, READ_CHARACTERS)}\u2026`
          : line.text;
      shown.push({ first: line.first, last: line.last, text });
      length = text.length;
      position += 1;
      continue;
    }
    if (length + 1 + line.text.length > READ_CHARACTERS) break;
    shown.push(line);
    length += 1 + line.text.length;
    position += 1;
  }
  const firstShown = shown[0];
  const lastShown = shown[shown.length - 1];
  const parts: string[] = [
    `${display} \u00b7 ${address} \u00b7 lines ${start}-${end} \u00b7 revision ${loaded.revision}`,
  ];
  for (const line of shown) parts.push(line.text);
  const next = display_[position];
  if (next === undefined) {
    parts.push("--- end of section ---");
  } else {
    parts.push(`--- cut: continue with offset ${next.first} ---`);
  }
  const details: Record<string, unknown> = {
    action: "read",
    path: absolute,
    revision: loaded.revision,
    address,
    level,
    start,
    end,
    from: firstShown === undefined ? start : firstShown.first,
    to: lastShown === undefined ? start : lastShown.last,
  };
  if (next !== undefined) details.next = next.first;
  return { text: parts.join("\n"), details, isError: false };
}

/** The inventory and paging of Section 6. */
function linksResult(
  loaded: LoadedText,
  validated: Extract<ValidatedCall, { kind: "links" }>,
  display: string,
  absolute: string,
): MarkdownReply {
  const model = analyzeDocument(loaded.lines);
  let scope = "(document)";
  let start = 1;
  let end = model.lineCount;
  if (validated.section !== undefined) {
    if (stripAddress(validated.section) === "(preamble)") {
      if (model.preamble === undefined) return failure(`${display} has no preamble`);
      scope = "(preamble)";
      start = model.preamble.start;
      end = model.preamble.end;
    } else {
      const resolved = resolveForRead(model, validated.section, display);
      if ("error" in resolved) return failure(resolved.error);
      const section = model.sections[resolved.index];
      if (section === undefined)
        return failure(noSectionMessage(model, validated.section, display));
      scope = section.address;
      start = section.start;
      end = section.end;
    }
  }
  const frontmatterLines = model.frontmatter?.end ?? 0;
  const source = joinLines(loaded.lines.slice(frontmatterLines));
  const items = documentLinks(source, frontmatterLines).filter(
    (item) => item.line >= start && item.line <= end,
  );
  const total = items.length;
  if (validated.offset > 0 && validated.offset >= total) {
    return failure(`offset ${validated.offset} is past the last item (${total} items)`);
  }
  const shown = items.slice(validated.offset, validated.offset + validated.limit);
  const lines = [`${display} · ${scope} · ${total} items · revision ${loaded.revision}`];
  for (const item of shown) {
    let line = `${item.line} ${item.kind}`;
    if (item.destination !== undefined) line += ` ${item.destination || "<>"}`;
    if (item.label !== undefined) line += ` [${item.label}]`;
    if (item.text !== undefined) line += ` · ${item.text}`;
    lines.push(line);
  }
  if (total === 0) lines.push("(no items)");
  const next = validated.offset + shown.length;
  const more = next < total;
  if (more) lines.push(`More items follow: repeat the call with offset: ${next}`);
  return {
    text: lines.join("\n"),
    details: {
      action: "links",
      path: absolute,
      revision: loaded.revision,
      scope,
      total,
      offset: validated.offset,
      more,
      items: shown,
    },
    isError: false,
  };
}

// ---------------------------------------------------------------------------
// Sections 3 and 4: shared computation
// ---------------------------------------------------------------------------

/** A section a read or outline address names, or the error text (Section 2.4). */
function resolveForRead(
  model: DocModel,
  value: string,
  path: string,
): { index: number } | { error: string } {
  const resolved = resolveAddress(model, value, path);
  if ("error" in resolved) return resolved;
  return { index: resolved.index };
}

/** The descendants of a section, in document order (Section 2.3). */
function descendantsOf(model: DocModel, index: number): number[] {
  const found: number[] = [];
  for (const section of model.sections) {
    if (section.index === index) continue;
    if (!isWithin(model, section.index, index)) continue;
    found.push(section.index);
  }
  return found;
}

/** The number of a section's descendants that are not among `entries` (Section 3). */
function countHidden(model: DocModel, index: number, entries: ReadonlySet<number>): number {
  let hidden = 0;
  for (const section of model.sections) {
    if (section.index === index) continue;
    if (entries.has(section.index)) continue;
    if (!isWithin(model, section.index, index)) continue;
    hidden += 1;
  }
  return hidden;
}

/** The default `<d>` of an outline (Section 3). */
function defaultDepth(model: DocModel, candidates: readonly number[], limit: number): number {
  if (candidates.length === 0) return 6;
  const levels: number[] = [];
  for (const index of candidates) {
    const level = model.sections[index]?.level;
    if (level === undefined || levels.includes(level)) continue;
    levels.push(level);
  }
  levels.sort((left, right) => left - right);
  let depth: number | undefined;
  for (const level of levels) {
    let count = 0;
    for (const index of candidates) {
      const section = model.sections[index];
      if (section !== undefined && section.level <= level) count += 1;
    }
    if (count <= limit) depth = level;
  }
  return depth ?? levels[0] ?? 6;
}

/** The preview line of a section: the first line of its own body, flattened and cut (Section 3). */
function previewOf(lines: readonly TextLine[], section: DocSection): string | undefined {
  if (section.bodyStart === undefined) return;
  const line = lines[section.bodyStart - 1];
  if (line === undefined) return;
  const flattened = flattenText(line.text);
  return flattened.length > PREVIEW_LENGTH
    ? `${flattened.slice(0, PREVIEW_LENGTH)}\u2026`
    : flattened;
}

/** A display line of a read result: the file lines it covers, and its text (Section 4). */
interface DisplayLine {
  first: number;
  last: number;
  text: string;
}

/** The display lines of a read range, collapsing the sections deeper than `depth` (Section 4). */
function displayLines(
  model: DocModel,
  lines: readonly TextLine[],
  addressed: number | undefined,
  depth: number | undefined,
  start: number,
  end: number,
): DisplayLine[] {
  const collapsed = new Set<number>();
  if (depth !== undefined && addressed !== undefined) {
    for (const section of model.sections) {
      if (section.index === addressed) continue;
      if (section.level <= depth) continue;
      if (!isWithin(model, section.index, addressed)) continue;
      let parent = section.parent;
      let blocked = false;
      while (parent !== undefined && parent !== addressed) {
        if (collapsed.has(parent)) {
          blocked = true;
          break;
        }
        parent = model.sections[parent]?.parent;
      }
      if (blocked) continue;
      collapsed.add(section.index);
    }
  }
  const byHeading = new Map<number, DocSection>();
  for (const index of collapsed) {
    const section = model.sections[index];
    if (section !== undefined) byHeading.set(section.headingStart, section);
  }
  const display: DisplayLine[] = [];
  let line = start;
  while (line <= end) {
    const section = byHeading.get(line);
    if (section === undefined) {
      const text = lines[line - 1];
      display.push({ first: line, last: line, text: text === undefined ? "" : text.text });
      line += 1;
      continue;
    }
    for (let number = section.headingStart; number <= section.headingEnd; number += 1) {
      const text = lines[number - 1];
      display.push({ first: number, last: number, text: text === undefined ? "" : text.text });
    }
    if (section.end > section.headingEnd) {
      const hidden = section.end - section.headingEnd;
      display.push({
        first: section.headingEnd + 1,
        last: section.end,
        text: `[\u2026 ${hidden} lines hidden: ${section.headingEnd + 1}-${section.end}]`,
      });
    }
    line = section.end + 1;
  }
  return display;
}

// ---------------------------------------------------------------------------
// The jobs a worker runs (Section 2.2)
// ---------------------------------------------------------------------------

/** A file's lines and revision, as the result functions read them (Section 2.1). */
export interface LoadedText {
  lines: TextLine[];
  revision: string;
}

/** The text and details of a result, and for an `edit` that changed the file, the bytes to write (Section 5.1). */
export interface MarkdownReply {
  text: string;
  details: Record<string, unknown>;
  isError: boolean;
  bytes?: Uint8Array;
}

/** A tool error with no details (Section 1). */
export function failure(message: string): MarkdownReply {
  return { text: message, details: {}, isError: true };
}

/** One job of a call, as the worker runs it (Section 2.2). */
export interface MarkdownJob {
  /** `check` validates the call (Section 1.3); the others run it on the file's text. */
  kind: "check" | "outline" | "read" | "edit" | "links";
  params: unknown;
  /** The file's text without a leading U+FEFF, its revision, and whether it had one (Section 2.1). */
  text: string;
  revision: string;
  hadBom: boolean;
  /** The trimmed `path` as given, and the absolute path the call resolved (Section 2.1). */
  display: string;
  absolute: string;
}

/**
 * Run a job (Sections 1.3 to 6): the check of a call's fields and operations,
 * then its action on the text. The result is the reply the caller turns into a
 * tool result, and for `edit` the bytes the caller writes.
 */
export function runMarkdownJob(job: MarkdownJob): MarkdownReply {
  const validated = checkMarkdownCall(job.params);
  if (validated.kind === "error") return failure(validated.message);
  if (job.kind === "check") {
    const revision = validated.kind === "edit" ? validated.revision : "";
    return {
      text: "",
      details: { kind: validated.kind, path: validated.path, revision },
      isError: false,
    };
  }
  const loaded: LoadedText = { lines: splitLines(job.text), revision: job.revision };
  if (job.kind === "outline" && validated.kind === "outline") {
    return outlineResult(loaded, validated, job.display, job.absolute);
  }
  if (job.kind === "read" && validated.kind === "read") {
    return readResult(loaded, validated, job.display, job.absolute);
  }
  if (job.kind === "links" && validated.kind === "links") {
    return linksResult(loaded, validated, job.display, job.absolute);
  }
  if (job.kind === "edit" && validated.kind === "edit") {
    return editJob(job, loaded, validated);
  }
  return failure("Markdown cannot run this call");
}

/** The result of an `edit` call whose file and revision check out (Section 5.5). */
function editJob(
  job: MarkdownJob,
  loaded: LoadedText,
  validated: Extract<ValidatedCall, { kind: "edit" }>,
): MarkdownReply {
  const applied = applyOperations({
    text: job.text,
    lines: loaded.lines,
    operations: validated.operations,
    path: job.display,
  });
  if (applied.kind === "error") return failure(applied.message);
  const outcome = applied.outcome;
  const details: Record<string, unknown> = {
    action: "edit",
    path: job.absolute,
    revision: job.revision,
    previousRevision: job.revision,
    changed: outcome.changed,
    lines: outcome.lineCount,
    touched: outcome.touched,
    removed: outcome.removed,
    renumbered: outcome.renumbered,
    skipped: outcome.skipped,
  };
  if (!outcome.changed) {
    return {
      text: `${job.display} unchanged \u00b7 ${outcome.lineCount} lines \u00b7 revision ${job.revision}`,
      details,
      isError: false,
    };
  }
  const bytes = new TextEncoder().encode((job.hadBom ? "\uFEFF" : "") + outcome.text);
  const revision = revisionOf(bytes);
  const lines: string[] = [
    `Edited ${job.display}: ${validated.operations.length} operations \u00b7 ${outcome.lineCount} lines \u00b7 revision ${revision}`,
    ...outcome.listed,
  ];
  if (outcome.removed.length > 0) {
    lines.push(`${outcome.removed.length} sections removed or overwritten:`);
    for (const section of outcome.removed) {
      const count = section.end - section.start + 1;
      lines.push(
        `  ${section.start}-${section.end} ${"#".repeat(section.level)} ${section.text} (${count} lines, ${section.subsections} subsections)`,
      );
    }
  }
  if (outcome.renumbered.length > 0) {
    lines.push(
      `${outcome.renumbered.length} headings renumbered; references to their old numbers elsewhere in the text were not updated:`,
    );
    for (const heading of outcome.renumbered) {
      lines.push(
        `  ${heading.start} ${"#".repeat(heading.level)} ${heading.from} \u2192 ${heading.to}`,
      );
    }
  }
  for (const group of outcome.skipped) {
    lines.push(
      `Numbering left as written under ${group.parent}: its numbers ${group.numbers.join(", ")} are not in sequence`,
    );
  }
  return {
    text: lines.join("\n"),
    details: { ...details, revision, changed: true },
    isError: false,
    bytes,
  };
}
