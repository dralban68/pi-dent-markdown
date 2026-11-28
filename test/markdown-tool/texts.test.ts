import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  MARKDOWN_DESCRIPTION,
  MARKDOWN_PARAMETER_DESCRIPTIONS,
  MARKDOWN_PROMPT_SNIPPET,
  MARKDOWN_TOOL_NAME,
  makeMarkdownTool,
  markdownOperationSchema,
  markdownParameterSchema,
  markdownRuntime,
  prepareMarkdownArguments,
} from "../../lib/markdown-tool.ts";
import { must } from "../support/must.ts";

/**
 * specs/markdown-tool.md#registration, specs/markdown-tool.md#argument-preparation, and
 * specs/markdown-tool.md#model-facing-texts: the model-facing texts are
 * registered verbatim, the schema admits exactly the table's properties, and the
 * argument preparation repairs the two `operations` shapes. The texts are read
 * out of the specification itself, so code and specification cannot drift.
 */

const spec = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "specs", "markdown-tool.md"),
  "utf8",
);

/** The body of the first fenced `text` block after `marker`. */
function blockAfter(marker: string): string {
  const from = spec.indexOf(marker);
  assert.equal(from >= 0, true, marker);
  const open = spec.indexOf("```text\n", from);
  const close = spec.indexOf("\n```", open);
  assert.equal(open >= 0 && close > open, true, marker);
  return spec.slice(open + "```text\n".length, close);
}

/** The specs/markdown-tool.md#model-facing-texts parameter table's `description` column, by field. */
function tableDescriptions(): Record<string, string> {
  const from = spec.indexOf("| Field                   | `description`");
  assert.equal(from >= 0, true);
  const to = spec.indexOf("\n\n", from);
  const descriptions: Record<string, string> = {};
  for (const line of spec.slice(from, to).split("\n")) {
    const match = /^\| `([a-zA-Z.[\]]+)`\s+\| `(.*)`\s+\|$/.exec(line);
    if (match === null) continue;
    const field = match[1];
    const description = match[2];
    if (field === undefined || description === undefined) continue;
    descriptions[field] = description;
  }
  return descriptions;
}

const tool = makeMarkdownTool(markdownRuntime());

/** A value as a JSON object, or an empty object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The registered tool's schema, as a JSON object. */
const schema = markdownParameterSchema as Record<string, unknown>;

/** A schema's properties, as JSON objects. */
function propertiesOf(value: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const properties = value.properties;
  assert.equal(typeof properties, "object");
  return properties as Record<string, Record<string, unknown>>;
}

test("the tool registers its name, label, description, and promptSnippet (specs/markdown-tool.md#registration)", () => {
  assert.equal(tool.name, MARKDOWN_TOOL_NAME);
  assert.equal(MARKDOWN_TOOL_NAME, "Markdown");
  assert.equal(tool.label, "Markdown");
  assert.equal(tool.description, MARKDOWN_DESCRIPTION);
  assert.equal(tool.promptSnippet, MARKDOWN_PROMPT_SNIPPET);
  assert.equal("renderShell" in tool, false);
  assert.equal(typeof tool.prepareArguments, "function");
});

test("the description and promptSnippet are the specification's texts, verbatim (specs/markdown-tool.md#model-facing-texts)", () => {
  assert.equal(MARKDOWN_DESCRIPTION, blockAfter("The `description` is"));
  assert.equal(MARKDOWN_PROMPT_SNIPPET, blockAfter("The `promptSnippet` is"));
});

test("every parameter and operation property carries its specs/markdown-tool.md#model-facing-texts description", () => {
  const wanted = tableDescriptions();
  const fields = propertiesOf(schema);
  for (const field of [
    "action",
    "path",
    "section",
    "sections",
    "depth",
    "preview",
    "offset",
    "limit",
    "revision",
    "operations",
  ]) {
    const property = fields[field];
    assert.notEqual(property, undefined, field);
    assert.equal(property?.description, wanted[field], field);
  }
  const operationFields = propertiesOf(
    markdownOperationSchema as unknown as Record<string, unknown>,
  );
  for (const field of ["op", "section", "position", "at", "content", "heading", "level"]) {
    const property = operationFields[field];
    assert.notEqual(property, undefined, field);
    assert.equal(property?.description, wanted[`operations[].${field}`], field);
  }
  assert.deepEqual(
    {
      action: MARKDOWN_PARAMETER_DESCRIPTIONS.action,
      path: MARKDOWN_PARAMETER_DESCRIPTIONS.path,
    },
    { action: wanted.action, path: wanted.path },
  );
});

test("the operation element schema carries no description of its own, and no alternative does", () => {
  const element = markdownOperationSchema as unknown as Record<string, unknown>;
  assert.equal("description" in element, false);
  for (const property of Object.values(propertiesOf(element))) {
    for (const alternative of Array.isArray(property.anyOf) ? property.anyOf : []) {
      assert.equal(typeof alternative, "object");
      assert.equal("description" in (alternative as Record<string, unknown>), false);
    }
  }
});

test("the schema admits exactly the specs/markdown-tool.md#parameters properties and no others", () => {
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["action", "path"]);
  assert.deepEqual(propertiesOf(schema).action?.enum, ["outline", "read", "edit", "links"]);
  assert.deepEqual(Object.keys(propertiesOf(schema)).toSorted(), [
    "action",
    "depth",
    "limit",
    "offset",
    "operations",
    "path",
    "preview",
    "revision",
    "section",
    "sections",
  ]);
  const element = markdownOperationSchema as unknown as Record<string, unknown>;
  assert.equal(element.additionalProperties, false);
  assert.deepEqual(element.required, ["op"]);
  const operations = must(propertiesOf(schema).operations);
  const alternatives = must(operations.anyOf);
  assert.equal(Array.isArray(alternatives), true);
  const list: unknown[] = Array.isArray(alternatives) ? alternatives : [];
  const array = list.find(
    (alternative) =>
      typeof alternative === "object" && alternative !== null && "items" in alternative,
  );
  assert.notEqual(array, undefined);
  const arraySchema: Record<string, unknown> = isRecord(array) ? array : {};
  assert.equal(arraySchema.minItems, 1);
  assert.equal(arraySchema.maxItems, 50);
  assert.equal(isRecord(arraySchema.items), true);
});

test("prepareArguments turns a JSON string or a lone object into an operations array (specs/markdown-tool.md#argument-preparation)", () => {
  const operations = [{ op: "delete", section: "A" }];
  assert.deepEqual(
    prepareMarkdownArguments({ action: "edit", operations: JSON.stringify(operations) }),
    {
      action: "edit",
      operations,
    },
  );
  assert.deepEqual(prepareMarkdownArguments({ action: "edit", operations: operations[0] }), {
    action: "edit",
    operations,
  });
  assert.deepEqual(
    prepareMarkdownArguments({ action: "edit", operations: JSON.stringify(operations[0]) }),
    { action: "edit", operations },
  );
  assert.deepEqual(prepareMarkdownArguments({ action: "edit", operations }), {
    action: "edit",
    operations,
  });
});

test("prepareArguments leaves every other argument unchanged (specs/markdown-tool.md#argument-preparation)", () => {
  const untouched = { action: "outline", path: "a.md", depth: 2 };
  assert.deepEqual(prepareMarkdownArguments(untouched), untouched);
  assert.deepEqual(prepareMarkdownArguments({ operations: "null" }), { operations: "null" });
  assert.deepEqual(prepareMarkdownArguments({ operations: "not json" }), {
    operations: "not json",
  });
  assert.deepEqual(prepareMarkdownArguments({ operations: 7 }), { operations: 7 });
  assert.deepEqual(prepareMarkdownArguments({ operations: null }), { operations: null });
  assert.equal(prepareMarkdownArguments(undefined), undefined);
  assert.equal(prepareMarkdownArguments("x"), "x");
});
