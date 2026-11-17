# Markdown tool: implementation notes

Non-normative. The spec is `specs/markdown-tool.md`.

## Parser

`lib/markdown-document.ts` parses with `mdast-util-from-markdown` (micromark underneath) plus
`micromark-extension-gfm-table`. Only block positions are used: headings, fences, HTML blocks,
tables.

## micromark pin

`pnpm-workspace.yaml` overrides `micromark` to 4.0.2 and `micromark-core-commonmark` to 2.0.3.
4.0.3 (with `micromark-util-edit-map` 1.0.0) rebuilds the whole event list once per block quote,
setext heading and nested list item, so parsing is quadratic
([micromark#246](https://github.com/micromark/micromark/issues/246), open since 2026-09-28).

Measured on Node 26, 128 KB inputs, one `fromMarkdown` call:

| Input                         | 4.0.3  | 4.0.2  | markdown-it 14 |
| ----------------------------- | ------ | ------ | -------------- |
| `> a\n\n` repeated            | 17.6 s | 0.37 s | 31 ms          |
| `a\n=\n` repeated (setext)    | 34.4 s | 0.38 s | 18 ms          |
| `- a\n - b\n` repeated        | 0.38 s | 0.41 s | 27 ms          |
| 20,000-item flat list, 243 KB | 0.26 s | 0.29 s | 18 ms          |

`test/markdown-tool/parser-cost.test.ts` fails (5 s bound) when the regression is back.

### Updating

1. Check whether #246 is fixed in a release after 4.0.3.
2. Drop or raise the two overrides, `pnpm install`, and confirm with `pnpm why micromark`.
3. Run `node --test test/markdown-tool/`; the cost test must pass.

### Known, not fixed

- `mdast-util-from-markdown` 2.1.0 `prepareList` splices once per list item, quadratic on one
  very long list ([mdast-util-from-markdown#49](https://github.com/syntax-tree/mdast-util-from-markdown/issues/49)).
  Not visible at our sizes (20,000 items: 0.26 s).
- Even pinned, remark parsing is about 0.3 s per 100 KB; files near the 4 MiB limit take seconds.
  `markdown-it` is 10-20x faster and reports block line ranges (`token.map`), which is all the tool
  needs; switching means rewriting `lib/markdown-document.ts`'s parse. `@lezer/markdown` is the
  linear alternative if inline offsets are ever needed.
