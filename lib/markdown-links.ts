/** Link inventory (specs/markdown-tool.md#action-links), run only in the worker. */
import { fromMarkdown, type Extension } from "mdast-util-from-markdown";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { normalizeIdentifier } from "micromark-util-normalize-identifier";
import { flattenText } from "./text.ts";

interface Node {
  type: string;
  children?: Node[] | undefined;
  position?:
    | { start: { line: number; offset?: number | undefined }; end: { offset?: number | undefined } }
    | undefined;
  identifier?: string;
  referenceType?: string;
  url?: string;
}

export interface LinkItem {
  line: number;
  kind: string;
  destination?: string;
  label?: string;
  text?: string;
}

/** mdast normally discards an image description's parsed children when computing alt. */
const imageChildren: Extension = {
  exit: {
    label() {
      const fragment = this.stack[this.stack.length - 1];
      const value = this.resume();
      const node = this.stack[this.stack.length - 1];
      this.data.inReference = true;
      if (node?.type === "image") node.alt = value;
      if (node !== undefined && fragment !== undefined && "children" in fragment) {
        Object.assign(node, { children: fragment.children });
      }
    },
  },
};

function parse(source: string): Node {
  return fromMarkdown(source, {
    extensions: [gfmTable(), gfmAutolinkLiteral()],
    mdastExtensions: [gfmTableFromMarkdown(), gfmAutolinkLiteralFromMarkdown(), imageChildren],
  });
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function short(source: string): string {
  const text = flattenText(source);
  return text.length > 60 ? text.slice(0, 60) + "…" : text;
}

/** Candidate labels only; the second parse decides which are actual references. */
function brackets(source: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === "\\") i += 1;
    else if (c === "[") stack.push(i);
    else if (c === "]") {
      const start = stack.pop();
      if (start !== undefined) pairs.set(start, i);
    }
  }
  return pairs;
}

function rawParts(node: Node, raw: string): { text: string; label: string } {
  const start = raw.startsWith("!") ? 1 : 0;
  const origin = node.position?.start.offset ?? 0;
  const lastChild = node.children?.[node.children.length - 1];
  const afterText = lastChild?.position?.end.offset;
  const end =
    afterText === undefined
      ? (brackets(raw).get(start) ?? start)
      : raw.indexOf("]", afterText - origin);
  const text = raw.slice(start + 1, end);
  const label = node.referenceType === "full" ? raw.slice(end + 2, -1) : text;
  return { text, label };
}

/** Matching is document-wide; the caller filters the returned items by their file lines. */
export function documentLinks(source: string, lineOffset: number): LinkItem[] {
  const root = parse(source);
  const definitions = new Map<string, Node>();
  const used = new Set<string>();
  walk(root, (node) => {
    if (node.type === "definition" && node.identifier !== undefined) {
      const key = normalizeIdentifier(node.identifier);
      if (!definitions.has(key)) definitions.set(key, node);
    }
    if (
      (node.type === "linkReference" || node.type === "imageReference") &&
      node.identifier !== undefined
    ) {
      used.add(normalizeIdentifier(node.identifier));
    }
  });
  const found: { offset: number; item: LinkItem }[] = [];
  function collect(node: Node, prefixLength = 0, prefixLines = 0): void {
    const position = node.position;
    const start = position?.start.offset;
    const end = position?.end.offset;
    if (position === undefined || start === undefined || end === undefined || start < prefixLength)
      return;
    const offset = start - prefixLength;
    const raw = source.slice(offset, end - prefixLength);
    const item: LinkItem = { line: position.start.line - prefixLines + lineOffset, kind: "" };
    if (node.type === "link" || node.type === "image") {
      if (prefixLength > 0) return;
      if (node.type === "link" && !raw.startsWith("[")) {
        item.kind = "autolink";
        item.destination = raw.startsWith("<") ? raw.slice(1, -1) : raw;
      } else {
        item.kind = node.type;
        item.destination = node.url ?? "";
        item.text = short(rawParts(node, raw).text);
      }
    } else if (node.type === "linkReference" || node.type === "imageReference") {
      const key = normalizeIdentifier(node.identifier ?? "");
      const definition = definitions.get(key);
      if (prefixLength > 0 && (definition !== undefined || node.referenceType === "shortcut"))
        return;
      const parts = rawParts(node, raw);
      item.kind =
        prefixLength > 0
          ? "undefined-reference"
          : node.type === "linkReference"
            ? "reference"
            : "image-reference";
      if (definition !== undefined) item.destination = definition.url ?? "";
      item.label = short(parts.label);
      if (node.referenceType === "full") item.text = short(parts.text);
    } else if (node.type === "definition") {
      if (prefixLength > 0) return;
      const key = normalizeIdentifier(node.identifier ?? "");
      if (used.has(key) && definitions.get(key) === node) return;
      item.kind = "unused-definition";
      item.destination = node.url ?? "";
      item.label = short(rawParts(node, raw).text);
    } else return;
    found.push({ offset, item });
  }
  walk(root, (node) => collect(node));

  // Only a parser can decide whether a missing reference is Markdown rather than code or HTML.
  const candidates = new Map<string, string>();
  for (const [start, end] of brackets(source)) {
    const rawLabel = source.slice(start + 1, end);
    // Container prefixes occur in the source slice, but are not part of a parsed label.
    for (const label of [rawLabel, rawLabel.replace(/(\r\n|[\r\n])[ \t]*(?:>[ \t]*)+/g, "$1")]) {
      if (
        label.length > 999 ||
        !label.trim() ||
        /(?:^|[^\\])(?:\\\\)*[[\]]/.test(label) ||
        /(?:\r?\n|\r)[ \t]*(?:\r?\n|\r)/.test(label)
      )
        continue;
      const key = normalizeIdentifier(label);
      if (!definitions.has(key)) candidates.set(key, label.replace(/\r\n|[\r\n]/g, " "));
    }
  }
  if (candidates.size > 0) {
    const prefix = [...candidates.values()].map((label) => `[${label}]: /`).join("\n") + "\n\n";
    const prefixLines = prefix.match(/\r\n|[\r\n]/g)?.length ?? 0;
    walk(parse(prefix + source), (node) => collect(node, prefix.length, prefixLines));
  }
  found.sort((a, b) => a.offset - b.offset);
  return found.map(({ item }) => item);
}
