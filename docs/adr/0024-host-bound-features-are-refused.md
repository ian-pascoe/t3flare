# Features that need t3's host are refused; previews are built last

Stock t3 runs on the owner's own machine, and some of its features are about that machine: its devices, its CPU, its editor, its processes, its installed software. The Cloud Environment has no such host. The Environment is a Durable Object, and a Workspace's Container is a sandbox that sleeps (ADR-0002, ADR-0009). So these features are refused by design, not left missing. Each is hidden from the stock clients where t3 offers a switch: a stripped capability flag or a locked setting (ADR-0023). Otherwise its RPC answers "not found".

| Feature | Why it is host-bound | How a client sees it |
|---|---|---|
| Device hub and simulators (`srv/device/`) | USB, SSH and Simlock devices on the owner's network | route unmounted (ADR-0010); `enableDeviceSupport`, `enableAgentDeviceAccess` and `simlockDeviceHostsEnabled` locked off; agents get no `device_*` tool (ADR-0022) |
| Local voice models | speech models on the host's CPU | `voiceTranscription` stripped |
| Open in editor (`shell.openInEditor`) | launches an editor on the host | the process router answers "not found" |
| Host diagnostics and power policy (process diagnostics, signals, host resources) | the host's own processes and power state | not offered as a cloud feature: there is no machine to manage; whatever answers describes the Environment DO's isolate (not exercised on a stage) |
| Triage (`server.prepareTriage`) | clones t3's source and writes diagnostics on the host for a bug report | `triage` stripped |
| jj and other VCS CLIs | not in the Workspace image | source-control discovery reports them "not found"; git and `gh` are emulated (ADR-0009, ADR-0013) |
| Import of agent sessions | reads CLI session homes (`~/.codex`, `~/.claude`, …) on the host | there are none in the State directory |
| Server self-update | the Environment is updated by the nightly bump and a deploy (ADR-0017) | `serverSelfUpdate`, `npmReleaseLookup` and the desktop-updater flags stripped |
| Provider install and update | CLIs are pinned in the Workspace image (ADR-0015) and change only with it | a version changes only with a new image and deploy, never from a client |

## Not refused: previews and the server browser (owner decision D4)

Dev-server previews and t3's server browser are part of parity and are **built last** (SPI-1002, parity G11): Container port discovery, an authenticated port proxy, then a browser. They are not host-bound in principle, only unbuilt. Until then, `serverBrowser` stays stripped, its route stays unmounted, and agent browser access stays pinned off at each boot (step 3's L3, `layerPinAgentBrowserAccessOff`). Agents are not offered the `preview_*` and `html_*` tools (ADR-0022).

## Consequences

- A nightly that adds a host-bound feature adds a capability flag or a setting. The flag fails typecheck until it is classified (ADR-0023). The setting does not: classify it by hand when the bump's diff shows one (fragility U4).
- Lifting a refusal needs an ADR that says where the feature runs instead, as D4 does for previews.

## Refinement (tools step): local stdio MCP servers

| Feature | Why refused | Instead |
| --- | --- | --- |
| Local stdio MCP servers (a command the agent's host runs) | They would run in the Container, where no secret may go (ADR-0016), and they sleep with it. Most useful ones need a credential, and one without a credential buys nothing over the agent running it with `bash`. | Serve it over HTTP somewhere public and add it as a direct server in the harness panel, or as a Commissary toolkit (ADR-0028). |
