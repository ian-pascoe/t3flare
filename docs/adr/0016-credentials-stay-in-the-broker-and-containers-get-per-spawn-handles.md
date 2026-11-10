# Credentials stay in the broker, and Containers get per-spawn Handles

No credential enters the Workspace file system, and in the normal path none enters the Container. A CLI agent is given a **Handle**: an opaque placeholder, shaped like a real token, registered at spawn and revoked at exit. The Workspace DO registers HTTPS intercepts for the vendor hosts before each Container start. The handler checks the URL's host (the Host header is container-controlled), swaps the Handle for the real credential, and routes: Subscription traffic goes straight to the vendor, proxy-key traffic is rewritten to the proxy. The CLI's session-state directories sit beside the repo, outside any t3 path, and are synced; they hold no secrets.

## Consequences

If streaming through the intercept handler fails, Containers instead get real access tokens that expire within hours, never refresh tokens or year-long tokens. Credentialed CLIs then run under a second user ID so a Durable agent's shell cannot read their environment. Not offered: ACP's terminal `/login`, which would write a rotating credential into the synced Workspace.
