# pi-dent-markdown

The `Markdown` tool an agent uses to outline, read, and edit a Markdown file by its headings. It is
a pi extension, and the library [pi-dent](https://www.npmjs.com/package/pi-dent-agent) builds its
own `Markdown` tool from.

## Why

The host's `read` and `edit` tools see a file as lines: reading a long file costs the whole file,
and editing means quoting the exact text being changed. This tool parses the file's structure
instead — it knows where each heading, fence, and table sits — so an agent outlines a long document
and reads only the sections it needs, and restructures sections without quoting any of their text:
an operation names a section, not a byte range.

## How it works

One call takes an `action` on one file:

- `outline` lists the sections with their line ranges (`depth`, `preview`, `offset`, `limit`).
- `read` returns one section's text, with subsections below `depth` shown as their heading only.
- `edit` applies 1 to 50 operations — `replace`, `replace_body`, `insert`, `delete`, `move`,
  `rename`, `set_level` — in order, all or none. A section is named by its heading text, with or
  without a trailing `{#id}`, its number (`"3.1"`), its id (`"#checks"`), or a line copied from an
  outline; a placed section is fitted to its new level
  and numbered headings are renumbered in sequence. `edit` requires the `revision` an earlier
  result of the same file showed, and rejects the call when the file changed since.
- `links` lists the file's or a section's links, images, autolinks, and link definitions with their
  lines and destinations, plus unused definitions and references to missing ones; it checks no
  target itself.

Every action parses the file with micromark (GFM tables and autolink literals) on a worker thread
created for the call, off the host's main thread; a parse budget, 10 s by default, bounds the call,
and an abort ends the thread. Limits: UTF-8 files of at most 4 MiB; 500 entries or link items per
listing; 2000 lines per read. Changing words inside a section stays with the host's `edit` tool.

## Using it

Standalone, install it as a pi package:

```sh
pi install npm:pi-dent-markdown
```

pi-dent-agent already registers `Markdown`; its users should not install this package as well,
which would register the tool a second time. To register the tool from an extension of your own:

```ts
import { makeMarkdownTool, markdownRuntime } from "pi-dent-markdown";

pi.registerTool(makeMarkdownTool(markdownRuntime()));
```

There is no configuration key. `markdownRuntime` takes the host-specific pieces as parameters —
`home`, `readFile`, `writeFile`, `mutationQueue`, `parseBudgetMs` — with pi's own as defaults.
The registration surface, including the model-facing texts registered verbatim, is owned by
[markdown-tool.md, tool registration surface](specs/markdown-tool.md#registration). Requires Node 26
or later.

## Documentation

- [specs/markdown-tool.md](specs/markdown-tool.md) — the tool's behaviour, normative; read before
  any change to `lib/` or `test/`.
- [docs/markdown.md](docs/markdown.md) — parser choice and the micromark pin; read before bumping
  the parser.

## License

MIT
