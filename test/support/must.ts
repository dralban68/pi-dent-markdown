/** Return a value that a test knows is present, throwing instead of silently reading `undefined`. */
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected value to be present");
  return value;
}

/** Return the element at `index`, failing the test when it is missing. */
export function at<T>(items: readonly T[], index: number): T {
  return must(items[index]);
}
