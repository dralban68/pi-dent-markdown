# pi-dent-markdown specifications

Write and review specs per the `dev:writing-specs` skill, which defines the requirement keywords and
the conformance rule. This file holds only this repository's differences from it.

## Specs

| Spec               | Subject                                                         |
| ------------------ | --------------------------------------------------------------- |
| `markdown-tool.md` | The `Markdown` tool: outline, read, and edit a file by sections |

## Differences

- The spec belongs to pi-dent's spec set: it cites pi-dent's specs as pi-dent-agent `specs/<name>.md`, never as a link, and
  identifiers are pi-dent's own (`pi-dent.conf`, `~/.pi/pi-dent/`, `PI_DENT_*`).
- A length in characters counts UTF-16 code units.
- Section 1.4 texts are registered verbatim; `test/markdown-tool/texts.test.ts` reads them from
  this spec, so a wording change there is a code change too.
