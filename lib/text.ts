// Copied verbatim from pi-dent's lib/search-eval.ts: the flattening the Markdown tool uses.
// "Section 3.4" in the doc comment names pi-dent's specs/search-tool.md.

// eslint-disable-next-line no-control-regex
const WHITE_RUN = /[\s\x00-\x1f\x7f-\x9f]+/g;

/**
 * A string with every maximal run of white space and of U+0000–U+001F and
 * U+007F–U+009F replaced by one space, and one leading and one trailing space
 * removed (Section 3.4).
 */
export function flattenText(text: string): string {
  const collapsed = text.replace(WHITE_RUN, " ");
  return collapsed.replace(/^ /, "").replace(/ $/, "");
}
