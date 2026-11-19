// A failed admin route's answer (host/adminFailure.ts): the error and its causes, never a stack trace; the stack is
// logged, redacted.
import { afterEach, describe, expect, it, vi } from "vitest";

import { adminFailureBody, causesOf, logAdminFailure } from "../src/host/adminFailure.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a failed admin route", () => {
  const failure = () => new Error("outer", { cause: new Error("SQLITE_ERROR: no such table", { cause: { code: 7 } }) });

  it("answers with the error and its causes, and no stack", () => {
    const body = adminFailureBody(failure());
    expect(body).toEqual({ error: "Error: outer", causes: ["SQLITE_ERROR: no such table", '{"code":7}'] });
    expect(JSON.stringify(body)).not.toMatch(/\bat .+:\d+:\d+/);
    expect(body).not.toHaveProperty("stack");
  });

  it("answers for a thrown value that is not an Error", () => {
    expect(adminFailureBody("plain")).toEqual({ error: "plain", causes: [] });
    expect(adminFailureBody(undefined)).toEqual({ error: "undefined", causes: [] });
  });

  it("follows at most six causes, and names one it cannot print", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(causesOf({ cause: cyclic })).toEqual(Array.from({ length: 6 }, () => "unprintable cause"));
  });

  it("logs the stack, redacted, for Workers Logs", () => {
    const logged: Array<string> = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void logged.push(line));
    const error = new Error("Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
    logAdminFailure("POST /_t3flare/sql", error);
    expect(logged).toHaveLength(1);
    const entry = JSON.parse(logged[0]!) as { t3flare: string; route: string; stack: Array<string> };
    expect(entry).toMatchObject({ t3flare: "admin-route-failed", route: "POST /_t3flare/sql" });
    expect(entry.stack.length).toBeGreaterThan(1);
    expect(logged[0]).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
