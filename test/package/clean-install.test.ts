import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The published package loads from a clean install (specs/markdown-tool.md#published-package): the
 * host omits `devDependencies` and supplies the host packages itself through its loader's aliases.
 * The stage holds only `dependencies`, and its bare host-module imports resolve exactly where the
 * extension loader of the pinned @earendil-works/pi-coding-agent resolves them.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  files: string[];
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/**
 * The host-module specifiers the extension loader aliases, each mapped to the checkout module its
 * alias resolves to: the root of @earendil-works/pi-ai maps to its compat entrypoint, the
 * @sinclair/typebox names map to the typebox package, and the @mariozechner names map to the
 * @earendil-works packages, as the host's virtual modules do.
 */
const ALIASED: Record<string, string> = {
  typebox: "typebox",
  "typebox/compile": "typebox/compile",
  "typebox/value": "typebox/value",
  "@sinclair/typebox": "typebox",
  "@sinclair/typebox/compile": "typebox/compile",
  "@sinclair/typebox/value": "typebox/value",
  "@earendil-works/pi-agent-core": "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui": "@earendil-works/pi-tui",
  "@earendil-works/pi-ai": "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-ai/compat": "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-ai/models": "@earendil-works/pi-ai/models",
  "@earendil-works/pi-ai/oauth": "@earendil-works/pi-ai/oauth",
  "@earendil-works/pi-ai/providers/all": "@earendil-works/pi-ai/providers/all",
  "@earendil-works/pi-coding-agent": "@earendil-works/pi-coding-agent",
  "@mariozechner/pi-agent-core": "@earendil-works/pi-agent-core",
  "@mariozechner/pi-tui": "@earendil-works/pi-tui",
  "@mariozechner/pi-ai": "@earendil-works/pi-ai/compat",
  "@mariozechner/pi-ai/compat": "@earendil-works/pi-ai/compat",
  "@mariozechner/pi-ai/models": "@earendil-works/pi-ai/models",
  "@mariozechner/pi-ai/oauth": "@earendil-works/pi-ai/oauth",
  "@mariozechner/pi-ai/providers/all": "@earendil-works/pi-ai/providers/all",
  "@mariozechner/pi-coding-agent": "@earendil-works/pi-coding-agent",
};

/** The directory of a checkout package, found by walking up from its entry to its package.json. */
function checkoutPackageDir(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)));
  for (;;) {
    const candidate = join(dir, "package.json");
    const pkg = existsSync(candidate)
      ? (JSON.parse(readFileSync(candidate, "utf8")) as { name: string })
      : undefined;
    if (pkg?.name === name) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${name} resolves to no package directory`);
    dir = parent;
  }
}

let stageDir = "";
let stagePrefix = "";

before(async () => {
  // The alias table must match the pinned host package exactly, so an alias the host adds or drops
  // changes this table with it and the staged load never resolves differently than the host does.
  const host = checkoutPackageDir("@earendil-works/pi-coding-agent");
  const virtualModules = (await import(
    pathToFileURL(join(host, "dist/core/extensions/virtual-modules.js")).href
  )) as { VIRTUAL_MODULES: Record<string, unknown> };
  assert.deepEqual(
    Object.keys(virtualModules.VIRTUAL_MODULES).toSorted(),
    Object.keys(ALIASED).toSorted(),
  );

  stageDir = stageCleanInstall();
  stagePrefix = `${pathToFileURL(stageDir).href}/`;
  const aliases = new Map<string, string>();
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const target = ALIASED[specifier];
      if (context.parentURL?.startsWith(stagePrefix) && target !== undefined) {
        let url = aliases.get(specifier);
        if (url === undefined) {
          url = import.meta.resolve(target);
          aliases.set(specifier, url);
        }
        return { url, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
});

after(() => {
  rmSync(stageDir, { recursive: true, force: true });
});

/** The clean install of specs/markdown-tool.md#published-package: published files, dependencies linked. */
function stageCleanInstall(): string {
  const staged = mkdtempSync(join(tmpdir(), "pi-dent-markdown-load-"));
  for (const entry of manifest.files) {
    const target = join(staged, entry);
    if (entry.endsWith("/")) {
      cpSync(join(root, entry), target, { recursive: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(root, entry), target);
    }
  }
  const installed = structuredClone(manifest);
  delete installed.devDependencies;
  delete installed.peerDependencies;
  writeFileSync(join(staged, "package.json"), `${JSON.stringify(installed, null, 2)}\n`);
  const stagedModules = join(staged, "node_modules");
  mkdirSync(stagedModules);
  for (const name of Object.keys(manifest.dependencies)) {
    const target = join(stagedModules, name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(join(root, "node_modules", name), target, "dir");
  }
  return staged;
}

test("the library surface loads from a clean install", async () => {
  const entry = await import(pathToFileURL(join(stageDir, "index.ts")).href);
  assert.equal(typeof entry.makeMarkdownTool, "function");
  assert.equal(typeof entry.markdownRuntime, "function");
});

test("the standalone entry loads from a clean install", async () => {
  const entry = await import(pathToFileURL(join(stageDir, "extension.ts")).href);
  assert.equal(typeof entry.default, "function");
});
