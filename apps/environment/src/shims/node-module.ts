// @effect-diagnostics nodeBuiltinImport:off
// `node:module` for t3's own modules. t3 loads some native packages with
// `createRequire(import.meta.url)(name)` at module scope, which no bundler can follow;
// in the DO those packages resolve to stubs that throw when used.
import * as real from "node:module";

export * from "node:module";

const unavailable = (name: string) =>
  new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "__esModule") return false;
        return class Unavailable {
          constructor() {
            throw new Error(`t3flare: ${name}.${String(property)} is not available in the Environment DO`);
          }
        };
      },
    },
  );

/** Native packages t3 requires dynamically; see build.ts. */
const NATIVE = new Set(["@ff-labs/fff-node", "node-pty", "ffi-rs", "transcribe-cpp", "@napi-rs/keyring"]);

export const createRequire = (from: string | URL) => {
  const require = real.createRequire(from);
  const wrapped = ((id: string) => (NATIVE.has(id) ? unavailable(id) : require(id))) as NodeJS.Require;
  return Object.assign(wrapped, { resolve: require.resolve, cache: require.cache, main: require.main, extensions: require.extensions });
};

export default { ...real, createRequire };
