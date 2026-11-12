// SPI-1061 pre-items (review H2, M1, M6): t3's real `PeerLinks`, under our Layer, makes no link and uses no stored
// one; `t3_environment_links` and the link card name no tool the agent lacks.
import * as NodeFs from "node:fs";

import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as PeerForwarding from "t3/src/peer/PeerForwarding.ts";
import * as PeerLinkRequests from "t3/src/peer/PeerLinkRequests.ts";
import * as PeerLinks from "t3/src/peer/PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment } from "t3/src/peer/PeerLinks.testkit.ts";
import { expect, it } from "vitest";

import { WITHHELD_T3_TOOLS } from "../../agents/src/extensions/t3-guidance.ts";
import {
  layerOwnerPeerForwarding,
  layerOwnerPeerLinkRequests,
  layerOwnerPeerLinks,
  NO_MACHINE_REGISTERED,
  NOT_LISTED,
  STORED_LINKS_OFF,
} from "../src/t3/peerLinks.ts";

const here: ExecutionEnvironmentDescriptor = descriptorOf("environment-cloud", "Cloud");
const stored = EnvironmentId.make("environment-laptop");

/** t3's real `PeerLinks` on an in-memory database, under our Layer, with the database beside it. */
const withLinks = <A, E>(body: (links: PeerLinks.PeerLinks["Service"], sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layerOwnerPeerLinks.pipe(Layer.provideMerge(layerLinkingEnvironment(here))));
        return yield* body(Context.get(context, PeerLinks.PeerLinks), Context.get(context, SqlClient.SqlClient));
      }),
    ),
  );

/** A link row as t3 stores one, unexpired, made before this Layer existed. */
const seed = (sql: SqlClient.SqlClient) => sql`
  INSERT INTO peer_environment_links
    (environment_id, secret_name, label, urls_json, access, linked_at, expires_at, last_reached_at, last_error, fenced)
  VALUES
    (${stored}, 'peer-link-laptop', 'Laptop', '["https://laptop.example"]', 'auto', '2026-11-01T00:00:00.000Z',
     '2099-01-01T00:00:00.000Z', NULL, NULL, 1)
`;

const count = (sql: SqlClient.SqlClient) =>
  sql<{ n: number }>`SELECT COUNT(*) AS n FROM peer_environment_links`.pipe(Effect.map((rows) => Number(rows[0]!.n)));

it("refuses to link, with the named reason and no cause", async () => {
  const error = await withLinks((links) =>
    Effect.flip(links.link({ url: "https://laptop.example", pairingCode: "code", access: "auto" })),
  );
  expect(error).toMatchObject({ _tag: "PeerLinkError", reason: "disabled", message: NO_MACHINE_REGISTERED });
  expect("cause" in error).toBe(false);
});

it("a stored link cannot be resolved, finally, and is not listed; unlink still removes it", async () => {
  const result = await withLinks((links, sql) =>
    Effect.gen(function* () {
      yield* seed(sql);
      const before = yield* count(sql);
      const resolved = yield* Effect.flip(links.resolve(stored));
      const listed = yield* links.list;
      const got = yield* links.get(stored);
      const removed = yield* links.unlink(stored);
      return { before, resolved, listed, got: got._tag, removed, after: yield* count(sql) };
    }),
  );
  expect(result.before).toBe(1);
  // `expired` is final: PeerMcpClient makes it `capability_denied`, which RemoteDelegation stops following on.
  expect(result.resolved).toMatchObject({ reason: "expired", message: STORED_LINKS_OFF });
  expect("cause" in result.resolved).toBe(false);
  expect(result.listed).toEqual([]);
  expect(result.got).toBe("Some");
  expect(result.removed).toBe(true);
  expect(result.after).toBe(0);
});

it("t3's `notListed` points at the withheld `t3_environment_link`; ours, which replaces it, names no withheld tool", async () => {
  const source = NodeFs.readFileSync(new URL("../../../t3code/apps/server/src/peer/PeerForwarding.ts", import.meta.url), "utf8");
  const t3Line = /const NOT_LISTED =\s*"([^"]+)"/.exec(source)?.[1];
  expect(t3Line, "t3's NOT_LISTED moved; re-read PeerForwarding.links (U41)").toBeDefined();
  const namesWithheld = (text: string) =>
    [...WITHHELD_T3_TOOLS].filter((name) => new RegExp(`\\b${name.replace("*", "")}`).test(text));
  expect(namesWithheld(t3Line!)).toEqual(["t3_environment_link"]);

  const real = { links: () => Effect.succeed({ environmentId: "cloud", links: [], notListed: t3Line! }) } as unknown as PeerForwarding.PeerForwarding["Service"];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const forwarding = yield* PeerForwarding.PeerForwarding;
      return yield* forwarding.links({} as never);
    }).pipe(Effect.provide(layerOwnerPeerForwarding.pipe(Layer.provide(Layer.succeed(PeerForwarding.PeerForwarding, real))))),
  );
  expect(result).toEqual({ environmentId: "cloud", links: [], notListed: NOT_LISTED });
  expect(namesWithheld(JSON.stringify(result))).toEqual([]);
});

it("raises no link card", async () => {
  const calls: Array<string> = [];
  const real = {
    request: () => Effect.sync(() => calls.push("request")),
    answer: () => Effect.sync(() => void calls.push("answer")),
  } as unknown as PeerLinkRequests.PeerLinkRequests["Service"];
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const requests = yield* PeerLinkRequests.PeerLinkRequests;
      return yield* Effect.flip(requests.request({} as never, {} as never));
    }).pipe(Effect.provide(layerOwnerPeerLinkRequests.pipe(Layer.provide(Layer.succeed(PeerLinkRequests.PeerLinkRequests, real))))),
  );
  expect(error).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "capability_denied", message: NO_MACHINE_REGISTERED });
  expect(calls).toEqual([]);
});
