// @effect-diagnostics nodeBuiltinImport:off
// SPI-1171 review 2: a sign-in's tokens leave the Credential broker by value only to be hashed for the leak check, in the
// Environment DO (`signInLeakPatterns`); no other code reads them as stored (`secrets`), and no RPC answers with them.
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const src = path.resolve(import.meta.dirname, "../src");
const files = (dir: string): Array<string> =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : []));

describe("a sign-in's stored tokens", () => {
  it("are read (`secrets`) only by the Environment DO, which hashes them for the leak check", () => {
    const callers = files(src)
      .filter((file) => /\.secrets\(/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(src, file));
    expect(callers).toEqual(["environmentDO.ts"]);
    const environment = fs.readFileSync(path.join(src, "environmentDO.ts"), "utf8");
    expect(environment).toContain("return signInLeakPatterns(await this.#credentialBroker().secrets(endpointId));");
    expect(environment).not.toMatch(/signInSecrets/);
  });
});
