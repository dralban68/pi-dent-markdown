import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { typeStrippingOptions } from "../lib/worker-options.ts";

test("a TypeScript worker under node_modules loads, with its TypeScript imports", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker-options-"));
  try {
    const dir = join(root, "node_modules", "pkg", "lib");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dep.ts"), "export const answer: number = 42;\n");
    writeFileSync(
      join(dir, "worker.ts"),
      'import { parentPort } from "node:worker_threads";\nimport { answer } from "./dep.ts";\nparentPort?.postMessage(answer satisfies number);\n',
    );
    const url = pathToFileURL(join(dir, "worker.ts"));
    const worker = new Worker(url, { ...typeStrippingOptions(url), stderr: true });
    let stderr = "";
    worker.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const message = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    await worker.terminate();
    assert.equal(message, 42);
    assert.equal(stderr, "", "the worker writes no warning");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a worker outside node_modules gets no extra options", () => {
  assert.deepEqual(typeStrippingOptions(pathToFileURL(join(tmpdir(), "lib", "worker.ts"))), {});
});
