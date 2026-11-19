// `POST /_t3flare/check/agents` (src/host/agentsCheck.ts): its two repositories are required query parameters, with no
// default (they are the Owner's; docs/deploy.md).
import { describe, expect, it } from "vitest";

import { agentsCheckRepos } from "../src/host/agentsCheck.ts";

const at = (query: string) => agentsCheckRepos(new URL(`https://t3.example.com/_t3flare/check/agents${query}`));

describe("agentsCheckRepos", () => {
  it("takes repo and other as owner/name", () => {
    expect(at("?repo=someone/fixture&other=someone/elsewhere&budget=0")).toEqual({ repo: "someone/fixture", other: "someone/elsewhere" });
  });

  it("refuses either missing or malformed", () => {
    for (const query of ["", "?budget=0", "?repo=someone/fixture", "?other=someone/elsewhere", "?repo=fixture&other=someone/elsewhere", "?repo=someone/fixture&other=a/b/c"]) {
      expect(at(query)).toMatchObject({ error: expect.stringMatching(/^repo and other are required query parameters/) });
    }
  });
});
