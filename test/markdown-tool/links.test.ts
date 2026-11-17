import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { markdownRuntime, type ToolResult } from "../../lib/markdown-tool.ts";

const path = "/work/doc.md";
const runtime = (text: string, parseBudgetMs?: number) =>
  markdownRuntime({
    readFile: () => new TextEncoder().encode(text),
    ...(parseBudgetMs === undefined ? {} : { parseBudgetMs }),
  });
const run = (text: string, params: Record<string, unknown> = {}, parseBudgetMs?: number) =>
  runtime(text, parseBudgetMs).execute({
    params: { action: "links", path, ...params },
    cwd: "/work",
    signal: undefined,
  });
const textOf = (result: ToolResult): string =>
  result.content[0]?.type === "text" ? result.content[0].text : "";
const revision = (text: string): string =>
  createHash("sha256").update(new TextEncoder().encode(text)).digest("hex").slice(0, 8);

test("links returns all seven kinds, reference forms, URI/email and GFM autolinks exactly", async () => {
  const source =
    "[inline](u) ![img](i) [full][id] [collapsed][] [shortcut] ![full image][id] <https://x.test> <a@b.test>\n\n[id]: target\n[collapsed]: c\n[shortcut]: s\n[unused]: unused\n\n[missing][absent] ![missing image][absent-image]";
  const result = await run(source);
  const details = result.details as {
    action: string;
    path: string;
    revision: string;
    scope: string;
    total: number;
    offset: number;
    more: boolean;
    items: Array<Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(details).toSorted(), [
    "action",
    "items",
    "more",
    "offset",
    "path",
    "revision",
    "scope",
    "total",
  ]);
  assert.equal(details.action, "links");
  assert.equal(details.path, path);
  assert.equal(details.revision, revision(source));
  assert.equal(details.scope, "(document)");
  assert.equal(details.total, details.items.length);
  assert.equal(details.offset, 0);
  assert.equal(details.more, false);
  assert.deepEqual(details.items, [
    { line: 1, kind: "link", destination: "u", text: "inline" },
    { line: 1, kind: "image", destination: "i", text: "img" },
    { line: 1, kind: "reference", destination: "target", label: "id", text: "full" },
    { line: 1, kind: "reference", destination: "c", label: "collapsed" },
    { line: 1, kind: "reference", destination: "s", label: "shortcut" },
    { line: 1, kind: "image-reference", destination: "target", label: "id", text: "full image" },
    { line: 1, kind: "autolink", destination: "https://x.test" },
    { line: 1, kind: "autolink", destination: "a@b.test" },
    { line: 6, kind: "unused-definition", destination: "unused", label: "unused" },
    { line: 8, kind: "undefined-reference", label: "absent", text: "missing" },
    { line: 8, kind: "undefined-reference", label: "absent-image", text: "missing image" },
  ]);
  assert.equal(
    textOf(result),
    `${path} · (document) · 11 items · revision ${revision(source)}\n1 link u · inline\n1 image i · img\n1 reference target [id] · full\n1 reference c [collapsed]\n1 reference s [shortcut]\n1 image-reference target [id] · full image\n1 autolink https://x.test\n1 autolink a@b.test\n6 unused-definition unused [unused]\n8 undefined-reference [absent] · missing\n8 undefined-reference [absent-image] · missing image`,
  );
});

test("links decodes escaped and entity destinations, strips angle brackets, and preserves empty destinations", async () => {
  const source = String.raw`[escape](<a\(b\)>) [entity](a&amp;b) [empty](<>)`;
  const result = await run(source);
  const details = result.details as { items: Array<Record<string, unknown>> };
  assert.deepEqual(details.items, [
    { line: 1, kind: "link", destination: "a(b)", text: "escape" },
    { line: 1, kind: "link", destination: "a&b", text: "entity" },
    { line: 1, kind: "link", destination: "", text: "empty" },
  ]);
  assert.equal(
    textOf(result),
    `${path} · (document) · 3 items · revision ${revision(source)}\n1 link a(b) · escape\n1 link a&b · entity\n1 link <> · empty`,
  );
});

test("links flattens raw label/text whitespace and controls, truncates at 60 UTF-16 units, and orders nested links", async () => {
  const long = "😀".repeat(40);
  const source = `[outer ![${long}](img)](link)\n\n[x  \n y\\\nz](d)`;
  const result = await run(source);
  const details = result.details as { items: Array<Record<string, unknown>> };
  assert.deepEqual(details.items, [
    { line: 1, kind: "link", destination: "link", text: `${`outer ![${long}`.slice(0, 60)}…` },
    { line: 1, kind: "image", destination: "img", text: `${long.slice(0, 60)}…` },
    { line: 3, kind: "link", destination: "d", text: "x y\\ z" },
  ]);
});

test("links scopes section/preamble, excludes frontmatter and BOM, and resolves globally defined links", async () => {
  const source =
    "\uFEFF---\ntitle: '[meta](no)'\n---\n[preamble][outside]\n\n# One\n[inside][outside]\n\n# Two\n[out][unused]\n\n[outside]: yes\n[unused]: no";
  const preamble = await run(source, { section: "(preamble)" });
  assert.deepEqual((preamble.details as { items: unknown[] }).items, [
    { line: 4, kind: "reference", destination: "yes", label: "outside", text: "preamble" },
  ]);
  assert.equal(
    textOf(preamble),
    `${path} · (preamble) · 1 items · revision ${revision(source)}\n4 reference yes [outside] · preamble`,
  );
  const section = await run(source, { section: "One" });
  assert.equal((section.details as { scope: string }).scope, "One");
  assert.deepEqual((section.details as { items: Array<Record<string, unknown>> }).items, [
    { line: 7, kind: "reference", destination: "yes", label: "outside", text: "inside" },
  ]);
  const whole = await run(source);
  assert.equal(
    (whole.details as { items: Array<Record<string, unknown>> }).items.some(
      (item) => item.kind === "unused-definition" && item.label === "outside",
    ),
    false,
  );
  const absent = await run("# Heading\n[link](x)", { section: "(preamble)" });
  assert.equal(textOf(absent), "/work/doc.md has no preamble");
  assert.equal(absent.isError, true);
});

test("links excludes code and raw HTML, supports multiline missing labels, and ignores unmatched shortcut text", async () => {
  const source =
    "`[code](x)`\n\n```md\n[y](z)\n```\n\n<div>[html](x)</div>\n\n[missing][\n  multi\n]\n\n[unmatched] `backtick\n\n[explicit][nope]";
  const result = await run(source);
  const items = (result.details as { items: Array<Record<string, unknown>> }).items;
  assert.deepEqual(items, [
    { line: 9, kind: "undefined-reference", label: "multi", text: "missing" },
    { line: 15, kind: "undefined-reference", label: "nope", text: "explicit" },
  ]);
});

test("links respects duplicate definitions, usage outside scope, and definition items", async () => {
  const source =
    "# Used\n[x][id]\n\n# Else\n[outside] [other]\n\n[id]: first\n[id]: second\n[other]: value";
  const section = await run(source, { section: "Used" });
  assert.deepEqual((section.details as { items: unknown[] }).items, [
    { line: 2, kind: "reference", destination: "first", label: "id", text: "x" },
  ]);
  const whole = await run(source);
  const all = (whole.details as { items: Array<Record<string, unknown>> }).items;
  assert.equal(
    all.some((item) => item.kind === "unused-definition" && item.label === "other"),
    false,
  );
  assert.equal(
    all.some((item) => item.kind === "unused-definition" && item.label === "id"),
    true,
  );
});

test("links reports empty results, empty-scope offsets, and paged complete results", async () => {
  const none = await run("plain text");
  assert.equal(
    textOf(none),
    `${path} · (document) · 0 items · revision ${revision("plain text")}\n(no items)`,
  );
  const emptyPage = await run("plain text", { offset: 1 });
  assert.equal(textOf(emptyPage), "offset 1 is past the last item (0 items)");
  const source = "[a](a) [b](b) [c](c)";
  const first = await run(source, { limit: 2 });
  assert.equal(
    textOf(first),
    `${path} · (document) · 3 items · revision ${revision(source)}\n1 link a · a\n1 link b · b\nMore items follow: repeat the call with offset: 2`,
  );
  assert.deepEqual((first.details as { items: unknown[] }).items, [
    { line: 1, kind: "link", destination: "a", text: "a" },
    { line: 1, kind: "link", destination: "b", text: "b" },
  ]);
  const second = await run(source, { offset: 2 });
  assert.equal(
    textOf(second),
    `${path} · (document) · 3 items · revision ${revision(source)}\n1 link c · c`,
  );
  assert.equal(
    textOf(await run("[a](a)", { offset: 1 })),
    "offset 1 is past the last item (1 items)",
  );
});

test("links validates unsupported fields and checks 3, 6, and 8 before file access", async () => {
  for (const [params, expected] of [
    [{ depth: 2 }, "depth is not valid for action links"],
    [{ section: "" }, "section must be a non-empty string"],
    [{ offset: -1 }, "offset must be a non-negative integer"],
    [{ offset: 1.5 }, "offset must be a non-negative integer"],
    [{ limit: 0 }, "limit must be an integer from 1 to 500"],
    [{ limit: 501 }, "limit must be an integer from 1 to 500"],
  ] as const) {
    const result = await run("[a](x)", params);
    assert.equal(result.isError, true);
    assert.equal(textOf(result), expected);
    assert.deepEqual(result.details, {});
  }
});

test("links inventories GFM literal autolinks and collapsed and shortcut image references", async () => {
  const source =
    "www.example.com, https://example.com/a). user@example.com\n![collapsed][] ![shortcut] [missing][] ![missing-image][]\n\n[collapsed]: /c\n[shortcut]: /s";
  const result = await run(source);
  assert.deepEqual((result.details as { items: unknown[] }).items, [
    { line: 1, kind: "autolink", destination: "www.example.com" },
    { line: 1, kind: "autolink", destination: "https://example.com/a" },
    { line: 1, kind: "autolink", destination: "user@example.com" },
    { line: 2, kind: "image-reference", destination: "/c", label: "collapsed" },
    { line: 2, kind: "image-reference", destination: "/s", label: "shortcut" },
    { line: 2, kind: "undefined-reference", label: "missing" },
    { line: 2, kind: "undefined-reference", label: "missing-image" },
  ]);
});

test("links preserves raw markup, flattens controls, and cuts both text and labels", async () => {
  const label = "L".repeat(61);
  const source = `[*raw* &amp; \\*\u0001\u0085text][${label}]\n\n[${label}]: <a&#x26;b>\n[unused${label}]: <>`;
  const result = await run(source);
  assert.deepEqual((result.details as { items: unknown[] }).items, [
    {
      line: 1,
      kind: "reference",
      destination: "a&b",
      label: "L".repeat(60) + "…",
      text: "*raw* &amp; \\* text",
    },
    {
      line: 4,
      kind: "unused-definition",
      destination: "",
      label: ("unused" + label).slice(0, 60) + "…",
    },
  ]);
});

test("links preserves brackets inside inline markup and inventories image descriptions", async () => {
  const source =
    '[a `]` <span title="[x]"> b](url)\n![a [b](foo]bar) ![nested][id]](img)\n\n[id]: /nested';
  const result = await run(source);
  assert.deepEqual((result.details as { items: unknown[] }).items, [
    { line: 1, kind: "link", destination: "url", text: 'a `]` <span title="[x]"> b' },
    { line: 2, kind: "image", destination: "img", text: "a [b](foo]bar) ![nested][id]" },
    { line: 2, kind: "link", destination: "foo]bar", text: "b" },
    { line: 2, kind: "image-reference", destination: "/nested", label: "id", text: "nested" },
  ]);
});

test("links matches normalized labels and finds missing escaped and quoted multiline labels", async () => {
  const source =
    "[full][Straße]\n\n[STRASSE]: /first\n[Straße]: /duplicate\n\n[x][a\\[b\\]]\n\n> [quote][multi\n> label]";
  const result = await run(source);
  assert.deepEqual((result.details as { items: unknown[] }).items, [
    { line: 1, kind: "reference", destination: "/first", label: "Straße", text: "full" },
    { line: 4, kind: "unused-definition", destination: "/duplicate", label: "Straße" },
    { line: 6, kind: "undefined-reference", label: "a\\[b\\]", text: "x" },
    { line: 8, kind: "undefined-reference", label: "multi > label", text: "quote" },
  ]);
});

test("links observes abort and parse-budget failures", async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = await runtime("[a](x)").execute({
    params: { action: "links", path },
    cwd: "/work",
    signal: controller.signal,
  });
  assert.equal(aborted.isError, true);
  assert.equal(textOf(aborted), "Markdown aborted");
  const budget = await run("[a](x)", {}, 0);
  assert.equal(budget.isError, true);
  assert.equal(
    textOf(budget),
    "/work/doc.md could not be parsed within 0 ms; Markdown cannot handle this file",
  );
});
