# Markdown tool specification

This document specifies the `Markdown` tool: the surface through which a session reads and
restructures one Markdown file by its headings, with the actions `outline` (list the sections
down to a heading level), `read` (return one section's text), `edit` (replace, insert,
delete, move, rename, and re-level whole sections), and `links` (list the links and their
destinations). It complements the host's `read`, `edit`,
and `write` tools, which read, change, and write a file as text.

`Markdown` registers no task row (pi-dent-agent `specs/task.md`, Section 1). An `outline`, `read`, or `links`
call MUST NOT create, change, or delete any file. An `edit` call MUST NOT change any file other than
the one its `path` names, and MUST NOT create or delete a file.

## 1. Tool registration surface {#registration}

pi-dent's extension MUST register the tool through the host `registerTool` API, in every run mode; the
package's standalone entry registers it the same way ([standalone extension entry](#standalone-entry)):

| Field              | Value                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `name`             | `"Markdown"`                                                                                                     |
| `label`            | `"Markdown"`                                                                                                     |
| `description`      | The text of [model-facing texts](#model-facing-texts)                                                            |
| `promptSnippet`    | The text of [model-facing texts](#model-facing-texts)                                                            |
| `parameters`       | The parameter schema of [parameter schema](#parameters), described per [model-facing texts](#model-facing-texts) |
| `prepareArguments` | The argument preparation of [argument preparation](#argument-preparation)                                        |
| `renderShell`      | not set: the host's default tool shell                                                                           |

A child session binds `Markdown` under the rule of pi-dent-agent `specs/agent-tool.md`, Section 3.1.
The tool has no configuration key. Every rejection this specification gives is a tool error
(`isError: true`) whose content is its error text alone, with no `details`.

### 1.1 Parameter schema {#parameters}

The parameter schema is a JSON object schema with `type: "object"` and
`additionalProperties: false`, with two required fields, `action` and `path`; every other field
is optional in the schema and admits `null` beside the type in the table, and each action accepts
only its fields below. A field whose value is `null` counts as absent.

| Field        | Type                                       | Actions                    | Contract                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`     | `"outline" \| "read" \| "edit" \| "links"` | all                        | The operation to perform.                                                                                                                                                                                                                     |
| `path`       | string                                     | all                        | The file ([file access](#file-access)).                                                                                                                                                                                                       |
| `section`    | string? \| null                            | `outline`, `read`, `links` | A section address ([section addresses](#section-addresses)). Required for `read`. `outline`: the section listed with its descendants; `links`: the section whose span is the scope ([action `links`](#action-links)); absent: the whole file. |
| `depth`      | integer? \| null                           | `outline`, `read`          | A heading level, `1` to `6`. `outline`: the deepest level listed ([action `outline`](#action-outline)). `read`: the deepest level shown whole ([action `read`](#action-read)).                                                                |
| `preview`    | boolean? \| null                           | `outline`                  | `true`: each entry is followed by its preview line ([action `outline`](#action-outline)). Default `false`.                                                                                                                                    |
| `offset`     | integer? \| null                           | `outline`, `read`, `links` | `outline`: the number of entries to skip, default `0`. `links`: the number of items to skip, default `0`. `read`: the file line number to start at, default the section's first line.                                                         |
| `limit`      | integer? \| null                           | `outline`, `read`, `links` | `outline`: the most entries to list, `1` to `500`, default `100`. `links`: the most items to list, `1` to `500`, default `100`. `read`: the most display lines to return, `1` to `2000`, default `500`.                                       |
| `revision`   | string? \| null                            | `edit`                     | Required for `edit`. The revision ([file access](#file-access)) the caller last saw.                                                                                                                                                          |
| `operations` | operation[] (min 1, max 50)? \| null       | `edit`                     | Required for `edit`. The operations, applied in array order ([action `edit`](#action-edit)).                                                                                                                                                  |

An operation is a JSON object schema with `additionalProperties: false` and one required field,
`op`; every other field is optional and admits `null`, and each `op` accepts only its fields:

| Field      | Type                                                                                       | Ops                                 | Contract                                                  |
| ---------- | ------------------------------------------------------------------------------------------ | ----------------------------------- | --------------------------------------------------------- |
| `op`       | `"replace" \| "replace_body" \| "insert" \| "delete" \| "move" \| "rename" \| "set_level"` | all                                 | The operation ([operations](#edit-operations)).           |
| `section`  | string? \| null                                                                            | all but `insert`                    | Required. The section address acted on.                   |
| `position` | `"before" \| "after" \| "first" \| "last"`? \| null                                        | `insert`, `move`                    | Required. Where to place, relative to `at`.               |
| `at`       | string? \| null                                                                            | `insert`, `move`                    | Required. The section address placed relative to.         |
| `content`  | string? \| null                                                                            | `replace`, `replace_body`, `insert` | Required. Markdown text ([operations](#edit-operations)). |
| `heading`  | string? \| null                                                                            | `rename`                            | Required. The new heading text.                           |
| `level`    | integer? \| null                                                                           | `set_level`                         | Required. The new heading level, `1` to `6`.              |

The schema constrains the types of the tables, the values of `action`, `op`, and `position`, the
length bounds of `operations`, and the set of admitted properties, and nothing else. A call the
host rejects against it is a schema rejection (pi-dent-agent `specs/task.md`, Section 1). An integer is a
number for which ECMAScript `Number.isInteger` holds.

### 1.2 Argument preparation {#argument-preparation}

Before the host validates a call against the schema, the argument preparation MUST replace an
`operations` value that is a string holding a JSON array by that array, and an `operations`
value that is a JSON object (not an array, not `null`), or a string holding one, by a one-element
array holding that object. It MUST leave every other argument unchanged.

> Note (non-normative): some models send an array argument as a JSON string or a lone object;
> the host's own `edit` tool repairs the same shapes.

### 1.3 Validation {#validation}

Execution-time validation MUST reject the call as a tool error (`isError: true`) whose text is
the error text of the first failing check, in this order, before the file is read:

| #   | Check                                                                                                                                                  | Error text                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 1   | A field other than `action` and `path` that the action does not accept is present (first such field in table order of [parameter schema](#parameters)) | `<field> is not valid for action <action>`                                                    |
| 2   | `path` is empty after trimming                                                                                                                         | `path must be a non-empty string`                                                             |
| 3   | `read`: `section` is absent or empty after trimming; `outline`, `links`: `section` is present and empty after trimming                                 | `section must be a non-empty string`                                                          |
| 4   | `section` is `(document)`, or `outline`: `section` is `(preamble)`                                                                                     | `<name> is not valid as the section of <action>`                                              |
| 5   | `depth` is present and not an integer from 1 to 6                                                                                                      | `depth must be an integer from 1 to 6`                                                        |
| 6   | `outline`, `links`: `offset` is present and not a non-negative integer                                                                                 | `offset must be a non-negative integer`                                                       |
| 7   | `read`: `offset` is present and not a positive integer                                                                                                 | `offset must be a positive integer`                                                           |
| 8   | `outline`, `links`: `limit` is present and not an integer from 1 to 500                                                                                | `limit must be an integer from 1 to 500`                                                      |
| 9   | `read`: `limit` is present and not an integer from 1 to 2000                                                                                           | `limit must be an integer from 1 to 2000`                                                     |
| 10  | `edit`: `revision` is absent or, after trimming, not 8 lowercase hexadecimal digits                                                                    | `revision must be the 8-digit revision an outline, read, or edit result showed for this file` |
| 11  | `edit`: `operations` is absent, is not an array, or holds fewer than 1 or more than 50 elements                                                        | `operations must hold 1 to 50 operations`                                                     |

Then, for each operation in array order, checks 12 to 22; the first failure is reported:

| #   | Check                                                                                                                                                                                                                                                                                                                                                                    | Error text                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 12  | A field other than `op` that the op does not accept is present (first such field in table order of [parameter schema](#parameters))                                                                                                                                                                                                                                      | `operations[<i>]: <field> is not valid for op <op>`                                                                         |
| 13  | A field the op accepts is absent (first such field in table order)                                                                                                                                                                                                                                                                                                       | `operations[<i>]: op <op> requires <field>`                                                                                 |
| 14  | `section` or `at` is empty after trimming (first in table order)                                                                                                                                                                                                                                                                                                         | `operations[<i>]: <field> must be a non-empty string`                                                                       |
| 15  | `section` is `(document)`, or `section` is `(preamble)` and `op` is not `replace_body`, or `at` is `(preamble)` (first in table order)                                                                                                                                                                                                                                   | `operations[<i>]: <name> is not valid as the <field> of op <op>`                                                            |
| 16  | `at` is `(document)` and `position` is `before` or `after`                                                                                                                                                                                                                                                                                                               | `operations[<i>]: at (document) takes position first or last`                                                               |
| 17  | `heading` is empty after trimming or contains a line ending                                                                                                                                                                                                                                                                                                              | `operations[<i>]: heading must be one non-empty line`                                                                       |
| 18  | `level` is not an integer from 1 to 6                                                                                                                                                                                                                                                                                                                                    | `operations[<i>]: level must be an integer from 1 to 6`                                                                     |
| 19  | `replace`, `insert`: the content block ([line rules](#edit-line-rules)) is empty, or its first line is not the heading line of a heading of the block parsed alone ([line rules](#edit-line-rules))                                                                                                                                                                      | `operations[<i>]: content must start with a heading line`                                                                   |
| 20  | `replace`, `insert`: another heading of the block parsed alone has a level not greater than the first heading's                                                                                                                                                                                                                                                          | `operations[<i>]: content must be one section: line <n> is a heading of level <l>`                                          |
| 21  | `replace_body`: the block parsed alone has a heading                                                                                                                                                                                                                                                                                                                     | `operations[<i>]: replace_body content must contain no heading: line <n> is one`                                            |
| 22  | `replace`, `insert`, `replace_body`: a line of the content block is, without leading and trailing spaces and tabs, `[… <k> lines hidden: <a>-<b>]`, `--- cut: continue with offset <c> ---`, or `--- end of section ---`, or ends with ` · lines <a>-<b> · revision <r>`, `<k>`, `<a>`, `<b>`, and `<c>` being decimal integers and `<r>` 8 lowercase hexadecimal digits | `operations[<i>]: content line <n> is a marker of read, not file text; read the section without depth and to its end first` |

A field an op accepts is one whose "Ops" cell names the op; every such field is required.
`<field>`, `<action>`, and `<op>` are the field name, the action value, and the op value; `<i>`
is the operation's 0-based index; `<name>` is `(document)` or `(preamble)`;
`<n>` is the line number, in `content` as given counting from 1, of the first such heading's
heading line, or for check 22 of the first such line; `<l>` is the heading's level. A value is
`(document)` or `(preamble)` when it equals that string after the stripping of [section addresses](#section-addresses). The checks of [documents](#documents), [action `outline`](#action-outline), [action `read`](#action-read), [action `edit`](#action-edit), and [action `links`](#action-links), which read the file, run after these: first
those of [file access](#file-access), then the address resolution of [section addresses](#section-addresses), then those of the action's own
section.

### 1.4 Model-facing texts {#model-facing-texts}

The texts of this section are what a model reads to choose and fill a call; each MUST be
registered verbatim, and none cites a specification.

The `description` is

```text
Outline, read, and restructure a Markdown file by its headings; use it instead of the `read` tool for Markdown files. For a long file, outline first and read only the sections you need. Its outline action lists the sections with their line ranges; read returns one section; links lists the links, images, autolinks, and link definitions of the file or a section with their lines and destinations, plus unused definitions and references to missing ones, for you to check, and checks no target itself; edit replaces, inserts, deletes, moves, renames, or re-levels whole sections without quoting their old text, fits each placed section to the level of its new place, and applies its operations in order, all or none. Name a section by its heading text, its number ("3.1", "§3.1"), or a line copied from an outline or edit result; when that is not unique, put ancestor headings before it, joined by " > ". Numbered headings ("3.", "3.1") are renumbered to stay in sequence, and a section placed among them without a number gets one; a later operation of the same call names a renumbered section by its text without the number. To change words inside a section, use the `edit` tool.
```

The `promptSnippet` is

```text
Outline, read, and edit Markdown files section by section: the default for reading and restructuring Markdown
```

Each property of the parameter schema, and of the operation schema, carries this `description`:

| Field                   | `description`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`                | `outline: list the sections with their line ranges. read: return one section's text. edit: apply structural operations. links: list the links and their destinations.`                                                                                                                                                                                                                                                                       |
| `path`                  | `Path to the Markdown file (relative or absolute).`                                                                                                                                                                                                                                                                                                                                                                                          |
| `section`               | `outline and links: only this section and its subsections. read: required, the section to return; (preamble) names the text before the first heading, for read and links.`                                                                                                                                                                                                                                                                   |
| `depth`                 | `A heading level, 1 to 6. outline: the deepest level listed (1: # only, 2: # and ##, and so on); default: the deepest that fits in limit or 100 entries, whichever is greater. read: subsections deeper than this level are shown as their heading only.`                                                                                                                                                                                    |
| `preview`               | `For outline: true also shows the first line under each heading. Default false.`                                                                                                                                                                                                                                                                                                                                                             |
| `offset`                | `outline and links: how many entries or items to skip; copy it from the "More entries follow" or "More items follow" line. read: the file line to start at; copy it from the "cut: continue with offset" line.`                                                                                                                                                                                                                              |
| `limit`                 | `outline and links: the most entries or items to list, 1 to 500, default 100. read: the most lines to return, 1 to 2000, default 500.`                                                                                                                                                                                                                                                                                                       |
| `revision`              | `Required for edit: the revision shown by your latest outline, read, or edit of this file.`                                                                                                                                                                                                                                                                                                                                                  |
| `operations`            | `Required for edit: 1 to 50 operations, each applied to the result of the ones before it.`                                                                                                                                                                                                                                                                                                                                                   |
| `operations[].op`       | `replace: the whole section, with content. replace_body: the text under the heading, before its subsections, with content (empty removes it). insert: content at position relative to at. delete: the section with its subsections. move: the section to position relative to at. rename: set its heading text. set_level: set its heading level; its subsections shift with it, and it is refused when other sections would change parent.` |
| `operations[].section`  | `The section acted on; (preamble) only for replace_body.`                                                                                                                                                                                                                                                                                                                                                                                    |
| `operations[].position` | `For insert and move: before or after the at section, or as its first or last subsection.`                                                                                                                                                                                                                                                                                                                                                   |
| `operations[].at`       | `For insert and move: the section to place relative to; (document) with first places before the first heading, with last at the end of the file, levels unchanged.`                                                                                                                                                                                                                                                                          |
| `operations[].content`  | `For replace and insert: Markdown starting with its heading line, one section with any subsections; its heading levels are fitted to the destination, and its numbers are corrected where the destination's are in sequence. For replace_body: Markdown without headings.`                                                                                                                                                                   |
| `operations[].heading`  | `For rename: the new heading text, one line, without the # marks. A number prefix such as 3.1 is kept unless you write one.`                                                                                                                                                                                                                                                                                                                 |
| `operations[].level`    | `For set_level: the new level, 1 to 6.`                                                                                                                                                                                                                                                                                                                                                                                                      |

The schema of an element of `operations` carries no `description` of its own, and no
alternative inside a property carries one.

### 1.5 The standalone extension entry {#standalone-entry}

The package registers the tool on its own, through the entry `extension.ts`, so a host that installs
`pi-dent-markdown` as a pi package gets the tool without pi-dent. The entry's default export takes
the host `ExtensionAPI` and calls `pi.registerTool(makeMarkdownTool(markdownRuntime()))`, giving
`markdownRuntime()` no options: its defaults are the host's own file system, `homedir()`, the host's
mutation queue, and the default parse budget. The tool registered is the one of the table of
[tool registration surface](#registration), and the tool has no configuration key here either.

The library surface stays as pi-dent-agent consumes it: `index.ts` keeps its exports, the entry is
the only file that calls `registerTool`, and pi-dent-agent never loads the entry. A host with
pi-dent-agent installed that installs this package as well registers `Markdown` twice, so a
pi-dent-agent user does not need this package installed.

## 2. Documents {#documents}

### 2.1 File access {#file-access}

The trimmed `path`, with one leading `@` removed, `~` or a leading `~/` standing for the user's
home directory, resolves against the working directory of the invoking session when it is
relative. Any file is read as Markdown, whatever its name. `<path>` in a result or error text is
the trimmed `path` as given. After the checks of [validation](#validation), the call MUST be rejected as a tool
error, the first failure reported, in this order:

| Check                                                              | Error text                                                                                                            |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| The file cannot be read                                            | `cannot read <path>: <code>`                                                                                          |
| The file is not a regular file                                     | `<path> is not a regular file`                                                                                        |
| The file is larger than 4194304 bytes                              | `<path> is <bytes> bytes; Markdown reads files of at most 4194304 bytes`                                              |
| The bytes are not valid UTF-8, or the decoded text contains U+0000 | `<path> is not UTF-8 text`                                                                                            |
| `edit`: the file's revision differs from the trimmed `revision`    | `<path> has changed since revision <revision>; read the sections you edit, or outline the file, again before editing` |

`<code>` is the error code the file system reports (such as `ENOENT`), `EISDIR` for a directory,
else its message; `<bytes>` is the file's size; `<revision>` is the trimmed `revision`. The call
MUST NOT block the host's main thread while it opens or reads the file, nor read more than
4194305 bytes of it.

A file's revision is the first 8 hexadecimal digits, in lowercase, of the SHA-256 digest
([FIPS 180-4]) of the file's bytes as the call read them. Every result that is not a tool error
shows it.

> Note (non-normative): a section operation removes or rewrites text the call does not quote, so
> unlike the exact text of the host's `edit` tool it carries no proof of what the model last saw;
> the revision is that proof.

The file's text is its bytes decoded as UTF-8, without a leading U+FEFF, which is not part of
line 1 and which an `edit` call keeps. A line ending is a line feed, a carriage return not
followed by a line feed, or a carriage return followed by a line feed ([CommonMark],
[file access](#file-access)). The text is split into lines at line endings; a line ending ends its line, and a
line ending at the end of the text starts no further line. Lines are numbered from 1; the
file's line count is the number of lines, `0` for an empty text. A blank line is a line holding
only spaces and tabs, or nothing ([CommonMark], Section 2.1).

### 2.2 Parsing {#parsing}

This tool detects frontmatter (pi-dent-agent `specs/skill.md`, Section 1) in any file: when line 1 is `---`
followed by nothing but spaces and tabs and a later line is too, line 1 through the first such
later line is the frontmatter as this tool detects it, which belongs to no section and no
preamble. Wherever this specification says frontmatter, it means frontmatter so detected.

The document is the text after the frontmatter, or the whole text without one, parsed as a
[CommonMark] document with the table extension of [GFM], Section 4.10, and no other extension;
its lines keep their file line numbers. A heading of the document is an ATX heading or a setext
heading ([CommonMark], Sections 4.2 and 4.3) whose parent block is the document: a heading
inside a block quote or a list item is not one, and the lines of code blocks and HTML blocks hold
none ([CommonMark], Sections 4.4 to 4.6).

> Note (non-normative): the implementation depends on `mdast-util-from-markdown`,
> `micromark-extension-gfm-table`, and `mdast-util-gfm-table`, which conform to these standards
> but for rare edge cases (lazy continuation after an HTML block start) and give every heading's
> start and end line; `marked`, present through the host, deviates from
> [CommonMark] in edge cases and gives no line positions.

- A heading's level is the length of its opening sequence for an ATX heading, `1` for a setext
  heading underlined with `=`, and `2` for one underlined with `-`.
- A heading's lines are its one line for an ATX heading, and its content lines and underline for
  a setext heading; its heading line is the first of them.
- A heading's text, kept as written (escapes, entities, and inline markup included), is the raw
  contents of an ATX heading ([CommonMark], Section 4.2), and for a setext heading its content
  lines, each without leading and trailing spaces and tabs, joined by one space.

Parsing MUST run off the host's main thread. The work one call runs off the main thread, its parses
included, MUST NOT take more than 10000 ms in total; when they reach it, the call MUST end as a tool error with the text
`<path> could not be parsed within 10000 ms; Markdown cannot handle this file` and MUST NOT
write the file. A parse running when the tool-call signal aborts MUST stop within 100 ms and
leave no work running: in the 200 ms that start 100 ms after the abort, the process MUST use less
than 50 ms of CPU time. A parse of a document of about 128 KiB that repeats one construct, a
paragraph in a block quote (`> a` and a blank line), a setext heading (`a` underlined with `=`),
or a nested list (`- a` with ` - b`), MUST take less than 5000 ms on a developer machine.

> Note (non-normative): measured, the CPU time after an abort is under 1 ms, against about
> 200 ms for a parse left running. The three parses each take 0.4 to 0.6 s with micromark 4.0.2
> and 17 to 34 s with 4.0.3 (docs/markdown.md); the bound only has to tell linear from quadratic
> time, so it sits ten times above the measurement, clear of a loaded machine.

> Note (non-normative): the parser's time grows with the square of the size on files with many
> lists or block quotes, so a file well within the size limit of [file access](#file-access) can exceed the
> budget.

### 2.3 Sections {#sections}

Each heading of the document starts one section, of the heading's level. A section ends at its
end line: the last non-blank line before the heading line of the next heading whose level is at
most its own, or before the end of the text when there is none. Its span is the lines from its
heading line to its end line.

- A section's parent is the section of the nearest preceding heading with a lower level; a
  section without one is a top-level section. Its subsections are the sections whose parent it
  is; its descendants are its subsections and, recursively, theirs. Its ancestors are its parent
  and the parent's ancestors.
- A section's own body is the lines from the first non-blank line after its heading's lines to
  the last non-blank line before the heading line of its first subsection, or to its end line
  when it has none; it is empty when the first non-blank line after its heading's lines is the
  heading line of a subsection, or when there is none within its span.
- The preamble is the lines of the document from its first non-blank line to the last non-blank
  line before the first heading line, or to the document's last non-blank line when it has no
  heading; the file has no preamble when its document's first non-blank line is a heading line,
  or when the document has no non-blank line. The preamble is not a section.

### 2.4 Section addresses {#section-addresses}

A section's component is its heading text, or `(untitled)` when the text is empty, followed by
` [<n>]` when `<n>` − 1 earlier sections with the same parent, or earlier top-level sections for
a top-level section, have the same heading text, compared exactly (`<n>` ≥ 2). Its full address
is the components of its ancestors from the top-level one down, then its own, joined by the
separator: a space, `>`, and a space.

A section address names a section. Its value is trimmed, then stripped, in this order and each at
most once, of a leading `* `, a leading line range `<a>-<b> ` (`<a>` and `<b>` decimal integers,
then one space), and a trailing ` (+<k> hidden)` (`<k>` a decimal integer). The stripped value
`(preamble)` names the preamble and `(document)` the document, where [validation](#validation) admits them,
whether or not a line range was stripped. Any other stripped value is split at each occurrence of
the separator into components, each trimmed and then stripped, at most once, of leading heading
marks `#{1,6} ` (one to six `#`, then one space). A section's reference span is its span
([sections](#sections)) in an `outline`, `read`, or `links` call; in an `edit` call it is the span, in the file before
the call, of the section whose heading it persists from through every earlier operation of the
call ([renumbering](#renumbering)), and it has none when there is no such section. A section matches when its own
component matches the last component and the other components, in their order, match components
of ancestors of it, in the same order, not necessarily consecutive; when a line range was
stripped, it matches only when its reference span starts at line `<a>` and ends at line `<b>`,
compared as integers, and a trailing ` [<n>]` (`<n>` a decimal integer) is removed from the last component and from its own
component before they are compared. Matching runs in up to four steps:

1. A component matches when it equals the other exactly.
2. When step 1 matches no section, a component matches when both are equal after
   normalization: every `` ` ``, `*`, and `_` removed, every maximal run of spaces and tabs
   replaced by one space, leading and trailing spaces removed, and the result converted by
   ECMAScript `String.prototype.toLowerCase` ([ECMA-262]).
3. When step 2 matches no section, a component matches when both are equal after removing a
   leading number prefix ([renumbering](#renumbering)) from each and then normalizing as in step 2.
4. When steps 1 to 3 match no section, a component matches when it matches under step 3, or
   when it is a number component and the section's heading text starts with a number prefix
   ([renumbering](#renumbering)) of the same number. A number component is a component that is, after an
   optional leading `Section ` (one space) or `§` and zero or more spaces and tabs, one or more
   runs of the digits `0` to `9` joined by single `.` characters, optionally followed by one more
   `.`, and nothing else; its number is the sequence of integers its runs denote.

In an `edit` call, an operation's address without a line range that resolves to a section `S`
MUST be rejected when an earlier operation of the call gave `S` its name by renumbering
([renumbering](#renumbering)) and another heading of the file before the call had that name. The name is `S`'s heading text when the
address resolves at step 1 or 2, and `S`'s number when it resolves at step 4 with a last
component that is a number component, which another heading has when its number is the same. The
error text is
`operations[<i>]: "<address>" now names <full>, renumbered by operation <j>; name it without its number, with an ancestor if needed`,
`<full>` being the full address of `S` and `<j>` the 0-based index of the last operation before
it that gave `S` that name.

> Note (non-normative): after a move renumbers `4.1 Examples` to `3.1 Examples`, an address the
> model copied from the outline it read would otherwise name the other section silently. A line
> range names a section of the file before the call, whose revision the call checked, so
> renumbering cannot redirect it.

An address that one section matches resolves to it. Otherwise the call MUST be rejected as a tool
error, prefixed `operations[<i>]: ` for an operation's address:

| Case                     | Error text                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Line range, none spans   | `no section "<address>" in <path> spans that line range; without it the address matches: <ranged>. Run outline for current line ranges.` |
| No section, similar ones | `no section "<address>" in <path>. Similar: <addresses>`                                                                                 |
| No section, none similar | `no section "<address>" in <path>. Run outline to list its sections.`                                                                    |
| Several sections         | `section "<address>" matches <m> sections in <path>: <addresses>. Put more of its path before it, joined by " > ".`                      |
| `(preamble)`, none       | `<path> has no preamble` (`read`, `links`)                                                                                               |

`<address>` is the trimmed value; `<m>` the number of matching sections; `<addresses>` the full
addresses, in document order and joined by `; `, of the first 5 matching sections, or of the
first 5 similar sections: those whose normalized component contains the normalized last
component. With a line range, an address that matches no section falls under the line-range
case when it matches some section without its line range, and otherwise under a case of no
section, chosen for the address without its line range, `<address>` still being the trimmed
value; it never matches several sections.
`<ranged>` holds, joined by `; ` and in document order, for each of the first 5 sections the
address without its line range matches at the first step that matches any section,
`<start>-<end> <full>`, `<start>` and `<end>` its reference span, or `(new) <full>` when it has
none, `<full>` being its full address in the text the address resolves against.

## 3. Action `outline` {#action-outline}

The candidates are every section, or, with `section`, the addressed section and its
descendants. `<d>` is `depth` when given; otherwise, with `<c>` the greater of `limit` and 100, the greatest level `L` among the candidates'
levels for which at most `<c>` candidates have a level at most `L`, the least of their levels
when none qualifies, and `6` when there is no candidate.

> Note (non-normative): the default is the most detail whose entries fit in `<c>`, so a small `limit` still pages. In a file with one
> `#` heading over everything, as each of pi-dent's specifications has, depth 1 lists a
> single line.

The entries are the candidates whose level is at most `<d>`, and with `section` the addressed
section whatever its level, in document order. The call MUST be rejected as a tool error with the
text `offset <offset> is past the last entry (<total> entries)` when `offset` is greater than 0
and at least `<total>`, the number of entries. The shown entries are the `limit` entries from
index `offset`.

The text is these lines, joined by one line feed, each present only under its condition:

| Line                                                                       | Condition                                                        |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `<path> · <lines> lines · revision <revision> · depth <d>`                 | always                                                           |
| `<start>-<end> (frontmatter)`                                              | the file has frontmatter, `section` is absent, `offset` is 0     |
| `<start>-<end> (preamble)`                                                 | the file has a preamble, `section` is absent, `offset` is 0      |
| for each shown entry, its entry line and, with `preview`, its preview line | —                                                                |
| `(no headings)`                                                            | the document has no heading                                      |
| `(no headings down to level <d>; the shallowest is level <l>)`             | the document has headings, and none is an entry                  |
| `More entries follow: repeat the call with offset: <next>`                 | `<next>`, `offset` plus the number shown, is less than `<total>` |

An entry line is `<start>-<end> <marks> <component><hidden>`: the section's heading line and end
line, `#` repeated as many times as its level, its component ([section addresses](#section-addresses)), and
` (+<k> hidden)` when `<k>`, the number of its descendants that are not entries, is at least 1,
else empty. A preview line is four spaces followed by the first line of the section's own body,
flattened (pi-dent-agent `specs/search-tool.md`, Section 3.4) and, when longer than 100 characters,
cut to its first 100 characters followed by `…` (U+2026); a section with an empty own body has
no preview line. `<lines>` is the file's line count, `<l>` the least level of the document's
headings, the word `lines` staying plural whatever the number, and `<start>` and `<end>` of the frontmatter and preamble their first and last lines.

`details` is
`{ action: "outline", path, revision, lines, depth, total, offset, more, frontmatter?, preamble?, entries: [<entry>…] }`:
`path` the absolute resolved path, `depth` `<d>`, `more` `true` exactly when the
`More entries follow` line is present, `frontmatter` and `preamble` `{ start, end }` under the
conditions of their lines, and `<entry>`, for each shown entry,
`{ address, level, start, end, hidden, preview? }`, `address` the full address and `preview` the
preview line's text without its four spaces.

## 4. Action `read` {#action-read}

The read range is the span of the addressed section, or the preamble's lines for `(preamble)`;
`<start>` and `<end>` are its first and last lines. The call MUST be rejected as a tool error
with the text `offset <offset> is outside <address> (lines <start>-<end>)` when `offset` is
outside that range, `<address>` being the full address or `(preamble)`.

The display lines are the range's lines in order, except that with `depth` each collapsed
section shows only its heading's lines followed, when its span has further lines, by one marker
line `[… <k> lines hidden: <first>-<last>]` in place of them, `<k>` being their number and
`<first>` and `<last>` their first and last lines. A collapsed section is a descendant of the
addressed section whose level is greater than `depth` and none of whose ancestors that are
descendants of the addressed section is collapsed. A display line's first and last lines are its
own line, or `<first>` and `<last>` for a marker line.

The shown lines are the display lines from the first whose last line is at least `offset`
(default `<start>`), as many as `limit` allows and while their text, joined by line feeds, stays
within 50000 characters; at least one is shown. A first shown line longer than 50000 characters
is cut to its first 50000 characters followed by `…`.

The text is these parts, joined by one line feed:

1. `<path> · <address> · lines <start>-<end> · revision <revision>`.
2. The shown lines, without their line endings.
3. `--- end of section ---` when the last display line is shown, else
   `--- cut: continue with offset <next> ---`, `<next>` being the first line of the first display
   line not shown.

`details` is
`{ action: "read", path, revision, address, level, start, end, from, to, next? }`: `level`
`null` for the preamble, `from` the first line of the first shown display line, `to` the last
file line the shown lines cover, and `next` `<next>`, present exactly when the cut line is.

## 5. Action `edit` {#action-edit}

### 5.1 Applying {#edit-applying}

An `edit` call MUST hold the host's file mutation queue for the resolved path — the per-file
serialization of the host's `edit` and `write` tools, keyed by the path with symbolic links
resolved — from before it reads the file until its write ends or it fails.

The operations apply in array order, each to the text the operations before it left, and each
operation's addresses resolve against that text, renumbering ([renumbering](#renumbering)) included, as [section addresses](#section-addresses) gives. When an operation fails a check of
[section addresses](#section-addresses) or [operations](#edit-operations), the call MUST be rejected with that error and MUST NOT write the file. When the resulting text equals the file's
text, the call MUST NOT write the file; otherwise it MUST write the result, with the file's
leading U+FEFF when it had one, over the file's content in place. A write that fails MUST reject
the call with the text `cannot write <path>: <code>`.

When the tool-call signal aborts before the write starts, the call MUST end as a tool error with
the text `Markdown aborted` and MUST NOT write the file; a write already started MUST be
completed, and the call returns its result. An aborted `outline`, `read`, or `links` call MUST end with the
same error.

The call MUST NOT change a line other than those [line rules](#edit-line-rules), [operations](#edit-operations), and [renumbering](#renumbering) give an operation to write,
replace, rewrite, or remove, nor the line ending of one, except as the line-ending rule below
gives.

Line endings: a line of the result that comes from a line of the text before the operation —
kept, re-placed by `move` or `set_level`, or rewritten by renaming, fitting, or renumbering —
keeps that line's line ending; a line that replaces several lines keeps the line ending of the
last of them. A line of `content` the call places, every empty line [line rules](#edit-line-rules) inserts, and a
former last line without a line ending that is no longer last take the file's line ending: that
of the file's first line, or a line feed when the file is empty or its first line has no line
ending. The result's last line ends with a line ending when the file's last line did or the file
was empty, and with none otherwise; this rule overrides the others of this paragraph.

No operation changes heading text other than `rename` and renumbering ([renumbering](#renumbering)).

### 5.2 Line rules {#edit-line-rules}

- The content block of `content` is its lines (split as in [file access](#file-access)) without leading and
  trailing blank lines; it can be empty.
- Placing a block at a position inserts its lines there; then, when the line before the block
  exists and is not blank, one empty line is inserted before it, and when the line after the
  block exists and is not blank, one empty line is inserted after it. Replacing lines by a block
  removes only those lines, without the removing rule below, and places the block where they
  were.
- Removing a range of lines removes them and every blank line directly after them; when no line
  remains after those, it also removes every blank line directly before them. When the lines
  that end up on either side of the removed lines both exist and are not blank, one empty line is
  inserted between them.
- A block parsed alone is the block's lines parsed as the document of [parsing](#parsing) is, with no
  frontmatter recognized.
- Fitting a block to level `L` parses the block alone and adds `L` minus the level of its first
  heading to the level of each of its headings. A heading whose level changes is
  rewritten: an ATX heading's opening sequence is replaced by `#` repeated as many times as the
  new level, the rest of its line kept; a setext heading's lines are replaced by one line of `#`
  repeated as many times as the new level, a space, and its heading text.

### 5.3 Operations {#edit-operations}

`X` is the section `section` names and `Y` the section `at` names, `section` resolved before `at`
per [section addresses](#section-addresses), both before the operation changes anything; `B` is the content block. For
`move`, `Y`'s heading lines, own body, and end line are those it has in the text the removal
left.

| `op`           | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replace`      | Replace `X`'s span by `B` fitted to `X`'s level.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `replace_body` | With `B` empty, remove `X`'s own body when it is not empty. Otherwise replace the own body by `B`, or, when the own body is empty, place `B` after `X`'s heading's lines. For `(preamble)` the preamble takes the place of the own body, and an absent preamble's place is before the first heading line, or the end of the text when there is none.                                                                                                                                               |
| `insert`       | Place `B`, fitted to the destination level, at the destination (below).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `delete`       | Remove `X`'s span.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `move`         | Remove `X`'s span; then place the span's lines, fitted to the destination level, at the destination in the text the removal left.                                                                                                                                                                                                                                                                                                                                                                  |
| `rename`       | Write the new text as `X`'s heading text: `heading`, trimmed, preceded, when `X`'s heading is numbered and `heading` has no number prefix ([renumbering](#renumbering)), by `X`'s prefix and the spaces and tabs after it. An ATX heading's raw contents are replaced by it, the rest of the line kept; one with empty raw contents becomes its opening sequence, one space, and the new text, any closing sequence dropped. A setext heading's content lines are replaced by one line holding it. |
| `set_level`    | Replace `X`'s span by itself fitted to `level`.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

| `position` | Destination with `at` a section `Y`                                                              | Destination level  | With `at` `(document)`                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------ |
| `before`   | Before `Y`'s heading line                                                                        | `Y`'s level        | —                                                                                          |
| `after`    | After `Y`'s end line                                                                             | `Y`'s level        | —                                                                                          |
| `first`    | After the last line of `Y`'s own body, or after `Y`'s heading's lines when the own body is empty | `Y`'s level plus 1 | Before the first heading line, or the end of the text when there is none; levels unchanged |
| `last`     | After `Y`'s end line                                                                             | `Y`'s level plus 1 | The end of the text; levels unchanged                                                      |

After its addresses resolve, each operation MUST further be rejected, the first failure reported,
in this order:

| Check                                                                                                                                                                                                                                                                                             | Error text                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `move`: `Y` is `X` or a descendant of `X`                                                                                                                                                                                                                                                         | `operations[<i>]: cannot move <address> to a place inside itself`                                                                                                          |
| `insert`, `move`: `position` is `first` or `last` and `Y`'s level is 6                                                                                                                                                                                                                            | `operations[<i>]: <address> is a level-6 section and can hold no subsection`                                                                                               |
| Fitting gives a heading a level above 6                                                                                                                                                                                                                                                           | `operations[<i>]: the section would need heading level <l>; levels stop at 6`                                                                                              |
| `set_level`: a section other than `X` and its descendants has a different parent after the operation than before it                                                                                                                                                                               | `operations[<i>]: set_level would change the parent of <m> other sections, first <other>; move <address> first, then set its level (move fits its level to the new place)` |
| `rename`: the heading text of `X` after the operation does not equal the new text                                                                                                                                                                                                                 | `operations[<i>]: "<heading>" cannot be written as heading text; it would read "<text>"`                                                                                   |
| The text after the operation has frontmatter and the text before it had none                                                                                                                                                                                                                      | `operations[<i>]: the edited text would make lines 1-<f> frontmatter`                                                                                                      |
| The sequence of the levels and heading texts of the document's headings after the operation is not the expected one: that of the headings before it, without those it removed, with those it wrote or placed, at the levels it gave them, and with the heading texts `rename` and renumbering set | `operations[<i>]: the edited text would not parse as intended near line <n>; check code fences and HTML blocks in the content or around line <n>`                          |

Renumbering ([renumbering](#renumbering)) completes each operation that is not rejected by the first four
checks; the last three checks see its result.

`<address>` is the full address of `X` in the `move` and `set_level` texts and of `Y` in the
level-6 text; `<l>` the greatest level fitting gives; `<m>`
the number of other sections whose parent changes and `<other>` the full address, before the
operation, of the first of them in document order; `<f>` the frontmatter's last line;
`<heading>` the new text; `<text>` the heading text the document would hold; `<n>` the heading
line of the first heading at which the document after the operation differs from the expected
headings, or the last line of the text when none does.

### 5.4 Renumbering {#renumbering}

A heading is numbered when its heading text starts with a number prefix: one or more runs of the
digits `0` to `9` joined by single `.` characters, optionally followed by one more `.` (the
trailing dot), followed by at least one space or tab and then another character. The prefix is
those digits and dots; its number is the sequence of integers its runs denote, its last component
the last of them, and its leading components the others. `3. Find` has number 3 with a trailing
dot and `3.1 Filters` number 3.1 without one; `Section 3`, `Appendix A`, `3) Find`, `v1.2 Notes`,
and `3.1Filters` are not numbered.

A group is the subsections of one section, its parent, or the top-level sections, which have no
parent; its numbered members are its members with a numbered heading, in document order. An
operation writes the headings of the `content` that `insert` and `replace` place; every other
heading of the text after the operation persists from the heading it was before, that of `X` and
its descendants included for `move`, `set_level`, and `rename`, whatever lines fitting, renaming,
or placing rewrote. A section persists when its heading does. A group before and a group after
the operation are the same group when their parents are the same persisting section, or both
absent.

The affected groups of an operation are, and no others:

1. each group whose members in document order differ before and after the operation, a member
   being the same when it is the same persisting section: a member was written into it, moved
   into or out of it, moved within it, or removed;
2. each group whose parent the operation wrote;
3. each group whose parent's number this renumbering changes.

`rename` and `replace_body` therefore affect no group. The base of an affected group is its
numbered members before the operation, with their numbers then, and the parent's base number is
the parent's number then; for a group of rule 2 both are as the operation wrote them, after
fitting. A group is renumbered when its base is empty and its parent's heading, as it now stands,
is numbered (the top-level group's never is), or when its base is not empty and:

- every number in the base has the same leading components;
- those are none, or the group has a parent, it is numbered, and they equal its base number; and
- the last components, in document order, are consecutive integers ascending by 1 from 0 or 1.

> Note (non-normative): the conditions keep version headings of a changelog, such as
> `## 1.2.0 Fixes`, which share the form, from being renumbered; every numbered group of pi-dent's
> specifications meets them.

Renumbering a group gives its `i`-th numbered member after the operation, counting from 0, the
number made of the leading components `P` followed by `s + i`. `s` is the last component of the
base's first number, or 1 when the base is empty; `P` is the parent's number as it now stands
when the base is empty or its leading components are not none, and none otherwise. The member's
prefix is replaced by the number's components in decimal without leading zeros, joined by `.`,
followed by `.` when the base's first number has a trailing dot, or, when the base is empty,
when `P` is none and the member's own prefix has one; the rest of its heading line is kept. A
setext member whose prefix changes is then rewritten as fitting rewrites it ([line rules](#edit-line-rules)), at its
level, since a written prefix can make its content line a list item. A
member that is not numbered keeps its text and takes no number, unless it is auto-numbered.

A group of rule 2, and the group of subsections of an auto-numbered section, whose parent's
heading as it now stands is numbered, is renumbered when its base is empty or every number in its
base has the same leading components, whatever the other two conditions give, with these `P`
and `s` in place of those above. When the base's first number has no leading components, the
group stays flat: `P` is none. Otherwise, when that number has leading components or the base
is empty, `P` is the parent's number as it now stands. In both cases `s` is the last component of
the base's first number when it is 0 or 1, and 1 otherwise or when the base is empty. Its
trailing dot follows the rule above.

> Note (non-normative): the leading-components condition still keeps a changelog's
> `### 1.2.0 Fixes` and `### 1.1.0 Fixes` under a numbered parent from being renumbered.

A heading that is not numbered and whose heading text is not empty is auto-numbered when:

- it is the heading of a section that an `insert` places, that a `replace` places in place of a
  numbered `X`, or that a `move` places into a group other than the one it left — the first
  heading of the content block, or `X` — and that section's group after the operation is
  renumbered with a base that is not empty; or
- it is the heading of a subsection of an auto-numbered section none of whose subsections is
  numbered.

An auto-numbered heading counts as a numbered member of its group, at its place and with no
trailing dot of its own, and takes the number renumbering gives it, written as above and followed
by one space before the first character of its heading text; the rest of its heading line is
kept, a setext heading rewritten as above. No other heading is auto-numbered: a section moved within its group, and one that replaces
an unnumbered `X`, keep an unnumbered heading.

Affected groups are renumbered from the top down: the top-level group first, then the others by
their parent's level, groups whose parents have the same level in document order of the parents.
A group that rule 3 adds is thus renumbered after its parent's group.

In pi-dent-agent `specs/search-tool.md` (code spans in heading texts left out), moving
`### 3.2 Matching` after `### 3.4 Result` makes the group of `## 3. Action find` read
`3.1 Candidates`, `3.2 Evaluation`, `3.3 Result`, `3.4 Matching`. Moving `## 4. Action get` as
the last subsection of `## 2. Scope`, whose subsections are `2.1` to `2.3`, makes it
`### 2.4 Action get`, its subsections, if any, `2.4.1` onwards, and the later sections
`4. Action sessions`, `5. Normative references`, and `6. Specification gaps`, each with its
subsections renumbered to its new number. Inserting `## Overview` with subsections `### Goals`
and `### Limits` after `## 1. Tool registration surface` writes them as `## 2. Overview`,
`### 2.1 Goals`, and `### 2.2 Limits`, and the former `2.` to `7.` become `3.` to `8.`, their
subsections with them; the report lists all of them. Written with `### 9.1 Goals` and
`### 9.3 Limits`, they become `2.1` and `2.2`; written with `### 1. Goals` and `### 3. Limits`,
they stay flat as `1. Goals` and `2. Limits`.

### 5.5 Result {#edit-result}

Each operation marks a line: `replace` and `insert` the heading line of the first heading they
wrote; `move`, `replace_body`, `rename`, and `set_level` the heading line of `X`, and
`replace_body` of `(preamble)` none; `delete` the heading line of `X`'s parent, when it has one.
A mark stays with its line through the later operations; on a line that `move` or `set_level`
re-places, or that fitting, renaming, or renumbering rewrites, it stays on the line that replaces
it, and it is lost with a removed line. The touched sections are those whose heading line bears a
mark after the last operation.

When the call wrote no change the text is `<path> unchanged · <lines> lines · revision <revision>`.
Otherwise the text is the line `Edited <path>: <k> operations · <lines> lines · revision <revision>`,
followed by one line per touched section and per ancestor of one, in document order: `* ` before
the entry line ([action `outline`](#action-outline)) of a touched section and two spaces before that of an ancestor that is
not touched, `<hidden>` counting the descendants without a line. Then follow these blocks, each
present only when it has at least one section, heading, or group to list:

1. The line `<q> sections removed or overwritten:`, then one line per removed section in their order before the
   call: two spaces, `<start>-<end> <marks> <text> (<n> lines, <s> subsections)`, where `<start>`
   and `<end>` are its span before the call ([sections](#sections)), `<marks>` and `<text>` its level and
   heading text before the call, `<n>` the number of lines of that span, and `<s>` its number of
   subsections before the call. `lines` and `subsections` stay plural whatever the number.
2. The line
   `<r> headings renumbered; references to their old numbers elsewhere in the text were not updated:`,
   then one line per renumbered heading in document order: two spaces,
   `<start> <marks> <old> → <new>`.
3. One line per skipped group in document order of its parent:
   `Numbering left as written under <parent>: its numbers <numbers> are not in sequence`.

Lines are joined by one line feed.

A removed section is a section of the file before the call whose heading does not persist
through every operation ([renumbering](#renumbering)): the `X` of a `delete` or `replace`, or a descendant of
it, even when the call writes its level and heading text again; `<q>` is their number.
A skipped group is a group of the text after the call whose base, in the last operation of the
call that affected it, was not empty, which that operation did not renumber, and which has at
least one numbered member after the call; its parent, when
it has one, is a heading of the text after the call; `<parent>` is the full address of its
parent, or `(document)` for the top-level group, and `<numbers>` the numbers of its numbered
members after the call, each written as its prefix is, joined by `, `.

A renumbered heading is a heading of the file before the call that persists through every
operation and whose prefix after the call differs from its prefix before, or a heading the call
wrote whose prefix after the call differs from its prefix as written, a heading without a prefix
counting as having an empty one; `<old>` is its heading text before the call, or as written,
`<new>` its heading text after the call, `<start>` its heading line after it, `<marks>`
`#` repeated as many times as its level, and `<r>` their number. `<k>` is the number of
operations; the words `operations`, `headings`, `sections`, and `lines` stay plural whatever the number. `<lines>` is
the result's line count, and `<revision>` the revision of the bytes written, or of the file when
unchanged.

`details` is
`{ action: "edit", path, revision, previousRevision, changed, lines, touched: [{ address, level, start, end }…], removed: [{ start, end, level, text, subsections }…], renumbered: [{ start, level, from, to }…], skipped: [{ parent, numbers: [<number>…] }…] }`:
`previousRevision` the revision checked, `changed` whether the file was written, and the arrays
holding the touched sections, removed sections, renumbered headings, and skipped groups in the
orders above, `from` and `to` being `<old>` and `<new>`, `end` and `subsections` of each removed section being as block 1 gives them, and each `<number>` a prefix as written.

## 6. Action `links` {#action-links}

This action parses the document as [parsing](#parsing) does, with the extended autolinks of [GFM],
Section 6.9, in addition; the extension changes no block structure, so the sections are those of
[sections](#sections). The scope is the span of the addressed section, the preamble's lines for
`(preamble)`, or, without `section`, every line of the document.

### 6.1 Items {#link-items}

The items are the following elements of the document that start on a line of the scope, in
document order of their start; an element inside another, such as an image in a link's text,
follows it. The links of code spans, code blocks, HTML blocks, and raw HTML ([CommonMark],
Sections 4.4 to 4.6 and 6.1 and 6.6) are text and give no item.

| Kind                  | Element                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `link`                | An inline link ([CommonMark], Section 6.3)                                                                                                                                      |
| `image`               | An inline image ([CommonMark], Section 6.4)                                                                                                                                     |
| `reference`           | A full, collapsed, or shortcut reference link ([CommonMark], Section 6.3)                                                                                                       |
| `image-reference`     | A full, collapsed, or shortcut reference image ([CommonMark], Section 6.4)                                                                                                      |
| `autolink`            | An autolink ([CommonMark], Section 6.5) or an extended autolink ([GFM], Section 6.9)                                                                                            |
| `unused-definition`   | A link reference definition ([CommonMark], Section 4.7) whose label no reference link or reference image of the document matches, or that follows another with a matching label |
| `undefined-reference` | A full or collapsed reference link or image that the document would hold if a link reference definition matched its label, and that it does not hold because none does          |

Matching is that of link labels ([CommonMark], Section 4.7). An item's fields are:

- `line`: the line its first character is on.
- `destination`: for `link` and `image`, the link destination, and for `unused-definition` that
  of the definition, without enclosing `<` and `>`, with backslash escapes and entity and numeric
  character references decoded ([CommonMark], Sections 2.4 and 2.5); for `reference` and
  `image-reference`, that of the first definition its label matches; for `autolink`, its text
  as written, without enclosing `<` and `>`; absent for `undefined-reference`.
- `label`: for `reference`, `image-reference`, and `undefined-reference`, the link label as
  written, or for a collapsed or shortcut one the link text as written; for
  `unused-definition`, the definition's label as written; else absent.
- `text`: for `link`, `image`, and a full `reference`, `image-reference`, or
  `undefined-reference`, its link text or image description as written; else absent.

A label or text as written is the source between its brackets, flattened
(pi-dent-agent `specs/search-tool.md`, Section 3.4) and, when longer than 60
characters, cut to its first 60 characters followed by `…`.

> Note (non-normative): a shortcut `[x]` with no definition is plain text, as in a task list or
> a quoted array, so it is never an `undefined-reference`.

### 6.2 Result {#links-result}

The call MUST be rejected as a tool error with the text
`offset <offset> is past the last item (<total> items)` when `offset` is greater than 0 and at
least `<total>`, the number of items. The shown items are the `limit` items from index
`offset`.

The text is these lines, joined by one line feed, each present only under its condition:

| Line                                                     | Condition                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `<path> · <scope> · <total> items · revision <revision>` | always                                                           |
| for each shown item, its item line                       | —                                                                |
| `(no items)`                                             | `<total>` is 0                                                   |
| `More items follow: repeat the call with offset: <next>` | `<next>`, `offset` plus the number shown, is less than `<total>` |

`<scope>` is the full address of the addressed section, `(preamble)`, or `(document)`; the word
`items` stays plural whatever the number. An item line is `<line> <kind>`, followed by
` <destination>` when the item has one (`<>` when it is empty), ` [<label>]` when it has a label, and ` · <text>` when
it has a text.

`details` is
`{ action: "links", path, revision, scope, total, offset, more, items: [{ line, kind, destination?, label?, text? }…] }`:
`path` the absolute resolved path, `scope` `<scope>`, `more` `true` exactly when the
`More items follow` line is present, and `items` the shown items with their fields.

## 7. Rendering in the conversation {#rendering}

The host draws each call in its default tool shell and its result as its text. `renderCall`
MUST show lines joined by one line feed: `Markdown <action> <path>`, followed by ` › <section>`
when `section` is given; for `edit`, then one line per operation: two spaces, then the values of
its `op`, `section`, `position`, and `at` that are strings, in that order, joined by one space.
While the host is still receiving the arguments, a value that is not yet a string is left out,
and `renderCall` MUST NOT throw. The component `renderCall` returns MUST carry no horizontal
padding and no background of its own.

## 8. Normative references {#normative-references}

- [CommonMark] CommonMark Spec, version 0.31.2 (2024-01-28), J. MacFarlane: Section 2.1
  (characters, lines, line endings, blank lines), Sections 2.4 and 2.5 (backslash escapes, entity
  and numeric character references), Section 4 (leaf blocks, including ATX and setext headings,
  code blocks, HTML blocks, and link reference definitions), Section 5 (container blocks), and
  Section 6 (inlines: code spans, links, images, autolinks, and raw HTML).
- [GFM] GitHub Flavored Markdown Spec, version 0.29-gfm (2019-04-06): Section 4.10 (tables
  extension) and Section 6.9 (autolinks extension).
- [FIPS 180-4] Secure Hash Standard (SHS), FIPS PUB 180-4, NIST, August 2015: SHA-256.
- [ECMA-262] ECMAScript Language Specification, 14th edition (June 2023), Ecma International:
  `String.prototype.toLowerCase` and `Number.isInteger`.

## 9. Specification gaps {#specification-gaps}

- A heading whose text contains the separator of [section addresses](#section-addresses) cannot be named by an address that
  includes its text.
- A heading whose text starts with `* ` or `<a>-<b> ` (such as `2024-2025 Roadmap`) cannot be
  named by an address that starts with that text, and a heading whose text starts with heading
  marks cannot be named by a component that starts with that text, because [section addresses](#section-addresses) strips it
  first.
- A line copied from a result older than the file's revision names no section whose span has
  changed since.
- The frontmatter cannot be named by an address; a copied `(frontmatter)` outline line names no
  section.
- A heading whose text ends with ` (+<k> hidden)` cannot be named by an address that ends with that text, because [section addresses](#section-addresses) strips that suffix first.
- A heading whose text is `(preamble)` or `(document)` cannot be named by an address that is
  that text alone.
- Two siblings whose components coincide, such as a heading written `X [2]` and the second of two
  headings `X`, match the same component and cannot be told apart by it.
- Frontmatter in another form than `---` lines, such as TOML between `+++` lines, is parsed as
  Markdown, and so is frontmatter that the host's resource parser accepts but [parsing](#parsing) does
  not, such as a line 1 of `----` or `---yaml`.
- A file whose line 1 is a `---` thematic break and that has a later `---` line has everything
  between them taken as frontmatter, headings included.
- A heading whose text is `(untitled)` has the same component as a heading with empty text.
- A link reference definition stays in the section that holds it; moving or deleting that section
  can leave links elsewhere unresolved, and no check reports it.
- A process that changes the file outside the host's file mutation queue between an `edit`
  call's read and its write is overwritten; the write is in place, so a crash during it can leave
  the file partly written.
- Apart from parsing ([parsing](#parsing)), no bound is set on how soon an aborted call ends.
- The characters of a line beyond its first 50000 cannot be read by `read`.
- A heading written as HTML (`<h2>`) is not a heading of the document.
- Renumbering rewrites heading prefixes only: a reference to a number in body text, such as
  "Section 3.1", a link to a heading's anchor, in this file or another, and a number in a
  heading's text after its prefix are not updated.
- Numbering that the prefix form of [renumbering](#renumbering) does not cover — letters, roman numerals,
  `Section 3`, `3)` — and a group that fails the conditions of [renumbering](#renumbering) are not renumbered.
- A heading whose text starts with a number that is not a section number, such as
  `2024 Roadmap`, cannot be told from a numbered heading; [renumbering](#renumbering) treats it as numbered.
- A heading such as `### 2 factor auth` is numbered by the form of [renumbering](#renumbering), and is
  renumbered when placed under a numbered parent whose other subsections are unnumbered.
- Renumbering writes numbers without leading zeros, so a zero-padded group such as `## 01. Intro`
  loses its padding when first renumbered.
- Footnotes, which neither [CommonMark] nor [GFM] specifies, are not parsed: `[^1]` with a `[^1]: <text>` line gives a
  `reference` item and uses that line as its link reference definition, and `[^1]` without one
  gives no item.
- Whether the host, when it validates against the schema of [parameter schema](#parameters), first coerces an
  argument to the type the schema names is the host's.
