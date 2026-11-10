// @effect-diagnostics effectFnOpportunity:off anyUnknownInErrorContext:off
// An Effect `HttpServer` for a Durable Object (ADR-0002).
//
// `HttpRouter.serve` registers t3's routes here as it would on Node; the DO's `fetch`
// then calls `handle`. A WebSocket upgrade is a plain accepted WebSocketPair: the
// request's `upgrade` hands the server end to t3's RPC socket protocol, and the client
// end goes back in a 101 as soon as t3 asks for the upgrade. Until then t3 may still
// answer with an ordinary response (401, 426), which is returned instead.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as NetAddress from "effect/net/NetAddress";
import * as Socket from "effect/socket/Socket";
import type { WebSocketPair as WebSocketPairType } from "@cloudflare/workers-types/index.ts";

import * as Idle from "../host/idle.ts";

declare const WebSocketPair: typeof WebSocketPairType;

type Handler = {
  readonly context: Context.Context<never>;
  readonly app: Effect.Effect<void, never, HttpServerRequest.HttpServerRequest>;
};

export interface DurableObjectHttp {
  /** Resolves once `HttpRouter.serve` has registered the app. */
  readonly ready: Promise<void>;
  readonly handle: (request: Request) => Promise<Response>;
}

const RESOLVE = Symbol.for("t3flare/http/resolve");

export const make = () => {
  let handler: Handler | undefined;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const server = HttpServer.make({
    address: NetAddress.inetAddressFromIpStringUnsafe("0.0.0.0", 443),
    serve: (httpEffect, middleware) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const app = HttpEffect.toHandled(
          httpEffect,
          (request, response) =>
            Effect.sync(() => {
              const resolve = (request as any)[RESOLVE] as ((response: Response) => void) | undefined;
              resolve?.(
                HttpServerResponse.toWeb(response, {
                  withoutBody: request.method === "HEAD",
                  context,
                }),
              );
            }),
          middleware,
        ) as Handler["app"];
        handler = { context, app };
        markReady();
      }),
  });

  const handle = async (request: Request): Promise<Response> => {
    await ready;
    const { context, app } = handler!;
    const isUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    return new Promise<Response>((resolve) => {
      let settled = false;
      const settle = (response: Response) => {
        if (settled) return;
        settled = true;
        resolve(response);
      };
      let serverRequest = HttpServerRequest.fromWeb(request);
      if (isUpgrade) {
        const pair = new WebSocketPair();
        const [client, socket] = [pair[0], pair[1]];
        const upgrade = Effect.suspend(() => {
          socket.accept();
          // A client socket keeps the Environment awake (ADR-0003).
          Idle.socketOpened();
          let closed = false;
          const onClose = () => {
            if (closed) return;
            closed = true;
            Idle.socketClosed();
          };
          socket.addEventListener("close", onClose);
          socket.addEventListener("error", onClose);
          // The 101 must reach the client before t3 starts writing frames.
          settle(new Response(null, { status: 101, webSocket: client } as ResponseInit));
          return Socket.fromWebSocket(Effect.succeed(socket as unknown as globalThis.WebSocket));
        });
        serverRequest = Object.create(serverRequest, {
          upgrade: { value: upgrade },
          upgradeWith: { value: () => upgrade },
        });
      }
      (serverRequest as any)[RESOLVE] = settle;
      const fiber = Effect.runForkWith(Context.add(context, HttpServerRequest.HttpServerRequest, serverRequest))(app);
      fiber.addObserver((exit) => {
        if (!settled) {
          settle(new Response(exit._tag === "Success" ? null : "Internal error", { status: 500 }));
        }
      });
    });
  };

  return { server, http: { ready, handle } satisfies DurableObjectHttp };
};

export const layer = (made: ReturnType<typeof make>) => Layer.succeed(HttpServer.HttpServer, made.server);

