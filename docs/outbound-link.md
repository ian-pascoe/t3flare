# Linking the cloud to your laptop (the Outbound link)

The Cloud Environment links to your laptop with t3's own Peer link, as one stock t3 server links to another ([ADR-0029](adr/0029-the-outbound-link-is-t3s-own-unchanged-and-t3flare-adds-only-reachability.md)). What you need on the laptop is a **Route**: a plain https address, reachable from the internet, that ends at the laptop's t3. t3's own auth is the only thing in front of it.

Three kinds of Route work. You can give a link more than one: t3 keeps every address that answered, and each call uses the first that still does.

| Kind | Address | What the laptop runs | Notes |
|---|---|---|---|
| T3 Connect | the tunnel hostname T3 Connect gave the laptop | nothing new: T3 Connect is on in the desktop app | The Link dialog offers it when your app knows the laptop. The relay operator is in the path. |
| Tailscale Funnel | `https://<node>.<tailnet>.ts.net` (port 443, 8443 or 10000) | `tailscale funnel` to t3's port | Not a tailnet-only address: the cloud is not on your tailnet. The hostname is published in certificate logs. |
| Your own Cloudflare Tunnel | a hostname of yours | `cloudflared` as a launch agent, the hostname to `http://localhost:<t3's port>` | No Access in front. Leave `Host` as it is (no `httpHostHeader`). |

## Before you start: find and pin t3's port

The desktop app's server listens on `T3CODE_PORT` if it is set, else 3773, else the next free port. A Funnel or an own tunnel points at a fixed port, so pin it:

1. In the desktop app, Settings → Sharing & access shows the server's address; or run `lsof -iTCP -sTCP:LISTEN -P | grep -i t3`.
2. Pin it: `launchctl setenv T3CODE_PORT 3773`, then quit and reopen the app. If 3773 is busy, the app moves to another port and your Route would serve whatever took 3773, in public (SPI-1074).

T3 Connect needs none of this.

## Check the Route before linking

From anywhere, `curl -s https://<your route>/.well-known/t3/environment` must answer t3's descriptor, with your laptop's `environmentId` and label. `curl -s -o /dev/null -w '%{http_code}' -X POST https://<your route>/mcp` must answer `401`: t3's own auth is in front.

## T3 Connect

Turn T3 Connect on in the desktop app (Settings → T3 Connect). Nothing else.

## Tailscale Funnel (about 20 minutes, up to 10 of them waiting for DNS)

1. In the Tailscale admin console, allow Funnel for the laptop's node (Access controls → `nodeAttrs` with `funnel`), and turn on HTTPS certificates (DNS → HTTPS Certificates).
2. On the laptop: `tailscale funnel --bg 3773` (t3's pinned port). `tailscale funnel status` shows the public address, `https://<node>.<tailnet>.ts.net`.
3. Wait until the address resolves from outside your tailnet, then check it as above.
4. To turn it off: `tailscale funnel --bg 3773 off` (or `tailscale funnel reset`).

## Your own Cloudflare Tunnel (about 15 minutes)

1. `cloudflared tunnel login`, then `cloudflared tunnel create t3-laptop`.
2. `cloudflared tunnel route dns t3-laptop t3-laptop.<your domain>` (a proxied CNAME to the tunnel).
3. `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: t3-laptop
   credentials-file: /Users/<you>/.cloudflared/<tunnel id>.json
   ingress:
     - hostname: t3-laptop.<your domain>
       service: http://localhost:3773
     - service: http_status:404
   ```
   No Access application on that hostname, and no `httpHostHeader`.
4. Run it at login: `sudo cloudflared service install` (or a user launch agent running `cloudflared tunnel run t3-laptop`).
5. Check the Route as above.
6. To turn it off: `sudo cloudflared service uninstall`, `cloudflared tunnel delete t3-laptop`, and delete the DNS record.

A hostname in prod's own zone (`ianpascoe.dev`) is reached from the Worker as a same-zone fetch, straight to the tunnel. Only prod can prove that path; if it fails there, use a hostname in another zone.

## Linking

Either way is t3's own:

- **From the dialog:** in a client connected to the Cloud Environment, Settings → Labs → Linked environments → Link. Pick the laptop (the client mints a pairing code on it) or type its Route and paste a pairing code from the laptop's Sharing & access. Pick the access (Supervised by default).
- **At an agent's asking:** ask a cloud agent to work on your laptop. It calls `t3_environment_link`, a link card appears in its thread, and you answer it there with the machine and the access. The pairing code never enters the transcript.

The laptop's Sharing & access then lists the cloud's session at that access.

## What the access means

A linked cloud agent acts on the laptop up to the link's access, and a thread it starts there runs under the narrower of the link's access and the calling thread's mode. Below full access, t3's Link fence holds there: the link changes only threads it started and skips project setup scripts. t3 does not fence reads over a link. The bearer is kept in the Cloud Environment for about 30 days.

## When the laptop sleeps

A task delegated to the laptop keeps the Cloud Environment up while the laptop answers. While it does not (asleep, its tunnel down), the Environment may reset, and it comes back to try again after 5, 15, then every 30 minutes, until the task ends there, you cancel it, or the link expires or is revoked. Close the lid rather than quitting the app: quitting ends the running turn.

## Ending a link

Unlink in a client connected to the cloud (it forgets the bearer there), and revoke the cloud's session in the laptop's Sharing & access (the bearer then stops working). An open task then fails with t3's reason.

## Concurrency

Measured on a stage (SPI-1061 G4, `docs/steps/spi-1061/many.json`): see the report for how many Remote tasks waited at once while a model call still went through.
