// Copied verbatim from pi-dent's lib/util.ts: the helpers the Markdown tool uses.

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown): string | undefined {
  return isPlainObject(error) && typeof error.code === "string" ? error.code : undefined;
}
