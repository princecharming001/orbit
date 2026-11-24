/**
 * What the browser's code expects of its bundler (vite/client), for typechecking it under this package:
 * functions/roles-contract.test.ts imports the browser's Roles engine (apps/web/src/engine/roles.ts) to run it against
 * the real /roles routes.
 */
interface ImportMetaEnv {
  // biome-ignore lint/suspicious/noExplicitAny: the same loose shape vite/client declares
  [key: string]: any;
  readonly MODE: string;
  readonly BASE_URL: string;
  readonly PROD: boolean;
  readonly DEV: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
declare module '*?url' {
  const src: string;
  export default src;
}
