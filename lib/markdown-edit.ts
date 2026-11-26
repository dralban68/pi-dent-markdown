/**
 * The structural edits of specs/markdown-tool.md#action-edit: applying
 * operations to a file's lines (#edit-applying, #edit-line-rules), the operations
 * themselves (specs/markdown-tool.md#edit-operations), renumbering and auto-numbering (specs/markdown-tool.md#renumbering), and
 * the marks and report the result is built from (specs/markdown-tool.md#edit-result).
 *
 * The engine works on lines that carry an identity, so a heading line keeps its
 * identity through rewriting, re-placing, and renumbering: that is how a
 * section "persists" (specs/markdown-tool.md#renumbering) and how a mark stays with its line
 * (specs/markdown-tool.md#edit-result). After every operation the text is parsed again, and the
 * heading sequence the operation intended is compared with the one the text
 * holds (specs/markdown-tool.md#edit-operations, the last check).
 */

import {
  analyzeDocument,
  ancestorsOf,
  isBlank,
  isWithin,
  noSectionMessage,
  numberOfComponent,
  parseAddress,
  parseHeadings,
  parseNumberPrefix,
  resolveAddress,
  sameComponents,
  stripAddress,
  type DocModel,
  type LineSpan,
  type MatchStep,
  type DocSection,
  type HeadingInfo,
  type NumberPrefix,
  type TextLine,
} from "./markdown-document.ts";

// ---------------------------------------------------------------------------
// The validated call
// ---------------------------------------------------------------------------

/** The operations of specs/markdown-tool.md#edit-operations. */
export type OperationName =
  | "replace"
  | "replace_body"
  | "insert"
  | "delete"
  | "move"
  | "rename"
  | "set_level";

/** The positions of specs/markdown-tool.md#edit-operations. */
export type OperationPosition = "before" | "after" | "first" | "last";

/** The content block of specs/markdown-tool.md#edit-line-rules: its lines, and how many blank lines `content` held before them. */
export interface ContentBlock {
  lines: string[];
  offset: number;
}

/** One validated operation of an `edit` call. */
export interface Operation {
  op: OperationName;
  section: string | undefined;
  position: OperationPosition | undefined;
  at: string | undefined;
  heading: string | undefined;
  level: number | undefined;
  block: ContentBlock;
}

/** A touched section of the report (specs/markdown-tool.md#edit-result). */
export interface TouchedSection {
  address: string;
  level: number;
  start: number;
  end: number;
}

/** A removed section of the report (specs/markdown-tool.md#edit-result). */
export interface RemovedSection {
  start: number;
  end: number;
  level: number;
  text: string;
  subsections: number;
}

/** A renumbered heading of the report (specs/markdown-tool.md#edit-result). */
export interface RenumberedHeading {
  start: number;
  level: number;
  from: string;
  to: string;
}

/** A skipped group of the report (specs/markdown-tool.md#edit-result). */
export interface SkippedGroup {
  parent: string;
  numbers: string[];
}

/** The report of an `edit` call, before the tool adds the path and the revisions. */
export interface EditOutcome {
  /** The text the call wrote, without a leading U+FEFF. */
  text: string;
  /** The result's line count. */
  lineCount: number;
  /** Whether the call changed the text. */
  changed: boolean;
  touched: TouchedSection[];
  /** The entry lines of the touched sections and their ancestors, in document order (specs/markdown-tool.md#edit-result). */
  listed: string[];
  removed: RemovedSection[];
  renumbered: RenumberedHeading[];
  skipped: SkippedGroup[];
}

/** What applying an `edit` call gave: the report, or the error text of the first failing check. */
export type EditResult = { kind: "ok"; outcome: EditOutcome } | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Lines with identity
// ---------------------------------------------------------------------------

/** A line of the working text: its identity, its characters, and its line ending. */
export interface EditLine {
  id: number;
  text: string;
  ending: string;
}

/** A line offered to a placement, before it has an identity: content lines have none. */
interface SourceLine {
  text: string;
  ending: string | undefined;
  id: number | undefined;
}

/** A line after fitting (specs/markdown-tool.md#edit-line-rules), with the heading it holds when it is a heading line. */
interface OutLine {
  text: string;
  ending: string | undefined;
  id: number | undefined;
  heading: { level: number; text: string } | undefined;
}

/** The heading a heading line holds, as the call intends it (specs/markdown-tool.md#edit-operations, the last check). */
interface ExpectedHeading {
  level: number;
  text: string;
}

/** The state of one `edit` call, carried from operation to operation. */
interface Work {
  lines: EditLine[];
  nextId: number;
  defaultEnding: string;
  lastHadEnding: boolean;
  wasEmpty: boolean;
  /** The line identities that bear a mark (specs/markdown-tool.md#edit-result). */
  marks: Set<number>;
  /** The heading each heading line should hold after the operations so far (specs/markdown-tool.md#edit-operations). */
  expected: Map<number, ExpectedHeading>;
  /** The heading text a renumbering gave a line, and the operation that did (specs/markdown-tool.md#section-addresses). */
  renumberedText: Map<number, { text: string; op: number }>;
  /** The heading text a heading of the call's content was written with (specs/markdown-tool.md#edit-result). */
  writtenText: Map<number, string>;
  /** The sections of the file before the call, by heading line identity (specs/markdown-tool.md#edit-result). */
  originalHeadings: Map<
    number,
    { level: number; text: string; start: number; end: number; subsections: number }
  >;
  /** The order of the file's headings before the call (specs/markdown-tool.md#edit-result). */
  originalOrder: number[];
  /** The base of the last operation that affected each group, and whether it renumbered it (specs/markdown-tool.md#edit-result). */
  groups: Map<string, { base: number; renumbered: boolean }>;
}

/** The line identity at a 1-based line number, or undefined. */
function idAt(lines: readonly EditLine[], line: number): number | undefined {
  return lines[line - 1]?.id;
}

/** The heading line identity of each section of a model, by section index. */
function identities(lines: readonly EditLine[], model: DocModel): Map<number, number> {
  const map = new Map<number, number>();
  for (const section of model.sections) {
    const identity = idAt(lines, section.headingStart);
    if (identity !== undefined) map.set(section.index, identity);
  }
  return map;
}

/** The section index of each heading line identity, by identity. */
function byIdentity(indexes: ReadonlyMap<number, number>): Map<number, number> {
  const map = new Map<number, number>();
  for (const [index, identity] of indexes) map.set(identity, index);
  return map;
}

/** A blank line holding the file's line ending (specs/markdown-tool.md#edit-line-rules). */
function blankLine(work: Work): EditLine {
  return { id: work.nextId++, text: "", ending: work.defaultEnding };
}

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#edit-line-rules: fitting and placing
// ---------------------------------------------------------------------------

/** The lines of a `content` block, each taking the file's line ending when placed. */
function blockSource(lines: readonly string[]): SourceLine[] {
  return lines.map((text) => ({ text, ending: undefined, id: undefined }));
}

/** The lines of a span of the working text, keeping their identities and endings. */
function spanSource(lines: readonly EditLine[], start: number, end: number): SourceLine[] {
  const source: SourceLine[] = [];
  for (let line = start; line <= end; line += 1) {
    const found = lines[line - 1];
    if (found === undefined) continue;
    source.push({ text: found.text, ending: found.ending, id: found.id });
  }
  return source;
}

/**
 * Fit a block to a level (specs/markdown-tool.md#edit-line-rules): parse it alone and add the difference
 * between the destination level and its first heading's level to each of its
 * headings. A heading whose level changes is rewritten; `undefined` leaves every
 * level as it is.
 */
function fitLines(source: readonly SourceLine[], destination?: number): OutLine[] {
  const texts = source.map((line) => line.text);
  const headings = parseHeadings(texts);
  const first = headings[0];
  const shift = destination === undefined || first === undefined ? 0 : destination - first.level;
  const byLine = new Map<number, HeadingInfo>();
  for (const heading of headings) byLine.set(heading.start, heading);
  const out: OutLine[] = [];
  let index = 0;
  while (index < source.length) {
    const line = source[index];
    if (line === undefined) break;
    const heading = byLine.get(index + 1);
    if (heading === undefined) {
      out.push({ text: line.text, ending: line.ending, id: line.id, heading: undefined });
      index += 1;
      continue;
    }
    const level = heading.level + shift;
    if (level === heading.level) {
      out.push({
        text: line.text,
        ending: line.ending,
        id: line.id,
        heading: { level, text: heading.text },
      });
      index += 1;
      continue;
    }
    if (heading.atx) {
      const rewritten =
        line.text.slice(0, heading.openStart) +
        "#".repeat(level) +
        line.text.slice(heading.openStart + heading.level);
      out.push({
        text: rewritten,
        ending: line.ending,
        id: line.id,
        heading: { level, text: heading.text },
      });
      index += 1;
      continue;
    }
    const last = source[heading.end - 1];
    out.push({
      text: `${"#".repeat(level)} ${heading.text}`,
      ending: last === undefined ? undefined : last.ending,
      id: line.id,
      heading: { level, text: heading.text },
    });
    index = heading.end;
  }
  return out;
}

/** The greatest level fitting gives a block, or undefined when it has no heading (specs/markdown-tool.md#edit-operations). */
function greatestFittedLevel(
  source: readonly SourceLine[],
  destination?: number,
): number | undefined {
  let greatest: number | undefined;
  for (const line of fitLines(source, destination)) {
    const heading = line.heading;
    if (heading === undefined) continue;
    if (greatest === undefined || heading.level > greatest) greatest = heading.level;
  }
  return greatest;
}

/** A placed block: the new lines, the block's lines, and the headings the call wrote. */
interface Placement {
  lines: EditLine[];
  placed: EditLine[];
  writtenIds: Set<number>;
}

/**
 * Place a block at a 0-based index (specs/markdown-tool.md#edit-line-rules): insert its lines there, then
 * one empty line before it when the line before is not blank, and one empty line
 * after it when the line after is not blank.
 */
function placeBlock(
  work: Work,
  lines: readonly EditLine[],
  at: number,
  block: readonly OutLine[],
): Placement {
  if (block.length === 0) return { lines: [...lines], placed: [], writtenIds: new Set() };
  const placed: EditLine[] = [];
  const writtenIds = new Set<number>();
  const editLines: EditLine[] = [];
  for (const line of block) {
    const identity = line.id === undefined ? work.nextId++ : line.id;
    const edit: EditLine = {
      id: identity,
      text: line.text,
      ending: line.ending ?? work.defaultEnding,
    };
    if (line.heading !== undefined) {
      work.expected.set(identity, { level: line.heading.level, text: line.heading.text });
      if (line.id === undefined) {
        work.writtenText.set(identity, line.heading.text);
        writtenIds.add(identity);
      }
    }
    placed.push(edit);
    editLines.push(edit);
  }
  const out = [...lines.slice(0, at), ...editLines, ...lines.slice(at)];
  let start = at;
  let end = at + editLines.length - 1;
  const beforeLine = out[start - 1];
  if (beforeLine !== undefined && !isBlank(beforeLine.text)) {
    out.splice(start, 0, blankLine(work));
    start += 1;
    end += 1;
  }
  const afterLine = out[end + 1];
  if (afterLine !== undefined && !isBlank(afterLine.text)) out.splice(end + 1, 0, blankLine(work));
  return { lines: out, placed, writtenIds };
}

/**
 * Remove a range of lines (specs/markdown-tool.md#edit-line-rules): the lines and every blank line directly
 * after them; when no line remains after those, also every blank line directly
 * before them; and one empty line between the lines that end up on either side
 * when both exist and are not blank.
 */
function removeRange(work: Work, lines: readonly EditLine[], from: number, to: number): EditLine[] {
  let start = from - 1;
  let end = to - 1;
  while (end + 1 < lines.length) {
    const next = lines[end + 1];
    if (next === undefined || !isBlank(next.text)) break;
    end += 1;
  }
  if (end === lines.length - 1) {
    while (start - 1 >= 0) {
      const previous = lines[start - 1];
      if (previous === undefined || !isBlank(previous.text)) break;
      start -= 1;
    }
  }
  const out = [...lines.slice(0, start), ...lines.slice(end + 1)];
  const before = out[start - 1];
  const after = out[start];
  if (
    before !== undefined &&
    after !== undefined &&
    !isBlank(before.text) &&
    !isBlank(after.text)
  ) {
    out.splice(start, 0, blankLine(work));
  }
  return out;
}

/** Replace a range of lines by a block: remove only those lines, and place the block where they were (specs/markdown-tool.md#edit-line-rules). */
function replaceRange(
  work: Work,
  lines: readonly EditLine[],
  from: number,
  to: number,
  block: readonly OutLine[],
): Placement {
  const kept = [...lines.slice(0, from - 1), ...lines.slice(to)];
  return placeBlock(work, kept, from - 1, block);
}

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#edit-applying: line endings
// ---------------------------------------------------------------------------

/**
 * The line-ending rule of specs/markdown-tool.md#edit-applying: a line that is no longer last takes the
 * file's line ending when it has none, and the result's last line ends with a
 * line ending exactly when the file's last line did or the file was empty.
 */
function normalizeEndings(work: Work): void {
  const count = work.lines.length;
  for (let index = 0; index < count; index += 1) {
    const line = work.lines[index];
    if (line === undefined) continue;
    if (index < count - 1) {
      if (line.ending === "") line.ending = work.defaultEnding;
      continue;
    }
    if (work.wasEmpty || work.lastHadEnding) {
      if (line.ending === "") line.ending = work.defaultEnding;
      continue;
    }
    line.ending = "";
  }
}

// ---------------------------------------------------------------------------
// Addresses of an operation
// ---------------------------------------------------------------------------

/** What an operation's address names (specs/markdown-tool.md#section-addresses). */
interface AddressResolution {
  section: number | undefined;
  preamble: boolean;
}

/** The error text of an address, with the operation prefix the caller adds. */
interface AddressFailure {
  error: string;
}

/**
 * The reference span of a section of the text an operation runs on (specs/markdown-tool.md#section-addresses):
 * its span in the file before the call, when its heading persists from there,
 * or undefined when the call wrote it.
 */
function referenceSpan(work: Work, model: DocModel, index: number): LineSpan | undefined {
  const section = model.sections[index];
  if (section === undefined) return;
  const identity = idAt(work.lines, section.headingStart);
  const heading = identity === undefined ? undefined : work.originalHeadings.get(identity);
  if (heading === undefined) return;
  return { start: heading.start, end: heading.end };
}

/**
 * Resolve an operation's address against the text the operation runs on
 * (#section-addresses, #edit-applying), including the rejection of an address that names a
 * section an earlier operation renumbered onto a heading text of the file.
 */
function resolveOperationAddress(
  work: Work,
  model: DocModel,
  value: string,
  path: string,
): AddressResolution | AddressFailure {
  if (stripAddress(value) === "(preamble)") return { section: undefined, preamble: true };
  const resolved = resolveAddress(model, value, path, (index) => referenceSpan(work, model, index));
  if ("error" in resolved) return resolved;
  const index = resolved.index;
  const section = model.sections[index];
  if (section === undefined) return { error: noSectionMessage(model, value, path) };
  const identity = idAt(work.lines, section.headingStart);
  const record = identity === undefined ? undefined : work.renumberedText.get(identity);
  // A line range names a section of the file before the call, so renumbering cannot redirect it (specs/markdown-tool.md#section-addresses).
  const ranged = parseAddress(value).range !== undefined;
  if (
    record !== undefined &&
    !ranged &&
    collidesOnRenumbering(work, resolved.step, value, section, identity)
  ) {
    return {
      error: `"${value}" now names ${section.address}, renumbered by operation ${record.op}; name it without its number, with an ancestor if needed`,
    };
  }
  return { section: index, preamble: false };
}

/**
 * True when an address that resolves to a section renumbered by an earlier
 * operation of the call names a heading of the file before the call as well
 * (specs/markdown-tool.md#edit-applying): by the heading text at steps 1 and 2, and by the number when
 * the address's last component is a number component resolved at step 4.
 */
function collidesOnRenumbering(
  work: Work,
  step: MatchStep | undefined,
  value: string,
  section: DocSection,
  identity: number | undefined,
): boolean {
  const parts = parseAddress(value).components;
  const last = parts[parts.length - 1] ?? "";
  const byText = step === 1 || step === 2;
  const byNumber = step === 4 && numberOfComponent(last) !== undefined;
  const own = parseNumberPrefix(section.text);
  for (const id of work.originalOrder) {
    if (id === identity) continue;
    const heading = work.originalHeadings.get(id);
    if (heading === undefined) continue;
    if (byText && heading.text === section.text) return true;
    if (!byNumber || own === undefined) continue;
    const other = parseNumberPrefix(heading.text);
    if (other !== undefined && sameComponents(other.components, own.components)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#edit-operations: destinations
// ---------------------------------------------------------------------------

/** Where an `insert` or a `move` places its block, and the level fitting uses. */
interface Destination {
  /** The 0-based index the block is placed at. */
  at: number;
  /** The destination level, or undefined when levels are unchanged. */
  level: number | undefined;
}

/** The destination of an `insert` or a `move` (specs/markdown-tool.md#edit-operations). */
function destinationOf(
  model: DocModel,
  lines: readonly EditLine[],
  position: OperationPosition,
  at: number | undefined,
  document: boolean,
): Destination {
  if (document) {
    if (position === "first") {
      const first = model.sections[0];
      return { at: first === undefined ? lines.length : first.headingStart - 1, level: undefined };
    }
    return { at: lines.length, level: undefined };
  }
  const section = at === undefined ? undefined : model.sections[at];
  if (section === undefined) return { at: lines.length, level: undefined };
  if (position === "before") return { at: section.headingStart - 1, level: section.level };
  if (position === "after") return { at: section.end, level: section.level };
  if (position === "first") {
    const after = section.bodyEnd === undefined ? section.headingEnd : section.bodyEnd;
    return { at: after, level: section.level + 1 };
  }
  return { at: section.end, level: section.level + 1 };
}

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#edit-operations: rewriting a heading text
// ---------------------------------------------------------------------------

/** The parts of an ATX heading line, recomputed after a rewrite ([CommonMark], Section 4.2). */
function atxRegion(
  line: string,
): { openStart: number; contentStart: number; contentEnd: number } | undefined {
  const opening = /^( {0,3})(#{1,6})(?:[ \t]+|$)/.exec(line);
  if (opening === null) return;
  const openStart = (opening[1] ?? "").length;
  const contentStart = opening[0].length;
  const rest = line.slice(contentStart);
  let contentEnd = contentStart;
  if (!/^[ \t]*#+[ \t]*$/.test(rest)) {
    const tail = /[ \t]+#+[ \t]*$/.exec(rest);
    contentEnd = contentStart + (tail === null ? rest.length : tail.index);
  }
  while (contentEnd > contentStart) {
    const character = line[contentEnd - 1];
    if (character !== " " && character !== "\t") break;
    contentEnd -= 1;
  }
  return { openStart, contentStart, contentEnd };
}

/**
 * Write a number prefix into a heading (specs/markdown-tool.md#renumbering): `replace` puts it in place
 * of the member's prefix, `prepend` puts it and one space before the first
 * character of its heading text. Returns the heading text the write gives it.
 */
function writeNumber(
  work: Work,
  section: DocSection,
  identity: number,
  prefix: string,
  mode: "replace" | "prepend",
  opIndex: number,
): string {
  const index = work.lines.findIndex((candidate) => candidate.id === identity);
  const line = work.lines[index];
  const current = section.text;
  const number = parseNumberPrefix(current);
  const skip = number === undefined ? 0 : number.length;
  const next = mode === "prepend" ? `${prefix} ${current}` : prefix + current.slice(skip);
  if (line === undefined || next === current) return next;
  if (section.heading.atx) {
    const region = atxRegion(line.text);
    if (region !== undefined) {
      const head = line.text.slice(0, region.contentStart);
      const tail = line.text.slice(region.contentEnd);
      const middle = line.text.slice(region.contentStart, region.contentEnd);
      const inserted = mode === "prepend" ? `${prefix} ${middle}` : prefix + middle.slice(skip);
      line.text = head + inserted + tail;
    }
  } else {
    // A setext heading whose prefix changes is rewritten as fitting rewrites it (specs/markdown-tool.md#edit-line-rules):
    // one ATX line at its level, since the written prefix can make its content a list item.
    const span = section.headingEnd - section.headingStart + 1;
    const last = work.lines[index + span - 1];
    work.lines.splice(index, span, {
      id: identity,
      text: `${"#".repeat(section.level)} ${next}`,
      ending: last === undefined ? line.ending : last.ending,
    });
  }
  work.renumberedText.set(identity, { text: next, op: opIndex });
  work.expected.set(identity, { level: section.level, text: next });
  return next;
}

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#renumbering: renumbering
// ---------------------------------------------------------------------------

/** A group of specs/markdown-tool.md#renumbering: the subsections of one section, or the top-level sections. */
interface GroupPlan {
  /** `top`, or `p<parent line identity>`. */
  key: string;
  /** The parent's index in the text after the operation, or undefined for the top-level group. */
  parent: number | undefined;
  rule: 1 | 2 | 3;
  /** Its numbered members before the operation, with their numbers then (rule 2: as written). */
  base: NumberPrefix[];
  /** The parent's number before the operation, or as written for rule 2. */
  parentBase: number[] | undefined;
}

/** What renumbering one group does (specs/markdown-tool.md#renumbering). */
interface Decision {
  renumber: boolean;
  /** The leading components, or undefined for none. */
  leading: number[] | undefined;
  start: number;
  trailingDot: boolean;
}

const NOT_RENUMBERED: Decision = {
  renumber: false,
  leading: undefined,
  start: 1,
  trailingDot: false,
};

/** The leading components of a number: all but its last. */
function leadingOf(number: NumberPrefix): number[] {
  return number.components.slice(0, -1);
}

/** The last component of a number. */
function lastOf(number: NumberPrefix): number {
  return number.components[number.components.length - 1] ?? 0;
}

/** Whether a group is renumbered, and with which leading components and start (specs/markdown-tool.md#renumbering). */
function decideGroup(group: GroupPlan, parentNow: NumberPrefix | undefined): Decision {
  const base = group.base;
  if (group.rule === 2) {
    if (parentNow === undefined) return NOT_RENUMBERED;
    const firstNumber = base[0];
    if (firstNumber !== undefined) {
      const leading = leadingOf(firstNumber);
      for (const number of base) {
        if (!sameComponents(leadingOf(number), leading)) return NOT_RENUMBERED;
      }
    }
    if (firstNumber === undefined) {
      return { renumber: true, leading: parentNow.components, start: 1, trailingDot: false };
    }
    const last = lastOf(firstNumber);
    const start = last === 0 || last === 1 ? last : 1;
    const leading = leadingOf(firstNumber);
    if (leading.length === 0) {
      return { renumber: true, leading: undefined, start, trailingDot: firstNumber.trailingDot };
    }
    return {
      renumber: true,
      leading: parentNow.components,
      start,
      trailingDot: firstNumber.trailingDot,
    };
  }
  if (base.length === 0) {
    if (group.parent === undefined) return NOT_RENUMBERED;
    if (parentNow === undefined) return NOT_RENUMBERED;
    return { renumber: true, leading: parentNow.components, start: 1, trailingDot: false };
  }
  const firstNumber = base[0];
  if (firstNumber === undefined) return NOT_RENUMBERED;
  const leading = leadingOf(firstNumber);
  for (const number of base) {
    if (!sameComponents(leadingOf(number), leading)) return NOT_RENUMBERED;
  }
  if (leading.length > 0) {
    if (group.parent === undefined) return NOT_RENUMBERED;
    if (group.parentBase === undefined) return NOT_RENUMBERED;
    if (!sameComponents(leading, group.parentBase)) return NOT_RENUMBERED;
  }
  const first = lastOf(firstNumber);
  if (first !== 0 && first !== 1) return NOT_RENUMBERED;
  for (let index = 1; index < base.length; index += 1) {
    const number = base[index];
    if (number === undefined || lastOf(number) !== first + index) return NOT_RENUMBERED;
  }
  if (leading.length === 0) {
    return {
      renumber: true,
      leading: undefined,
      start: first,
      trailingDot: firstNumber.trailingDot,
    };
  }
  if (parentNow === undefined) return NOT_RENUMBERED;
  return {
    renumber: true,
    leading: parentNow.components,
    start: first,
    trailingDot: firstNumber.trailingDot,
  };
}

/** The members of a group after the operation: its subsections, or the top-level sections. */
function membersOf(model: DocModel, parent?: number): number[] {
  if (parent === undefined) {
    const top: number[] = [];
    for (const section of model.sections) {
      if (section.parent === undefined) top.push(section.index);
    }
    return top;
  }
  const section = model.sections[parent];
  return section === undefined ? [] : [...section.children];
}

/** The group key of a group whose parent is a section of the text after the operation. */
function groupKeyOf(
  lines: readonly EditLine[],
  model: DocModel,
  parent: number | undefined,
): string {
  if (parent === undefined) return "top";
  const section = model.sections[parent];
  const identity = section === undefined ? undefined : idAt(lines, section.headingStart);
  return identity === undefined ? "top" : `p${identity}`;
}

/** The numbers of the numbered members of a set of sections, in document order. */
function numbersOf(model: DocModel, indexes: readonly number[]): NumberPrefix[] {
  const numbers: NumberPrefix[] = [];
  for (const index of indexes) {
    const section = model.sections[index];
    if (section === undefined) continue;
    const number = parseNumberPrefix(section.text);
    if (number !== undefined) numbers.push(number);
  }
  return numbers;
}

/**
 * Renumber the affected groups of one operation (specs/markdown-tool.md#renumbering), from the top
 * down, adding each group whose parent's number the renumbering changes.
 */
function renumberGroups(
  work: Work,
  before: DocModel,
  after: DocModel,
  beforeIdentities: ReadonlyMap<number, number>,
  writtenIds: ReadonlySet<number>,
  autoCandidate: number | undefined,
  opIndex: number,
): void {
  const beforeByLine = byIdentity(beforeIdentities);
  const postIdentities = identities(work.lines, after);
  const queue: GroupPlan[] = [];
  const planned = new Set<string>();

  const addRule1 = (parent?: number): void => {
    const key = groupKeyOf(work.lines, after, parent);
    if (planned.has(key)) return;
    const parentSection = parent === undefined ? undefined : after.sections[parent];
    const parentIdentity =
      parentSection === undefined ? undefined : postIdentities.get(parentSection.index);
    if (parentIdentity !== undefined && writtenIds.has(parentIdentity)) return;
    const beforeParent =
      parentIdentity === undefined ? undefined : beforeByLine.get(parentIdentity);
    const beforeMembers =
      parent === undefined
        ? membersOf(before)
        : beforeParent === undefined
          ? []
          : membersOf(before, beforeParent);
    const afterMembers = membersOf(after, parent);
    const beforeSequence: number[] = [];
    for (const index of beforeMembers) {
      const identity = beforeIdentities.get(index);
      if (identity !== undefined) beforeSequence.push(identity);
    }
    const afterSequence: number[] = [];
    for (const index of afterMembers) {
      const identity = postIdentities.get(index);
      if (identity !== undefined) afterSequence.push(identity);
    }
    if (beforeSequence.length === afterSequence.length) {
      let same = true;
      for (let position = 0; position < beforeSequence.length; position += 1) {
        if (beforeSequence[position] !== afterSequence[position]) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    const base = numbersOf(before, beforeMembers);
    const parentBase =
      beforeParent === undefined
        ? undefined
        : parseNumberPrefix(before.sections[beforeParent]?.text ?? "")?.components;
    planned.add(key);
    queue.push({ key, parent, rule: 1, base, parentBase });
  };

  const addRule2 = (parent: number): void => {
    const key = groupKeyOf(work.lines, after, parent);
    if (planned.has(key)) return;
    const members = membersOf(after, parent);
    if (members.length === 0) return;
    const parentSection = after.sections[parent];
    planned.add(key);
    queue.push({
      key,
      parent,
      rule: 2,
      base: numbersOf(after, members),
      parentBase:
        parentSection === undefined ? undefined : parseNumberPrefix(parentSection.text)?.components,
    });
  };

  addRule1();
  for (const section of after.sections) {
    const identity = postIdentities.get(section.index);
    if (identity !== undefined && writtenIds.has(identity)) {
      addRule2(section.index);
      continue;
    }
    addRule1(section.index);
  }

  const ordered = (plans: readonly GroupPlan[]): GroupPlan[] =>
    plans.toSorted((left, right) => {
      const leftParent = left.parent === undefined ? undefined : after.sections[left.parent];
      const rightParent = right.parent === undefined ? undefined : after.sections[right.parent];
      if (leftParent === undefined) return rightParent === undefined ? 0 : -1;
      if (rightParent === undefined) return 1;
      if (leftParent.level !== rightParent.level) return leftParent.level - rightParent.level;
      return leftParent.start - rightParent.start;
    });

  const pending = ordered(queue);
  const currentText = new Map<number, string>();
  for (const section of after.sections) currentText.set(section.index, section.text);
  const autoNumbered = new Set<number>();
  const numberNow = (index: number): NumberPrefix | undefined =>
    parseNumberPrefix(currentText.get(index) ?? "");

  while (pending.length > 0) {
    const group = pending.shift();
    if (group === undefined) break;
    const parentNow = group.parent === undefined ? undefined : numberNow(group.parent);
    const decision = decideGroup(group, parentNow);
    const members = membersOf(after, group.parent);
    if (decision.renumber) {
      if (group.parent !== undefined && autoNumbered.has(group.parent)) {
        const numbered = members.some((index) => numberNow(index) !== undefined);
        if (!numbered) for (const index of members) autoNumbered.add(index);
      }
      if (autoCandidate !== undefined && group.base.length > 0) {
        for (const index of members) {
          if (postIdentities.get(index) !== autoCandidate) continue;
          if (numberNow(index) !== undefined) break;
          if ((currentText.get(index) ?? "") === "") break;
          autoNumbered.add(index);
          break;
        }
      }
      const numbersBefore = members.map((index) => numberNow(index));
      let position = 0;
      for (const index of members) {
        const number = numberNow(index);
        const automatic = autoNumbered.has(index);
        if (number === undefined && !automatic) continue;
        const component = decision.start + position;
        const value =
          decision.leading === undefined ? [component] : [...decision.leading, component];
        const trailing =
          group.base.length > 0
            ? decision.trailingDot
            : decision.leading === undefined && number !== undefined && number.trailingDot;
        const prefix = `${value.join(".")}${trailing ? "." : ""}`;
        const section = after.sections[index];
        const identity = postIdentities.get(index);
        if (section !== undefined && identity !== undefined) {
          currentText.set(
            index,
            writeNumber(
              work,
              section,
              identity,
              prefix,
              automatic ? "prepend" : "replace",
              opIndex,
            ),
          );
        }
        position += 1;
      }
      work.groups.set(group.key, { base: group.base.length, renumbered: true });
      for (let slot = 0; slot < members.length; slot += 1) {
        const index = members[slot];
        if (index === undefined) continue;
        const number = numberNow(index);
        const earlier = numbersBefore[slot];
        if (number === undefined) continue;
        if (earlier === undefined && !autoNumbered.has(index)) continue;
        if (earlier !== undefined && sameComponents(number.components, earlier.components))
          continue;
        const children = after.sections[index]?.children ?? [];
        if (children.length === 0) continue;
        const parentIdentity = postIdentities.get(index);
        if (parentIdentity === undefined) continue;
        const key = `p${parentIdentity}`;
        if (planned.has(key)) continue;
        planned.add(key);
        const parentSection = after.sections[index];
        const base: NumberPrefix[] = [];
        for (const child of children) {
          const childIdentity = postIdentities.get(child);
          const beforeChild =
            childIdentity === undefined ? undefined : beforeByLine.get(childIdentity);
          const childNumber =
            beforeChild === undefined
              ? parseNumberPrefix(after.sections[child]?.text ?? "")
              : parseNumberPrefix(before.sections[beforeChild]?.text ?? "");
          if (childNumber !== undefined) base.push(childNumber);
        }
        pending.push({
          key,
          parent: index,
          rule: autoNumbered.has(index) ? 2 : 3,
          base,
          parentBase:
            parentSection === undefined
              ? undefined
              : parseNumberPrefix(parentSection.text)?.components,
        });
        const sorted = ordered(pending);
        pending.length = 0;
        pending.push(...sorted);
      }
      continue;
    }
    work.groups.set(group.key, { base: group.base.length, renumbered: false });
  }
}

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#edit-operations: the operations
// ---------------------------------------------------------------------------

/** The heading text a rename writes (specs/markdown-tool.md#edit-operations). */
function renameText(section: DocSection, heading: string): string {
  const existing = parseNumberPrefix(section.text);
  const given = parseNumberPrefix(heading);
  if (existing === undefined || given !== undefined) return heading;
  const rest = section.text.slice(existing.length);
  let spaces = "";
  for (const character of rest) {
    if (character !== " " && character !== "\t") break;
    spaces += character;
  }
  return existing.prefix + spaces + heading;
}

/** Write a rename's heading text into a section's heading (specs/markdown-tool.md#edit-operations). */
function writeHeadingText(work: Work, section: DocSection, text: string): void {
  const line = work.lines[section.headingStart - 1];
  if (line === undefined) return;
  if (section.heading.atx) {
    const region = atxRegion(line.text);
    if (region === undefined) return;
    if (region.contentStart === region.contentEnd) {
      line.text = `${line.text.slice(0, section.heading.openStart)}${"#".repeat(section.level)} ${text}`;
    } else {
      line.text =
        line.text.slice(0, region.contentStart) + text + line.text.slice(region.contentEnd);
    }
    work.expected.set(line.id, { level: section.level, text });
    return;
  }
  const count = section.headingEnd - section.headingStart;
  const lastContent = work.lines[section.headingEnd - 2];
  const replacement: EditLine = {
    id: line.id,
    text,
    ending: lastContent === undefined ? line.ending : lastContent.ending,
  };
  work.lines.splice(section.headingStart - 1, count, replacement);
  work.expected.set(line.id, { level: section.level, text });
}

/** One operation's structural effect, before renumbering. */
interface Structural {
  /** The heading line identity whose text the operation wrote by renaming. */
  renamed: number | undefined;
  /** The heading text a rename wrote, as given. */
  renameGiven: string | undefined;
  /** The heading line identity auto-numbering may number (specs/markdown-tool.md#renumbering). */
  autoCandidate: number | undefined;
  /** The headings the operation wrote (specs/markdown-tool.md#renumbering). */
  writtenIds: Set<number>;
}

/** An empty structural effect. */
function noEffect(): Structural {
  return {
    renamed: undefined,
    renameGiven: undefined,
    autoCandidate: undefined,
    writtenIds: new Set(),
  };
}

/** Apply one operation's structural effect to the working lines (#edit-line-rules, #edit-operations). */
function structurally(
  work: Work,
  before: DocModel,
  op: Operation,
  index: number,
  sectionIndex: number | undefined,
  preamble: boolean,
  atIndex: number | undefined,
  document: boolean,
  beforeIdentities: ReadonlyMap<number, number>,
): Structural | { error: string } {
  const prefix = `operations[${index}]: `;
  const section = sectionIndex === undefined ? undefined : before.sections[sectionIndex];

  if (op.op === "replace" || op.op === "insert") {
    if (op.op === "replace" && section === undefined) return noEffect();
    const destination: Destination =
      op.op === "replace" && section !== undefined
        ? { at: section.start - 1, level: section.level }
        : destinationOf(before, work.lines, op.position ?? "after", atIndex, document);
    const source = blockSource(op.block.lines);
    const greatest = greatestFittedLevel(source, destination.level);
    if (greatest !== undefined && greatest > 6) {
      return {
        error: `${prefix}the section would need heading level ${greatest}; levels stop at 6`,
      };
    }
    const fitted = fitLines(source, destination.level);
    const placement =
      op.op === "replace" && section !== undefined
        ? replaceRange(work, work.lines, section.start, section.end, fitted)
        : placeBlock(work, work.lines, destination.at, fitted);
    work.lines = placement.lines;
    let firstWritten: number | undefined;
    for (const line of placement.placed) {
      if (!placement.writtenIds.has(line.id)) continue;
      firstWritten = line.id;
      break;
    }
    if (firstWritten !== undefined) work.marks.add(firstWritten);
    const numbered = section === undefined ? false : parseNumberPrefix(section.text) !== undefined;
    const candidate = op.op === "replace" && !numbered ? undefined : firstWritten;
    return {
      renamed: undefined,
      renameGiven: undefined,
      autoCandidate: candidate,
      writtenIds: placement.writtenIds,
    };
  }

  if (op.op === "delete") {
    if (section === undefined) return noEffect();
    work.lines = removeRange(work, work.lines, section.start, section.end);
    const parentIdentity =
      section.parent === undefined ? undefined : beforeIdentities.get(section.parent);
    if (parentIdentity !== undefined) work.marks.add(parentIdentity);
    return noEffect();
  }

  if (op.op === "move") {
    if (section === undefined) return noEffect();
    const headingId = idAt(work.lines, section.headingStart);
    const source = spanSource(work.lines, section.start, section.end);
    const atIdentity = atIndex === undefined ? undefined : beforeIdentities.get(atIndex);
    const beforeParentIdentity =
      section.parent === undefined ? undefined : beforeIdentities.get(section.parent);
    work.lines = removeRange(work, work.lines, section.start, section.end);
    const mid = analyzeDocument(work.lines);
    let midIndex: number | undefined;
    for (const candidate of mid.sections) {
      if (idAt(work.lines, candidate.headingStart) !== atIdentity) continue;
      midIndex = candidate.index;
      break;
    }
    const destination = destinationOf(mid, work.lines, op.position ?? "after", midIndex, document);
    const greatest = greatestFittedLevel(source, destination.level);
    if (greatest !== undefined && greatest > 6) {
      return {
        error: `${prefix}the section would need heading level ${greatest}; levels stop at 6`,
      };
    }
    const fitted = fitLines(source, destination.level);
    const placement = placeBlock(work, work.lines, destination.at, fitted);
    work.lines = placement.lines;
    for (const line of placement.placed) {
      if (line.id !== headingId) continue;
      work.marks.add(line.id);
      break;
    }
    const after = analyzeDocument(work.lines);
    let movedIndex: number | undefined;
    for (const candidate of after.sections) {
      if (idAt(work.lines, candidate.headingStart) !== headingId) continue;
      movedIndex = candidate.index;
      break;
    }
    const movedParent = movedIndex === undefined ? undefined : after.sections[movedIndex]?.parent;
    const afterParentIdentity =
      movedParent === undefined ? undefined : identities(work.lines, after).get(movedParent);
    const sameGroup =
      beforeParentIdentity === undefined && afterParentIdentity === undefined
        ? true
        : beforeParentIdentity !== undefined &&
          afterParentIdentity !== undefined &&
          beforeParentIdentity === afterParentIdentity;
    return {
      renamed: undefined,
      renameGiven: undefined,
      autoCandidate: sameGroup ? undefined : headingId,
      writtenIds: new Set(),
    };
  }

  if (op.op === "rename") {
    if (section === undefined) return noEffect();
    const given = op.heading ?? "";
    const text = renameText(section, given);
    const identity = idAt(work.lines, section.headingStart);
    writeHeadingText(work, section, text);
    if (identity !== undefined) work.marks.add(identity);
    return {
      renamed: identity,
      renameGiven: text,
      autoCandidate: undefined,
      writtenIds: new Set(),
    };
  }

  if (op.op === "set_level") {
    if (section === undefined) return noEffect();
    const level = op.level ?? section.level;
    const source = spanSource(work.lines, section.start, section.end);
    const greatest = greatestFittedLevel(source, level);
    if (greatest !== undefined && greatest > 6) {
      return {
        error: `${prefix}the section would need heading level ${greatest}; levels stop at 6`,
      };
    }
    const fitted = fitLines(source, level);
    const placement = replaceRange(work, work.lines, section.start, section.end, fitted);
    work.lines = placement.lines;
    const heading = placement.placed[0];
    if (heading !== undefined) work.marks.add(heading.id);
    return noEffect();
  }

  // replace_body
  if (preamble) {
    const range = before.preamble;
    if (op.block.lines.length === 0) {
      if (range !== undefined) work.lines = removeRange(work, work.lines, range.start, range.end);
      return noEffect();
    }
    const fitted = fitLines(blockSource(op.block.lines));
    if (range === undefined) {
      const first = before.sections[0];
      const at = first === undefined ? work.lines.length : first.headingStart - 1;
      work.lines = placeBlock(work, work.lines, at, fitted).lines;
      return noEffect();
    }
    work.lines = replaceRange(work, work.lines, range.start, range.end, fitted).lines;
    return noEffect();
  }
  if (section === undefined) return noEffect();
  const identity = idAt(work.lines, section.headingStart);
  if (identity !== undefined) work.marks.add(identity);
  if (op.block.lines.length === 0) {
    if (section.bodyStart !== undefined && section.bodyEnd !== undefined) {
      work.lines = removeRange(work, work.lines, section.bodyStart, section.bodyEnd);
    }
    return noEffect();
  }
  const fitted = fitLines(blockSource(op.block.lines));
  if (section.bodyStart !== undefined && section.bodyEnd !== undefined) {
    work.lines = replaceRange(work, work.lines, section.bodyStart, section.bodyEnd, fitted).lines;
    return noEffect();
  }
  work.lines = placeBlock(work, work.lines, section.headingEnd, fitted).lines;
  return noEffect();
}

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#edit-operations: the checks after the addresses resolve
// ---------------------------------------------------------------------------

/** The sections other than X and its descendants whose parent a `set_level` changed (specs/markdown-tool.md#edit-operations). */
function parentChanges(
  before: DocModel,
  after: DocModel,
  beforeIdentities: ReadonlyMap<number, number>,
  afterIdentities: ReadonlyMap<number, number>,
  sectionIndex: number | undefined,
): { count: number; first: DocSection | undefined } {
  const afterByLine = byIdentity(afterIdentities);
  let count = 0;
  let first: DocSection | undefined;
  for (const section of before.sections) {
    if (sectionIndex !== undefined && isWithin(before, section.index, sectionIndex)) continue;
    const identity = beforeIdentities.get(section.index);
    if (identity === undefined) continue;
    const afterIndex = afterByLine.get(identity);
    const afterSection = afterIndex === undefined ? undefined : after.sections[afterIndex];
    const beforeParent = section.parent === undefined ? undefined : before.sections[section.parent];
    const beforeParentIdentity =
      beforeParent === undefined ? undefined : beforeIdentities.get(beforeParent.index);
    const afterParent =
      afterSection === undefined || afterSection.parent === undefined
        ? undefined
        : after.sections[afterSection.parent];
    const afterParentIdentity =
      afterParent === undefined ? undefined : afterIdentities.get(afterParent.index);
    if (beforeParentIdentity === afterParentIdentity) continue;
    count += 1;
    if (first === undefined) first = section;
  }
  return { count, first };
}

// ---------------------------------------------------------------------------
// specs/markdown-tool.md#edit-result: the report
// ---------------------------------------------------------------------------

/** The report of the call (specs/markdown-tool.md#edit-result). */
function reportOf(
  work: Work,
  final: DocModel,
): Omit<EditOutcome, "text" | "lineCount" | "changed"> {
  const ids = identities(work.lines, final);
  const touched: DocSection[] = [];
  for (const section of final.sections) {
    const identity = ids.get(section.index);
    if (identity !== undefined && work.marks.has(identity)) touched.push(section);
  }
  const touchedIndexes = new Set<number>();
  for (const section of touched) touchedIndexes.add(section.index);
  const listedIndexes = new Set<number>();
  for (const section of touched) {
    listedIndexes.add(section.index);
    for (const ancestor of ancestorsOf(final, section.index)) listedIndexes.add(ancestor.index);
  }
  const listed: string[] = [];
  for (const index of [...listedIndexes].toSorted((left, right) => left - right)) {
    const section = final.sections[index];
    if (section === undefined) continue;
    let hidden = 0;
    for (const other of final.sections) {
      if (other.index === section.index) continue;
      if (!isWithin(final, other.index, section.index)) continue;
      if (!listedIndexes.has(other.index)) hidden += 1;
    }
    const mark = touchedIndexes.has(index) ? "* " : "  ";
    const hiddenText = hidden > 0 ? ` (+${hidden} hidden)` : "";
    listed.push(
      `${mark}${section.start}-${section.end} ${"#".repeat(section.level)} ${section.component}${hiddenText}`,
    );
  }

  // A section whose heading does not persist is removed, even when the call writes
  // its level and text again (specs/markdown-tool.md#edit-result).
  const remaining = new Set<number>();
  for (const identity of ids.values()) remaining.add(identity);
  const removed: RemovedSection[] = [];
  for (const identity of work.originalOrder) {
    if (remaining.has(identity)) continue;
    const heading = work.originalHeadings.get(identity);
    if (heading === undefined) continue;
    removed.push({
      start: heading.start,
      end: heading.end,
      level: heading.level,
      text: heading.text,
      subsections: heading.subsections,
    });
  }

  const renumbered: RenumberedHeading[] = [];
  for (const section of final.sections) {
    const identity = ids.get(section.index);
    if (identity === undefined) continue;
    const original = work.originalHeadings.get(identity);
    const written = work.writtenText.get(identity);
    const earlier = original === undefined ? written : original.text;
    if (earlier === undefined) continue;
    const oldPrefix = parseNumberPrefix(earlier)?.prefix ?? "";
    const newPrefix = parseNumberPrefix(section.text)?.prefix ?? "";
    if (oldPrefix === newPrefix) continue;
    renumbered.push({
      start: section.start,
      level: section.level,
      from: earlier,
      to: section.text,
    });
  }

  const skipped: { parent: string; numbers: string[]; order: number }[] = [];
  for (const [key, record] of work.groups) {
    if (record.base === 0 || record.renumbered) continue;
    let parentSection: DocSection | undefined;
    let members: readonly number[] = [];
    if (key === "top") {
      members = membersOf(final);
    } else {
      const identity = Number(key.slice(1));
      const found = final.sections.find((candidate) => ids.get(candidate.index) === identity);
      if (found === undefined) continue;
      parentSection = found;
      members = found.children;
    }
    const numbers: string[] = [];
    for (const index of members) {
      const section = final.sections[index];
      if (section === undefined) continue;
      const number = parseNumberPrefix(section.text);
      if (number !== undefined) numbers.push(number.prefix);
    }
    if (numbers.length === 0) continue;
    skipped.push({
      parent: parentSection === undefined ? "(document)" : parentSection.address,
      numbers,
      order: parentSection === undefined ? -1 : parentSection.start,
    });
  }
  skipped.sort((left, right) => left.order - right.order);

  return {
    touched: touched.map((section) => ({
      address: section.address,
      level: section.level,
      start: section.start,
      end: section.end,
    })),
    listed,
    removed,
    renumbered,
    skipped: skipped.map(({ parent, numbers }) => ({ parent, numbers })),
  };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/** The input of an `edit` call's application. */
export interface EditInput {
  /** The file's text, without a leading U+FEFF. */
  text: string;
  /** The file's lines, in the text's own endings. */
  lines: readonly TextLine[];
  operations: readonly Operation[];
  /** The trimmed `path` as given, for error texts. */
  path: string;
}

/** The expected heading sequence of a text, in line order (specs/markdown-tool.md#edit-operations). */
function expectedSequence(work: Work): ExpectedHeading[] {
  const sequence: ExpectedHeading[] = [];
  for (const line of work.lines) {
    const heading = work.expected.get(line.id);
    if (heading !== undefined) sequence.push(heading);
  }
  return sequence;
}

/**
 * Apply an `edit` call's operations (specs/markdown-tool.md#action-edit), in order, each to the text the
 * operations before it left. An operation that fails a check rejects the call.
 */
export function applyOperations(input: EditInput): EditResult {
  const original = analyzeDocument(input.lines);
  const first = input.lines[0];
  const last = input.lines[input.lines.length - 1];
  const work: Work = {
    lines: input.lines.map((line, index) => ({
      id: index + 1,
      text: line.text,
      ending: line.ending,
    })),
    nextId: input.lines.length + 1,
    defaultEnding: first === undefined || first.ending === "" ? "\n" : first.ending,
    lastHadEnding: last === undefined ? false : last.ending !== "",
    wasEmpty: input.lines.length === 0,
    marks: new Set(),
    expected: new Map(),
    renumberedText: new Map(),
    writtenText: new Map(),
    originalHeadings: new Map(),
    originalOrder: [],
    groups: new Map(),
  };
  const originalIdentities = identities(work.lines, original);
  for (const section of original.sections) {
    const identity = originalIdentities.get(section.index);
    if (identity === undefined) continue;
    work.expected.set(identity, { level: section.level, text: section.text });
    work.originalHeadings.set(identity, {
      level: section.level,
      text: section.text,
      start: section.headingStart,
      end: section.end,
      subsections: section.children.length,
    });
    work.originalOrder.push(identity);
  }
  let model = original;
  for (let index = 0; index < input.operations.length; index += 1) {
    const op = input.operations[index];
    if (op === undefined) continue;
    const prefix = `operations[${index}]: `;
    const beforeIdentities = identities(work.lines, model);
    let sectionIndex: number | undefined;
    let preamble = false;
    if (op.section !== undefined) {
      const resolved = resolveOperationAddress(work, model, op.section, input.path);
      if ("error" in resolved) return { kind: "error", message: prefix + resolved.error };
      sectionIndex = resolved.section;
      preamble = resolved.preamble;
    }
    let atIndex: number | undefined;
    let document = false;
    if (op.at !== undefined) {
      if (stripAddress(op.at) === "(document)") {
        document = true;
      } else {
        const resolved = resolveOperationAddress(work, model, op.at, input.path);
        if ("error" in resolved) return { kind: "error", message: prefix + resolved.error };
        atIndex = resolved.section;
      }
    }
    const section = sectionIndex === undefined ? undefined : model.sections[sectionIndex];
    const atSection = atIndex === undefined ? undefined : model.sections[atIndex];

    // The checks of specs/markdown-tool.md#edit-operations that run before renumbering, in their order.
    if (op.op === "move" && sectionIndex !== undefined && atIndex !== undefined) {
      if (isWithin(model, atIndex, sectionIndex)) {
        return {
          kind: "error",
          message: `${prefix}cannot move ${section?.address ?? ""} to a place inside itself`,
        };
      }
    }
    if (op.op === "insert" || op.op === "move") {
      const firstPosition = op.position === "first" || op.position === "last";
      if (firstPosition && atSection !== undefined && atSection.level === 6) {
        return {
          kind: "error",
          message: `${prefix}${atSection.address} is a level-6 section and can hold no subsection`,
        };
      }
    }

    const structural = structurally(
      work,
      model,
      op,
      index,
      sectionIndex,
      preamble,
      atIndex,
      document,
      beforeIdentities,
    );
    if ("error" in structural) return { kind: "error", message: structural.error };
    normalizeEndings(work);
    let after = analyzeDocument(work.lines);

    if (op.op === "set_level" && sectionIndex !== undefined) {
      const changes = parentChanges(
        model,
        after,
        beforeIdentities,
        identities(work.lines, after),
        sectionIndex,
      );
      if (changes.count > 0 && changes.first !== undefined) {
        return {
          kind: "error",
          message: `${prefix}set_level would change the parent of ${changes.count} other sections, first ${changes.first.address}; move ${section?.address ?? ""} first, then set its level (move fits its level to the new place)`,
        };
      }
    }

    renumberGroups(
      work,
      model,
      after,
      beforeIdentities,
      structural.writtenIds,
      structural.autoCandidate,
      index,
    );
    after = analyzeDocument(work.lines);

    if (op.op === "rename" && structural.renamed !== undefined) {
      const expected = work.expected.get(structural.renamed);
      let actual: DocSection | undefined;
      for (const candidate of after.sections) {
        if (idAt(work.lines, candidate.headingStart) !== structural.renamed) continue;
        actual = candidate;
        break;
      }
      if (expected !== undefined && (actual === undefined || actual.text !== expected.text)) {
        return {
          kind: "error",
          message: `${prefix}"${structural.renameGiven ?? ""}" cannot be written as heading text; it would read "${actual === undefined ? "" : actual.text}"`,
        };
      }
    }

    if (after.frontmatter !== undefined && model.frontmatter === undefined) {
      return {
        kind: "error",
        message: `${prefix}the edited text would make lines 1-${after.frontmatter.end} frontmatter`,
      };
    }

    const expectedHeadings = expectedSequence(work);
    const actualHeadings = after.sections.map((candidate) => ({
      level: candidate.level,
      text: candidate.text,
      start: candidate.headingStart,
    }));
    let mismatch: number | undefined;
    const longest = Math.max(expectedHeadings.length, actualHeadings.length);
    for (let position = 0; position < longest; position += 1) {
      const want = expectedHeadings[position];
      const got = actualHeadings[position];
      if (
        want !== undefined &&
        got !== undefined &&
        want.level === got.level &&
        want.text === got.text
      ) {
        continue;
      }
      mismatch = got === undefined ? work.lines.length : got.start;
      break;
    }
    if (mismatch !== undefined) {
      return {
        kind: "error",
        message: `${prefix}the edited text would not parse as intended near line ${mismatch}; check code fences and HTML blocks in the content or around line ${mismatch}`,
      };
    }
    model = after;
  }
  const finalModel = analyzeDocument(work.lines);
  let text = "";
  for (const line of work.lines) text += line.text + line.ending;
  return {
    kind: "ok",
    outcome: {
      text,
      lineCount: work.lines.length,
      changed: text !== input.text,
      ...reportOf(work, finalModel),
    },
  };
}
