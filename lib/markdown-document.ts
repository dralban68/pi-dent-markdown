/**
 * The Markdown document model of specs/markdown-tool.md: the file's bytes and
 * text (specs/markdown-tool.md#file-access), the parse (specs/markdown-tool.md#parsing), the sections (specs/markdown-tool.md#sections), and
 * the section addresses (specs/markdown-tool.md#section-addresses).
 *
 * `mdast-util-from-markdown` with the GFM table extension answers which lines
 * are headings and at what level (CommonMark 0.31.2 with the tables extension,
 * top-level headings only). Everything else — the raw heading text, the spans,
 * the components and full addresses, and the three matching steps — is computed
 * here on lines and line spans, so nothing outside this module sees an mdast
 * node.
 */

import { createHash } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";

/** The greatest file size the tool reads, in bytes (specs/markdown-tool.md#file-access). */
export const MARKDOWN_MAX_BYTES = 4194304;

/** The separator of specs/markdown-tool.md#section-addresses: a space, `>`, and a space. */
export const ADDRESS_SEPARATOR = " > ";

/** One line of a text: its characters and its line ending, which is empty at the end of a text (specs/markdown-tool.md#file-access). */
export interface TextLine {
  text: string;
  ending: string;
}

/** A range of file lines, both ends included, numbered from 1 (#parsing, #sections). */
export interface LineRange {
  start: number;
  end: number;
}

/** True for a blank line: only spaces and tabs, or nothing (specs/markdown-tool.md#file-access). */
export function isBlank(text: string): boolean {
  for (const character of text) {
    if (character !== " " && character !== "\t") return false;
  }
  return true;
}

/**
 * Split a text into its lines at line endings: a line feed, a carriage return
 * not followed by a line feed, or a carriage return followed by a line feed
 * (specs/markdown-tool.md#file-access). A line ending at the end of the text starts no further line.
 */
export function splitLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "\n") {
      lines.push({ text: text.slice(start, index), ending: "\n" });
      index += 1;
      start = index;
      continue;
    }
    if (character === "\r") {
      const pair = text[index + 1] === "\n";
      lines.push({ text: text.slice(start, index), ending: pair ? "\r\n" : "\r" });
      index += pair ? 2 : 1;
      start = index;
      continue;
    }
    index += 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), ending: "" });
  return lines;
}

/** The text of lines, each followed by its line ending. */
export function joinLines(lines: readonly TextLine[]): string {
  let text = "";
  for (const line of lines) text += line.text + line.ending;
  return text;
}

/** A decoded Markdown text and whether a leading U+FEFF was removed (specs/markdown-tool.md#file-access). */
export interface DecodedText {
  text: string;
  hadBom: boolean;
}

const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The text of a file's bytes decoded as UTF-8, without a leading U+FEFF, or
 * undefined when the bytes are not valid UTF-8 or the decoded text holds U+0000
 * (specs/markdown-tool.md#file-access).
 */
export function decodeMarkdown(bytes: Uint8Array): DecodedText | undefined {
  let text: string;
  try {
    text = DECODER.decode(bytes);
  } catch {
    return;
  }
  if (text.includes("\u0000")) return;
  const hadBom = text.startsWith("\uFEFF");
  return { text: hadBom ? text.slice(1) : text, hadBom };
}

/** A file's revision: the first 8 lowercase hexadecimal digits of the SHA-256 digest of its bytes (specs/markdown-tool.md#file-access). */
export function revisionOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/** A revision value: 8 lowercase hexadecimal digits. */
export const REVISION = /^[0-9a-f]{8}$/;

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#parsing: parsing
// ---------------------------------------------------------------------------

/** The parse time one call may spend, in milliseconds (specs/markdown-tool.md#parsing). */
export const PARSE_BUDGET_MS = 10000;

/** The parse time a call has spent, and the most it may spend (specs/markdown-tool.md#parsing). */
export interface ParseClock {
  spentMs: number;
  limitMs: number;
}

/** Raised when the parses of a call reach its budget (specs/markdown-tool.md#parsing). */
export class ParseBudgetError extends Error {}

/** The clock the parses of the running call are charged to, or undefined outside a call. */
let activeClock: ParseClock | undefined;

/** Run `body` with `clock` charged for every parse it makes (specs/markdown-tool.md#parsing). */
export function withParseClock<T>(clock: ParseClock, body: () => T): T {
  const previous = activeClock;
  activeClock = clock;
  try {
    return body();
  } finally {
    activeClock = previous;
  }
}

/** Charge a parse's time to the active clock, raising when the budget is reached (specs/markdown-tool.md#parsing). */
function chargeParse(milliseconds: number): void {
  if (activeClock === undefined) return;
  activeClock.spentMs += milliseconds;
  if (activeClock.spentMs >= activeClock.limitMs) {
    throw new ParseBudgetError("parse budget reached");
  }
}

/** A heading of the document, on the file's line numbers (specs/markdown-tool.md#parsing). */
export interface HeadingInfo {
  level: number;
  /** Its heading line: the first of its lines. */
  start: number;
  /** Its last line: the underline of a setext heading, its heading line for an ATX heading. */
  end: number;
  /** Its heading text, kept as written. */
  text: string;
  /** True for an ATX heading, false for a setext heading. */
  atx: boolean;
  /** ATX only: the index of the opening `#` in its heading line. */
  openStart: number;
  /** ATX only: the index in its heading line where its raw contents begin. */
  contentStart: number;
  /** ATX only: the index in its heading line where its raw contents end. */
  contentEnd: number;
}

/** The opening sequence of an ATX heading, up to and including the spaces or tabs after it ([CommonMark], Section 4.2). */
const ATX_OPENING = /^( {0,3})(#{1,6})(?:[ \t]+|$)/;

/** A whole ATX heading line's remainder that is a closing sequence. */
const ATX_CLOSING_ONLY = /^[ \t]*#+[ \t]*$/;

/** A closing sequence at the end of an ATX heading line's remainder. */
const ATX_CLOSING_TAIL = /[ \t]+#+[ \t]*$/;

/** The frontmatter line of specs/markdown-tool.md#parsing: `---` followed by nothing but spaces and tabs. */
const FRONTMATTER_LINE = /^---[ \t]*$/;

interface AtxParts {
  level: number;
  openStart: number;
  contentStart: number;
  contentEnd: number;
}

/**
 * The parts of an ATX heading line, or undefined when the line opens no heading:
 * the opening sequence, then the raw contents, then an optional closing sequence
 * ([CommonMark], Section 4.2). The raw contents end before trailing spaces and tabs.
 */
function atxParts(line: string): AtxParts | undefined {
  const opening = ATX_OPENING.exec(line);
  if (opening === null) return;
  const hashes = opening[2] ?? "";
  const openStart = (opening[1] ?? "").length;
  const contentStart = opening[0].length;
  const rest = line.slice(contentStart);
  let contentEnd = contentStart;
  if (!ATX_CLOSING_ONLY.test(rest)) {
    const tail = ATX_CLOSING_TAIL.exec(rest);
    contentEnd = contentStart + (tail === null ? rest.length : tail.index);
  }
  while (contentEnd > contentStart) {
    const character = line[contentEnd - 1];
    if (character !== " " && character !== "\t") break;
    contentEnd -= 1;
  }
  return { level: hashes.length, openStart, contentStart, contentEnd };
}

/** A heading line without its leading and trailing spaces and tabs (specs/markdown-tool.md#parsing). */
function trimmed(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end) {
    const character = text[start];
    if (character !== " " && character !== "\t") break;
    start += 1;
  }
  while (end > start) {
    const character = text[end - 1];
    if (character !== " " && character !== "\t") break;
    end -= 1;
  }
  return text.slice(start, end);
}

/**
 * The headings of a text parsed as a document is (specs/markdown-tool.md#parsing): CommonMark
 * 0.31.2 with the tables extension of [GFM], Section 4.10, and no other extension,
 * keeping only headings whose parent block is the document. No frontmatter is
 * recognized. Lines are numbered from 1.
 */
export function parseHeadings(lines: readonly string[]): HeadingInfo[] {
  if (lines.length === 0) return [];
  const started = performance.now();
  const tree = fromMarkdown(lines.join("\n"), {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  chargeParse(performance.now() - started);
  const headings: HeadingInfo[] = [];
  for (const node of tree.children) {
    if (node.type !== "heading") continue;
    const position = node.position;
    if (position === undefined) continue;
    const end = position.end.line;
    const line = lines[position.start.line - 1];
    if (line === undefined) continue;
    const atx = atxParts(line);
    if (atx !== undefined && atx.level === node.depth) {
      const start = position.start.line;
      headings.push({
        level: node.depth,
        start,
        end: start,
        text: line.slice(atx.contentStart, atx.contentEnd),
        atx: true,
        openStart: atx.openStart,
        contentStart: atx.contentStart,
        contentEnd: atx.contentEnd,
      });
      continue;
    }
    // A setext heading preceded by link reference definitions in its paragraph starts at the
    // definitions' line in mdast; its heading line is the line of its first inline child.
    const start = node.children[0]?.position?.start.line ?? position.start.line;
    const content: string[] = [];
    for (let number = start; number < end; number += 1) {
      const contentLine = lines[number - 1];
      if (contentLine === undefined) continue;
      content.push(trimmed(contentLine));
    }
    headings.push({
      level: node.depth,
      start,
      end,
      text: content.join(" "),
      atx: false,
      openStart: 0,
      contentStart: 0,
      contentEnd: 0,
    });
  }
  return headings;
}

/** The frontmatter this tool detects: line 1 through the first later `---` line (specs/markdown-tool.md#parsing). */
export function detectFrontmatter(lines: readonly TextLine[]): LineRange | undefined {
  const first = lines[0];
  if (first === undefined || !FRONTMATTER_LINE.test(first.text)) return;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (FRONTMATTER_LINE.test(line.text)) return { start: 1, end: index + 1 };
  }
  return;
}

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#sections: sections
// ---------------------------------------------------------------------------

/** A section of the document, on the file's line numbers (specs/markdown-tool.md#sections). */
export interface DocSection {
  /** Its place in document order, counting from 0. */
  index: number;
  level: number;
  /** Its span: its heading line to its end line. */
  start: number;
  end: number;
  headingStart: number;
  headingEnd: number;
  /** Its heading text. */
  text: string;
  /** The heading the section starts. */
  heading: HeadingInfo;
  /** The section of the nearest preceding heading with a lower level. */
  parent: number | undefined;
  /** The sections whose parent this one is, in document order. */
  children: number[];
  /** Its own body: the first and last line, or absent when it is empty. */
  bodyStart: number | undefined;
  bodyEnd: number | undefined;
  /** Its component of specs/markdown-tool.md#section-addresses, with the ` [<n>]` suffix when its text is not unique among its siblings. */
  component: string;
  /** Its full address of specs/markdown-tool.md#section-addresses. */
  address: string;
}

/** A parsed document: its frontmatter, its preamble, and its sections (#parsing, #sections). */
export interface DocModel {
  frontmatter: LineRange | undefined;
  /** The lines before the first heading; not a section. */
  preamble: LineRange | undefined;
  sections: DocSection[];
  /** The file's line count. */
  lineCount: number;
  /** The heading lines of the document's headings. */
  headingLines: ReadonlySet<number>;
}

/** The last non-blank line in `from`-`to`, or undefined when every line there is blank. */
function lastNonBlank(lines: readonly TextLine[], from: number, to: number): number | undefined {
  let line = Math.min(to, lines.length);
  while (line >= from) {
    const text = lines[line - 1];
    if (text !== undefined && !isBlank(text.text)) return line;
    line -= 1;
  }
  return;
}

/** The first non-blank line in `from`-`to`, or undefined when every line there is blank. */
function firstNonBlank(lines: readonly TextLine[], from: number, to: number): number | undefined {
  let line = Math.max(1, from);
  while (line <= to && line <= lines.length) {
    const text = lines[line - 1];
    if (text !== undefined && !isBlank(text.text)) return line;
    line += 1;
  }
  return;
}

/**
 * The document of a file's lines (#parsing, #sections): the frontmatter is
 * detected and left out, the rest is parsed, and each heading of the document
 * starts one section.
 */
export function analyzeDocument(lines: readonly TextLine[]): DocModel {
  const frontmatter = detectFrontmatter(lines);
  const docStart = frontmatter === undefined ? 0 : frontmatter.end;
  const texts: string[] = [];
  for (let index = docStart; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined) texts.push(line.text);
  }
  const headings: HeadingInfo[] = [];
  for (const heading of parseHeadings(texts)) {
    headings.push({ ...heading, start: heading.start + docStart, end: heading.end + docStart });
  }
  const count = headings.length;
  const parents: (number | undefined)[] = [];
  const ends: number[] = [];
  const stack: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const heading = headings[index];
    if (heading === undefined) continue;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const open = top === undefined ? undefined : headings[top];
      if (open === undefined || open.level < heading.level) break;
      ends[top ?? 0] = heading.start;
      stack.pop();
    }
    parents[index] = stack.length === 0 ? undefined : stack[stack.length - 1];
    stack.push(index);
  }
  const sections: DocSection[] = [];
  for (let index = 0; index < count; index += 1) {
    const heading = headings[index];
    if (heading === undefined) continue;
    const bound = ends[index] ?? lines.length + 1;
    const end = lastNonBlank(lines, heading.start, bound - 1) ?? heading.start;
    const parent = parents[index];
    sections.push({
      index,
      level: heading.level,
      start: heading.start,
      end,
      headingStart: heading.start,
      headingEnd: heading.end,
      text: heading.text,
      heading,
      parent,
      children: [],
      bodyStart: undefined,
      bodyEnd: undefined,
      component: "",
      address: "",
    });
  }
  for (const section of sections) {
    if (section.parent === undefined) continue;
    sections[section.parent]?.children.push(section.index);
  }
  for (const section of sections) {
    const after = section.headingEnd + 1;
    if (after > section.end) continue;
    const first = firstNonBlank(lines, after, section.end);
    if (first === undefined) continue;
    const firstChild = section.children[0];
    const firstChildSection = firstChild === undefined ? undefined : sections[firstChild];
    if (firstChildSection !== undefined && first === firstChildSection.headingStart) continue;
    section.bodyStart = first;
    section.bodyEnd =
      firstChildSection === undefined
        ? lastNonBlank(lines, first, section.end)
        : lastNonBlank(lines, first, firstChildSection.headingStart - 1);
  }
  const headingLines = new Set<number>();
  for (const heading of headings) headingLines.add(heading.start);
  const firstDocument = firstNonBlank(lines, docStart + 1, lines.length);
  let preamble: LineRange | undefined;
  if (firstDocument !== undefined && !headingLines.has(firstDocument)) {
    const firstHeading = headings[0];
    const end =
      firstHeading === undefined
        ? lastNonBlank(lines, firstDocument, lines.length)
        : lastNonBlank(lines, firstDocument, firstHeading.start - 1);
    if (end !== undefined) preamble = { start: firstDocument, end };
  }
  assignAddresses(sections);
  return { frontmatter, preamble, sections, lineCount: lines.length, headingLines };
}

/** The components and full addresses of specs/markdown-tool.md#section-addresses, in document order. */
function assignAddresses(sections: DocSection[]): void {
  const seen = new Map<string, number>();
  for (const section of sections) {
    const key = `${section.parent === undefined ? "" : String(section.parent)}\u0000${section.text}`;
    const earlier = seen.get(key) ?? 0;
    seen.set(key, earlier + 1);
    const base = section.text === "" ? "(untitled)" : section.text;
    section.component = earlier === 0 ? base : `${base} [${earlier + 1}]`;
    const parent = section.parent === undefined ? undefined : sections[section.parent];
    section.address =
      parent === undefined
        ? section.component
        : `${parent.address}${ADDRESS_SEPARATOR}${section.component}`;
  }
}

/** The ancestors of a section, from the top-level one down to its parent. */
export function ancestorsOf(model: DocModel, index: number): DocSection[] {
  const chain: DocSection[] = [];
  let parent = model.sections[index]?.parent;
  while (parent !== undefined) {
    const section = model.sections[parent];
    if (section === undefined) break;
    chain.unshift(section);
    parent = section.parent;
  }
  return chain;
}

/** True when `index` is the section `ancestor` or one of its descendants. */
export function isWithin(model: DocModel, index: number, ancestor: number): boolean {
  let current: number | undefined = index;
  while (current !== undefined) {
    if (current === ancestor) return true;
    current = model.sections[current]?.parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#renumbering: number prefixes
// ---------------------------------------------------------------------------

/** A number prefix of specs/markdown-tool.md#renumbering and the number it denotes. */
export interface NumberPrefix {
  /** The digits and dots, with the trailing dot when there is one. */
  prefix: string;
  /** The integers the runs denote, in order. */
  components: number[];
  /** True when the prefix ends with a dot after its last run. */
  trailingDot: boolean;
  /** The number of characters of the heading text the prefix occupies. */
  length: number;
}

/**
 * The number prefix a heading text starts with (specs/markdown-tool.md#renumbering): one or more runs
 * of digits joined by single dots, an optional trailing dot, at least one space
 * or tab, and then another character.
 */
const NUMBER_PREFIX = /^([0-9]+(?:\.[0-9]+)*)(\.?)([ \t]+)(?=[\s\S])/;

/** The number prefix a heading text starts with, or undefined when it is not numbered (specs/markdown-tool.md#renumbering). */
export function parseNumberPrefix(text: string): NumberPrefix | undefined {
  const match = NUMBER_PREFIX.exec(text);
  if (match === null) return;
  const digits = match[1] ?? "";
  const dot = match[2] ?? "";
  const components: number[] = [];
  for (const run of digits.split(".")) components.push(Number(run));
  return {
    prefix: digits + dot,
    components,
    trailingDot: dot === ".",
    length: digits.length + dot.length,
  };
}

/** A heading text without a leading number prefix (specs/markdown-tool.md#renumbering). */
export function withoutNumberPrefix(text: string): string {
  const number = parseNumberPrefix(text);
  return number === undefined ? text : text.slice(number.length);
}

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#section-addresses: section addresses
// ---------------------------------------------------------------------------

/** True when two number sequences are equal component by component. */
export function sameComponents(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * The number a number component names (specs/markdown-tool.md#section-addresses): an optional `Section ` or
 * `§`, zero or more spaces and tabs, digit runs joined by single dots, and an
 * optional trailing dot, and nothing else.
 */
const NUMBER_COMPONENT = /^(?:Section |§)?[ \t]*([0-9]+(?:\.[0-9]+)*)\.?$/;

/** The integers a number component denotes, or undefined when the component is no number component. */
export function numberOfComponent(component: string): number[] | undefined {
  const match = NUMBER_COMPONENT.exec(component);
  if (match === null) return;
  return (match[1] ?? "").split(".").map((run) => Number(run));
}

/**
 * The value of a section address after stripping (specs/markdown-tool.md#section-addresses): trimmed, then
 * stripped, in this order and each at most once, of a leading `* `, a leading
 * line range `<a>-<b> `, and a trailing ` (+<k> hidden)`.
 */
export function stripAddress(value: string): string {
  return parseAddress(value).text;
}

/** A line range `<a>-<b>` of an address, as integers (specs/markdown-tool.md#section-addresses). */
export interface LineSpan {
  start: number;
  end: number;
}

/** The reference span of a section, by section index, or undefined when it has none (specs/markdown-tool.md#section-addresses). */
export type SpanOf = (index: number) => LineSpan | undefined;

/** The ` [<n>]` suffix of a component, removed when an address has a line range (specs/markdown-tool.md#section-addresses). */
const COUNT_SUFFIX = / \[[0-9]+\]$/;

/** An address after stripping and splitting (specs/markdown-tool.md#section-addresses). */
export interface ParsedAddress {
  /** The value, trimmed. */
  trimmed: string;
  /** The value after stripping `* `, the line range, and the hidden count. */
  text: string;
  /** The stripped line range, when there was one. */
  range: LineSpan | undefined;
  /** The components of the text, each trimmed and then stripped of leading heading marks. */
  components: string[];
}

/** Parse an address value (specs/markdown-tool.md#section-addresses). */
export function parseAddress(value: string): ParsedAddress {
  const whole = value.trim();
  let text = whole.replace(/^\* /, "");
  let range: LineSpan | undefined;
  const span = /^([0-9]+)-([0-9]+) /.exec(text);
  if (span !== null) {
    range = { start: Number(span[1]), end: Number(span[2]) };
    text = text.slice(span[0].length);
  }
  text = text.replace(/ \(\+[0-9]+ hidden\)$/, "");
  const components = text
    .split(ADDRESS_SEPARATOR)
    .map((part) => part.trim().replace(/^#{1,6} /, ""));
  return { trimmed: whole, text, range, components };
}

/** The value without its line range, the rest as given (specs/markdown-tool.md#section-addresses). */
export function withoutLineRange(value: string): string {
  return value.trim().replace(/^(\* )?[0-9]+-[0-9]+ /, "$1");
}

/** The reference span of each section of a model: its own span. */
function ownSpan(model: DocModel): SpanOf {
  return (index) => {
    const section = model.sections[index];
    return section === undefined ? undefined : { start: section.start, end: section.end };
  };
}

/** A component after normalization of step 2 (specs/markdown-tool.md#section-addresses). */
export function normalizeComponent(text: string): string {
  const stripped = text.replace(/[`*_]/g, "");
  let collapsed = "";
  let space = false;
  for (const character of stripped) {
    if (character === " " || character === "\t") {
      space = true;
      continue;
    }
    if (space && collapsed !== "") collapsed += " ";
    space = false;
    collapsed += character;
  }
  return collapsed.toLowerCase();
}

/** What one address names (specs/markdown-tool.md#section-addresses). */
export interface AddressOutcome {
  /** The section the address names, when exactly one matches. */
  section: number | undefined;
  /** Every section that matched, in document order. */
  matches: number[];
  /** The step at which the match ran. */
  step: MatchStep | undefined;
}

/** The steps of specs/markdown-tool.md#section-addresses that match a component. */
export type MatchStep = 1 | 2 | 3 | 4;

/**
 * True when a section's component matches a component at `step` (specs/markdown-tool.md#section-addresses).
 * With a line range (`ranged`), the section's own component loses its ` [<n>]`.
 */
function componentMatches(
  section: DocSection,
  component: string,
  step: MatchStep,
  ranged: boolean,
): boolean {
  const title = ranged ? section.component.replace(COUNT_SUFFIX, "") : section.component;
  if (step === 1) return title === component;
  if (step === 2) return normalizeComponent(title) === normalizeComponent(component);
  const byPrefix =
    normalizeComponent(withoutNumberPrefix(title)) ===
    normalizeComponent(withoutNumberPrefix(component));
  if (byPrefix) return true;
  if (step === 3) return false;
  const number = numberOfComponent(component);
  if (number === undefined) return false;
  const own = parseNumberPrefix(section.text);
  return own !== undefined && sameComponents(own.components, number);
}

/** True when every component matches an ancestor, in order but not necessarily consecutively (specs/markdown-tool.md#section-addresses). */
function ancestorsMatch(
  model: DocModel,
  index: number,
  components: readonly string[],
  step: MatchStep,
): boolean {
  const ancestors = ancestorsOf(model, index);
  let position = 0;
  for (const component of components) {
    let found = false;
    while (position < ancestors.length) {
      const ancestor = ancestors[position];
      position += 1;
      if (ancestor !== undefined && componentMatches(ancestor, component, step, false)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/**
 * The sections an address names, in the three steps of specs/markdown-tool.md#section-addresses: the first
 * step that matches any section decides. `(preamble)` and `(document)` are not
 * addresses here; a caller handles them first.
 */
export function matchAddress(
  model: DocModel,
  value: string,
  spanOf: SpanOf = ownSpan(model),
): AddressOutcome {
  const parsed = parseAddress(value);
  const parts = parsed.components;
  const range = parsed.range;
  const last = parts[parts.length - 1] ?? "";
  const term = range === undefined ? last : last.replace(COUNT_SUFFIX, "");
  const others = parts.slice(0, -1);
  for (const step of [1, 2, 3, 4] as const) {
    const matches: number[] = [];
    for (const section of model.sections) {
      if (range !== undefined) {
        const span = spanOf(section.index);
        if (span === undefined || span.start !== range.start || span.end !== range.end) continue;
      }
      if (!componentMatches(section, term, step, range !== undefined)) continue;
      if (!ancestorsMatch(model, section.index, others, step)) continue;
      matches.push(section.index);
    }
    if (matches.length > 0) {
      return { section: matches.length === 1 ? matches[0] : undefined, matches, step };
    }
  }
  return { section: undefined, matches: [], step: undefined };
}

/** The full addresses of the first 5 sections similar to an address (specs/markdown-tool.md#section-addresses). */
export function similarAddresses(model: DocModel, value: string): string[] {
  const parts = parseAddress(value).components;
  const last = normalizeComponent(parts[parts.length - 1] ?? "");
  const similar: string[] = [];
  for (const section of model.sections) {
    if (!normalizeComponent(section.component).includes(last)) continue;
    similar.push(section.address);
    if (similar.length === 5) break;
  }
  return similar;
}

/**
 * The sections an address names, with the errors of specs/markdown-tool.md#section-addresses when it names
 * none or several. The error of a line range that spans no section lists the
 * sections the address without its range matches.
 */
export function resolveAddress(
  model: DocModel,
  value: string,
  path: string,
  spanOf: SpanOf = ownSpan(model),
): { index: number; step: MatchStep } | { error: string } {
  const shown = value.trim();
  const outcome = matchAddress(model, value, spanOf);
  if (outcome.section !== undefined && outcome.step !== undefined) {
    return { index: outcome.section, step: outcome.step };
  }
  if (outcome.matches.length > 1) {
    return { error: ambiguousMessage(model, shown, path, outcome.matches) };
  }
  if (parseAddress(value).range !== undefined) {
    const without = matchAddress(model, withoutLineRange(value));
    if (without.matches.length > 0) {
      return { error: rangedMessage(model, shown, path, without.matches, spanOf) };
    }
  }
  return { error: noSectionMessage(model, shown, path) };
}

/** The error text of an address with a line range that spans no section (specs/markdown-tool.md#section-addresses). */
function rangedMessage(
  model: DocModel,
  value: string,
  path: string,
  matches: readonly number[],
  spanOf: SpanOf,
): string {
  const shown: string[] = [];
  for (const index of matches.slice(0, 5)) {
    const section = model.sections[index];
    if (section === undefined) continue;
    const span = spanOf(index);
    shown.push(
      span === undefined
        ? `(new) ${section.address}`
        : `${span.start}-${span.end} ${section.address}`,
    );
  }
  return `no section "${value}" in ${path} spans that line range; without it the address matches: ${shown.join("; ")}. Run outline for current line ranges.`;
}

/** The error text of an address no section matches (specs/markdown-tool.md#section-addresses). */
export function noSectionMessage(model: DocModel, value: string, path: string): string {
  const similar = similarAddresses(model, value);
  if (similar.length > 0) {
    return `no section "${value}" in ${path}. Similar: ${similar.join("; ")}`;
  }
  return `no section "${value}" in ${path}. Run outline to list its sections.`;
}

/** The error text of an address several sections match (specs/markdown-tool.md#section-addresses). */
export function ambiguousMessage(
  model: DocModel,
  value: string,
  path: string,
  matches: readonly number[],
): string {
  const addresses: string[] = [];
  for (const index of matches.slice(0, 5)) {
    const section = model.sections[index];
    if (section !== undefined) addresses.push(section.address);
  }
  return `section "${value}" matches ${matches.length} sections in ${path}: ${addresses.join("; ")}. Put more of its path before it, joined by " > ".`;
}
