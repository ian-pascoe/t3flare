// SPI-1061 (ADR-0029): the Outbound link is t3's own. Through our one Layer, t3's real `PeerLinks` links, lists,
// resolves and unlinks as stock t3 does (Pre-B's refusals are gone); every error it answers carries no `cause`, which
// can hold the request with a pairing code or the bearer (review M6, plan §5.4). `t3_environment_links`' `notListed` is
// t3's own again, and names a tool the agent is offered.
import * as NodeFs from "node:fs";

import { NodeHttpServer } from "@effect/platform-node";
import { EnvironmentId, PeerLinkError, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PeerLinks from "t3/src/peer/PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, servePeer } from "t3/src/peer/PeerLinks.testkit.ts";
import { expect, it } from "vitest";

import { isDeniedT3Tool } from "../../agents/src/extensions/t3-guidance.ts";
import { layerPeerLinksWithoutCause } from "../src/t3/peerLinks.ts";

const cloud: ExecutionEnvironmentDescriptor = descriptorOf("environment-cloud", "Cloud");
const laptop: ExecutionEnvironmentDescriptor = descriptorOf("environment-laptop", "Laptop");

it("links, lists, resolves and unlinks as stock t3 does, through our Layer", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const peer = yield* servePeer(laptop, Layer.empty);
        const context = yield* Layer.build(layerPeerLinksWithoutCause.pipe(Layer.provideMerge(layerLinkingEnvironment(cloud))));
        const links = Context.get(context, PeerLinks.PeerLinks);
        const pairing = yield* peer.auth.issuePairingCredential();
        const linked = yield* links.link({ url: peer.url, pairingCode: pairing.credential, access: "approval-required" });
        const listed = yield* links.list;
        const resolved = yield* links.resolve(laptop.environmentId);
        const removed = yield* links.unlink(laptop.environmentId);
        const after = yield* links.get(laptop.environmentId);
        return { linked, listed, resolved, removed, after, sessions: yield* peer.linkedSessions };
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
  expect(result.linked).toMatchObject({ environmentId: laptop.environmentId, label: "Laptop", access: "approval-required" });
  expect(result.listed.map((link) => [link.environmentId, link.status])).toEqual([[laptop.environmentId, "reachable"]]);
  expect(result.resolved.token.length).toBeGreaterThan(20);
  expect(result.removed).toBe(true);
  expect(Option.isNone(result.after)).toBe(true);
  expect(result.sessions.length).toBe(1);
});

it("answers every error with t3's reason and message and no cause", async () => {
  const leaky = new PeerLinkError({ reason: "unreachable", message: "t3's own words", cause: new Error("POST https://laptop/oauth/mcp/token Bearer secret-bearer code=PAIRCODE") });
  const fail = () => Effect.fail(leaky);
  const real = PeerLinks.PeerLinks.of({
    enabled: Effect.succeed(true),
    link: fail,
    list: fail(),
    get: fail,
    unlink: fail,
    resolve: fail,
    recordOutcome: () => Effect.void,
  });
  const errors = await Effect.runPromise(
    Effect.gen(function* () {
      const links = yield* PeerLinks.PeerLinks;
      const id = EnvironmentId.make("environment-laptop");
      return yield* Effect.all([
        Effect.flip(links.link({ url: "https://laptop.example", pairingCode: "PAIRCODE", access: "auto" })),
        Effect.flip(links.list),
        Effect.flip(links.get(id)),
        Effect.flip(links.unlink(id)),
        Effect.flip(links.resolve(id)),
      ]);
    }).pipe(Effect.provide(layerPeerLinksWithoutCause.pipe(Layer.provide(Layer.succeed(PeerLinks.PeerLinks, real))))),
  );
  expect(errors).toHaveLength(5);
  for (const error of errors) {
    expect(error).toMatchObject({ _tag: "PeerLinkError", reason: "unreachable", message: "t3's own words" });
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toMatch(/secret-bearer|PAIRCODE/);
  }
});

it("leaves t3's `notListed` as t3 wrote it, pointing at a tool the agent is offered (C3)", () => {
  const source = NodeFs.readFileSync(new URL("../../../t3code/apps/server/src/peer/PeerForwarding.ts", import.meta.url), "utf8");
  const t3Line = /const NOT_LISTED =\s*"([^"]+)"/.exec(source)?.[1];
  expect(t3Line, "t3's NOT_LISTED moved; re-read PeerForwarding.links (U45)").toBeDefined();
  const named = [...t3Line!.matchAll(/\bt3_[a-z_]+/g)].map((match) => match[0]);
  expect(named).toContain("t3_environment_link");
  expect(named.filter(isDeniedT3Tool)).toEqual([]);
  // No Layer of ours over PeerForwarding or PeerLinkRequests is left in the composition.
  const composition = NodeFs.readFileSync(new URL("../src/t3/composition.ts", import.meta.url), "utf8");
  expect(composition).not.toMatch(/layerOwnerPeer/);
  expect(composition).toContain("Layer.provide(PeerLinkRequests.layer)");
});
