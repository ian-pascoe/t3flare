// @xterm/headless names a `module` entry it does not ship (`lib/xterm.mjs`), so the agents Worker imports its ES module
// build by path (`workspace/agentTerminals.ts`); its types are the package's own.
declare module "@xterm/headless/lib-headless/xterm-headless.mjs" {
  export { Terminal } from "@xterm/headless";
}
