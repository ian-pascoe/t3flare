# The Environment is one Durable Object, and clients connect over a plain WebSocket

The cloud Environment's control plane (t3's orchestrator, projections, auth, `/ws` and `/mcp`) runs in a single **Environment DO**, not in a Container, because an always-on Container costs about $28–54 a month and a DO is billed only while active. There is one Environment DO per deploy: t3's orchestrator assumes one serialized command stream and one SQL database, and there is one user.

Clients connect over a plain, accepted (non-hibernating) WebSocket that carries t3's Effect RPC unchanged. t3's `ws.ts` already lets us supply the upgraded socket. The DO stays resident while a client is connected: with the desktop app open all day that is about 343k GB-s a month, within the 400k included, and at worst one more $12.50 block.

## Considered Options

- **Hibernatable WebSockets**: Effect RPC keeps per-client stream fibers in memory, so we would own a re-subscribe layer forever to save a few dollars. Revisit if a month's bill exceeds 400k GB-s, as "hibernate, auto-pong, and close sockets on a real wake so clients reconnect".
- **Sharding per project**: rewrites t3's EventSink and ProjectionStore.
