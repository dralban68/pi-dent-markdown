// Loaded with `--import` into a worker of this package when the package is installed under
// node_modules, where Node refuses to strip TypeScript types (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
// It strips them the same way Node does for files outside node_modules.
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

function strip(source) {
  // stripTypeScriptTypes emits an ExperimentalWarning on first use; the worker's stderr is the user's terminal.
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return stripTypeScriptTypes(source);
  } finally {
    process.emitWarning = emitWarning;
  }
}

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".ts") && url.includes("/node_modules/")) {
      return {
        format: "module",
        source: strip(readFileSync(fileURLToPath(url), "utf8")),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
