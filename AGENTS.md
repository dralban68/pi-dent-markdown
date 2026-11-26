# pi-dent-markdown

The `Markdown` tool of pi-dent, as a library: pi-dent consumes `makeMarkdownTool` and
`markdownRuntime`; `extension.ts` registers the tool standalone (specs/markdown-tool.md).

This repository follows the dev repo standard.

## Read first

| Document                 | Holds, and when to read it                                                |
| ------------------------ | ------------------------------------------------------------------------- |
| `specs/markdown-tool.md` | the tool's behaviour — read before any change to `lib/` or `test/`        |
| `docs/markdown.md`       | parser choice and the micromark pin (non-normative) — read before bumping |

## Commands

```sh
pnpm check        # the done-set: typecheck, lint, fmt:check, test
pnpm test
pnpm typecheck
pnpm lint
pnpm fmt          # rewrites files, Markdown included
pnpm fmt:check
```

## Rules

- No host imports: everything host-specific is a parameter of `markdownRuntime`. Identifiers are
  pi-dent's own (`pi-dent.conf`, `~/.pi/pi-dent/`, `PI_DENT_*`).
- pi-dent-agent consumes this package from npm at an exact version: publish a change, then bump the
  version in pi-dent-agent and run its `pnpm check`.
- Published to npm, so package.json is not private: the one accepted dev audit finding.
