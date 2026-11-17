/**
 * The worker thread of the `Markdown` tool (specs/markdown-tool.md, Section 2.2):
 * it runs one job of a call at a time, charging its parses to the call's parse
 * clock, and posts back the reply or why there is none. `lib/markdown-tool.ts`
 * creates the thread for a call and terminates it when the call ends, on its
 * abort, or when the budget is reached.
 *
 * Protocol: a message `{ job, spentMs, limitMs }` is answered by
 * `{ spentMs, reply }`, by `{ spentMs, budget: true }` when the parses reach the
 * budget, or by `{ spentMs, failure }` for any other failure.
 */

import { parentPort } from "node:worker_threads";
import { ParseBudgetError, withParseClock, type ParseClock } from "./markdown-document.ts";
import { runMarkdownJob, type MarkdownJob } from "./markdown-run.ts";
import { errorMessage, isPlainObject } from "./util.ts";

/** A job the message carries, or undefined when it carries none. */
function jobOf(value: unknown): MarkdownJob | undefined {
  if (!isPlainObject(value)) return;
  const { kind, params, text, revision, hadBom, display, absolute } = value;
  if (
    kind !== "check" &&
    kind !== "outline" &&
    kind !== "read" &&
    kind !== "edit" &&
    kind !== "links"
  )
    return;
  if (typeof text !== "string" || typeof revision !== "string") return;
  if (typeof hadBom !== "boolean" || typeof display !== "string" || typeof absolute !== "string") {
    return;
  }
  return { kind, params, text, revision, hadBom, display, absolute };
}

/** A number field of a message, or 0 when it has none. */
function numberOf(message: Record<string, unknown>, name: string): number {
  const value = message[name];
  return typeof value === "number" ? value : 0;
}

const port = parentPort;
port?.on("message", (message: unknown) => {
  if (port === null) return;
  if (!isPlainObject(message)) {
    port.postMessage({ spentMs: 0, failure: "malformed message" });
    return;
  }
  const clock: ParseClock = {
    spentMs: numberOf(message, "spentMs"),
    limitMs: numberOf(message, "limitMs"),
  };
  const job = jobOf(message.job);
  if (job === undefined) {
    port.postMessage({ spentMs: clock.spentMs, failure: "malformed job" });
    return;
  }
  try {
    const reply = withParseClock(clock, () => runMarkdownJob(job));
    port.postMessage({ spentMs: clock.spentMs, reply });
  } catch (error) {
    if (error instanceof ParseBudgetError) {
      port.postMessage({ spentMs: clock.spentMs, budget: true });
      return;
    }
    port.postMessage({ spentMs: clock.spentMs, failure: errorMessage(error) });
  }
});
