import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { markdownRuntime } from "../../lib/markdown-tool.ts";
import { bytesOf, call, cleanupRoots, runtime, tempDir, write } from "./support.ts";
import { must } from "../support/must.ts";

/**
 * specs/markdown-tool.md#file-access and specs/markdown-tool.md#edit-applying: the path forms, the abort
 * contract, and the host's file mutation queue, which an `edit` call holds from
 * before its read until its write ends.
 */

const DOCUMENT = "# Doc\n\ntext\n\n## Two\n\nmore\n";

/** What an outline of `path` against `cwd` reports: the resolved path, and its first entry line. */
async function outlineOf(
  instance: ReturnType<typeof markdownRuntime>,
  cwd: string,
  path: string,
): Promise<{ reported: unknown; entry: string | undefined }> {
  const outcome = await call(instance, cwd, { action: "outline", path });
  assert.equal(outcome.isError, false, outcome.text);
  return { reported: outcome.details.path, entry: outcome.lines[1] };
}

test("specs/markdown-tool.md#file-access: a relative path, with or without a leading @, resolves against the session's cwd", async () => {
  const work = tempDir();
  const home = tempDir();
  try {
    write(work, "a.md", "# Work\n");
    write(home, "a.md", "# Home\n");
    const instance = markdownRuntime({ home });
    for (const path of ["a.md", "@a.md", " @a.md "]) {
      assert.deepEqual(await outlineOf(instance, work, path), {
        reported: join(work, "a.md"),
        entry: "1-1 # Work",
      });
    }
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#file-access: a ~/ path resolves against the home directory, and a bare ~ names it", async () => {
  const work = tempDir();
  const home = tempDir();
  try {
    write(home, "a.md", "# Home\n");
    const instance = markdownRuntime({ home });
    for (const path of ["~/a.md", " ~/a.md "]) {
      assert.deepEqual(await outlineOf(instance, work, path), {
        reported: join(home, "a.md"),
        entry: "1-1 # Home",
      });
    }
    const homeFile = join(home, "a.md");
    const bare = markdownRuntime({ home: homeFile });
    assert.deepEqual(await outlineOf(bare, work, "~"), {
      reported: homeFile,
      entry: "1-1 # Home",
    });
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#file-access: a bare @ names the session's cwd, and a padded absolute path names that file", async () => {
  const work = tempDir();
  const other = tempDir();
  try {
    write(work, "a.md", "# Work\n");
    const instance = markdownRuntime({ home: other });
    const bare = await call(instance, work, { action: "outline", path: "@" });
    assert.equal(bare.text, "cannot read @: EISDIR");
    const absolute = join(work, "a.md");
    assert.deepEqual(await outlineOf(instance, other, `  ${absolute}\t`), {
      reported: absolute,
      entry: "1-1 # Work",
    });
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#file-access: a leading @ is dropped from the path a call reads", async () => {
  const dir = tempDir();
  try {
    write(dir, "a.md", DOCUMENT);
    const outcome = await call(runtime(), dir, { action: "outline", path: "@a.md" });
    assert.equal(outcome.isError, false);
    const head = must(outcome.lines[0]);
    assert.equal(head.startsWith("a.md · "), false);
    assert.equal(head.startsWith("@a.md · "), true);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#file-access: a ~ path resolves against the home directory", async () => {
  const home = tempDir();
  const work = tempDir();
  try {
    write(home, "a.md", DOCUMENT);
    const instance = markdownRuntime({ home });
    const outcome = await call(instance, work, { action: "read", path: "~/a.md", section: "Doc" });
    assert.equal(outcome.isError, false);
    assert.equal(must(outcome.lines[0]).startsWith("~/a.md · Doc · lines 1-7 · "), true);
    assert.equal(must(outcome.details.path), join(home, "a.md"));
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#edit-applying: an aborted outline or read ends as a tool error", async () => {
  const dir = tempDir();
  try {
    write(dir, "a.md", DOCUMENT);
    const controller = new AbortController();
    controller.abort();
    const instance = runtime();
    for (const params of [
      { action: "outline", path: "a.md" },
      { action: "read", path: "a.md", section: "Doc" },
    ]) {
      const outcome = await instance.execute({ params, cwd: dir, signal: controller.signal });
      assert.equal(outcome.isError, true);
      assert.equal(
        outcome.content[0]?.type === "text" ? outcome.content[0].text : "",
        "Markdown aborted",
      );
    }
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#edit-applying: an edit aborted before its write writes nothing", async () => {
  const dir = tempDir();
  try {
    write(dir, "a.md", DOCUMENT);
    let writes = 0;
    const instance = markdownRuntime({
      writeFile: () => {
        writes += 1;
      },
    });
    const revision = await call(instance, dir, { action: "outline", path: "a.md" }).then(
      (outcome) => must(outcome.details.revision),
    );
    const controller = new AbortController();
    controller.abort();
    const outcome = await instance.execute({
      params: {
        action: "edit",
        path: "a.md",
        revision,
        operations: [{ op: "rename", section: "Doc", heading: "Title" }],
      },
      cwd: dir,
      signal: controller.signal,
    });
    assert.equal(outcome.isError, true);
    assert.equal(
      outcome.content[0]?.type === "text" ? outcome.content[0].text : "",
      "Markdown aborted",
    );
    assert.equal(writes, 0);
    assert.equal(bytesOf(dir, "a.md"), DOCUMENT);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#edit-applying: an abort during the write still returns the result", async () => {
  const dir = tempDir();
  try {
    write(dir, "a.md", DOCUMENT);
    const controller = new AbortController();
    let writes = 0;
    const instance = markdownRuntime({
      writeFile: (path, bytes) => {
        writes += 1;
        controller.abort();
        writeFileSync(path, bytes);
      },
    });
    const revision = await call(instance, dir, { action: "outline", path: "a.md" }).then(
      (outcome) => must(outcome.details.revision),
    );
    const outcome = await instance.execute({
      params: {
        action: "edit",
        path: "a.md",
        revision,
        operations: [{ op: "rename", section: "Doc", heading: "Title" }],
      },
      cwd: dir,
      signal: controller.signal,
    });
    assert.equal(writes, 1);
    assert.notEqual(outcome.isError, true);
    assert.match(bytesOf(dir, "a.md"), /^# Title\n/);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#edit-applying: an edit holds the file mutation queue from before its read until its write ends", async () => {
  const dir = tempDir();
  try {
    write(dir, "a.md", DOCUMENT);
    const events: string[] = [];
    const instance = markdownRuntime({
      mutationQueue: async (path, body) => {
        events.push(`enter ${path.endsWith("/a.md")}`);
        try {
          return await body();
        } finally {
          events.push("leave");
        }
      },
      readFile: (path) => {
        events.push("read");
        return new Uint8Array(readFileSync(path));
      },
      writeFile: (path, bytes) => {
        events.push("write");
        writeFileSync(path, bytes);
      },
    });
    const revision = await call(instance, dir, { action: "outline", path: "a.md" }).then(
      (outcome) => must(outcome.details.revision),
    );
    assert.deepEqual(events, ["read"]);
    events.length = 0;
    const outcome = await instance.execute({
      params: {
        action: "edit",
        path: "a.md",
        revision,
        operations: [{ op: "rename", section: "Doc", heading: "Title" }],
      },
      cwd: dir,
      signal: undefined,
    });
    assert.notEqual(outcome.isError, true);
    assert.deepEqual(events, ["enter true", "read", "write", "leave"]);
  } finally {
    cleanupRoots();
  }
});

test("specs/markdown-tool.md#edit-applying: an edit that fails a check leaves the queue without writing", async () => {
  const dir = tempDir();
  try {
    write(dir, "a.md", DOCUMENT);
    const events: string[] = [];
    const instance = markdownRuntime({
      mutationQueue: async (_path, body) => {
        events.push("enter");
        try {
          return await body();
        } finally {
          events.push("leave");
        }
      },
      writeFile: () => {
        events.push("write");
      },
    });
    const revision = await call(instance, dir, { action: "outline", path: "a.md" }).then(
      (outcome) => must(outcome.details.revision),
    );
    events.length = 0;
    const outcome = await instance.execute({
      params: {
        action: "edit",
        path: "a.md",
        revision,
        operations: [{ op: "delete", section: "Nowhere" }],
      },
      cwd: dir,
      signal: undefined,
    });
    assert.equal(outcome.isError, true);
    assert.deepEqual(events, ["enter", "leave"]);
  } finally {
    cleanupRoots();
  }
});

test(
  "specs/markdown-tool.md#file-access: a FIFO is not a regular file, and opening it does not wait for a writer",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    try {
      await promisify(execFile)("mkfifo", [join(dir, "pipe.md")]);
      const ticks = setInterval(() => {}, 10);
      try {
        const started = performance.now();
        const outcome = await call(runtime(), dir, { action: "outline", path: "pipe.md" });
        assert.equal(outcome.text, "pipe.md is not a regular file");
        assert.ok(performance.now() - started < 1000);
      } finally {
        clearInterval(ticks);
      }
    } finally {
      cleanupRoots();
    }
  },
);

test("specs/markdown-tool.md#file-access: a file over the limit reports its size, not the bytes read", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "big.md"), "x".repeat(5_000_000));
    const outcome = await call(runtime(), dir, { action: "outline", path: "big.md" });
    assert.equal(
      outcome.text,
      "big.md is 5000000 bytes; Markdown reads files of at most 4194304 bytes",
    );
  } finally {
    cleanupRoots();
  }
});
