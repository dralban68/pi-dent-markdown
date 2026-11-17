/**
 * Worker options that let `workerUrl`, a TypeScript module of this package, load when the package
 * is installed under node_modules, where Node refuses to strip types. Elsewhere there are none.
 */
export function typeStrippingOptions(workerUrl: URL): { execArgv?: string[] } {
  if (!workerUrl.pathname.includes("/node_modules/")) return {};
  const hook = new URL("./strip-types-hook.mjs", import.meta.url).href;
  return { execArgv: ["--import", hook] };
}
