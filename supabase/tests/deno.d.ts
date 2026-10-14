/** The few Deno and Edge Runtime globals the function entry points (main.ts / index.ts) use, for typechecking under Node. */
declare namespace Deno {
  const env: { get(name: string): string | undefined };
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
}
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
