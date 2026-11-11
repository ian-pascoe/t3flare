# The Cloud Environment tells clients only what it does: classified capabilities and a built-in managed policy

The stock clients decide what to offer from two things the server sends: the descriptor's capability flags, and the settings, which a managed policy can lock. A laptop's t3 advertises what that laptop can do. Left as is, the Cloud Environment advertised the same, so clients offered features that fail in the cloud: scratch threads, an npm update, guest links whose link 404s, the device panel, cloud voice and custom text generators (the parity audit's G2). Two mechanisms now close this, both t3's own, so no Patch is needed (ADR-0001):

- **Every capability flag is classified** in `apps/environment/src/t3/capabilities.ts`, as kept or stripped, with a one-line reason for each strip. `composition.ts` serves t3's descriptor through `cloudCapabilities`. Every key of t3's `ExecutionEnvironmentCapabilities` must be in the list, so a flag a nightly adds fails typecheck and `test/capabilities.test.ts` until someone classifies it (fragility U4).
- **t3flare ships a managed policy.** This is t3's administrator policy (`ManagedPolicyDocument`), which is normally a machine-wide file. Here it is built in: `t3/managedPolicy.ts` provides t3's `ManagedPolicy` service from `fromDocument` instead of `ManagedPolicy.layer`, which reads the host. It locks the settings of features that have no capability flag, and clients show them as "Managed by t3flare". Writes to a locked setting are refused ("… is managed by t3flare and cannot be changed"). It locks `guestSharingEnabled`, the device settings (`enableDeviceSupport`, `enableAgentDeviceAccess`, `simlockDeviceHostsEnabled`) and `textGenerators` (empty), and sets no limits.

Stripped today:
- Host-bound: `serverBrowser`, `voiceTranscription`, `localServerStop`, `fastWorktreeCheckout`, `triage`.
- Self-update: `serverSelfUpdate`, `serverSelfUpdateProgress`, `serverUpdateThreadContinuation`, `serverInstallation`, `npmReleaseLookup`, `desktopAppUpdate`, `desktopAppChannelSwitch` (ADR-0017).
- Not built: `threadProjectFromScratch` (parity G4).
- Refused for now (owner decision D5): `cloudVoiceTranscription`.

## Considered options

- **Pinning settings off at each boot** (as `layerPinFastWorktreeCheckoutOff` does). It is invisible to the owner, and a client can turn the setting back on until the next boot. A lock is visible and enforced. The existing boot pins stay as they are; new ones should be locks.
- **Refusing the RPCs in the Environment DO.** That leaves every client offering a control that then fails, which is what this ADR removes.
- **A managed-policy limit `connect: false`**, which would hide guest links through t3's own Connect denial. Rejected: it also turns off T3 Connect, which step 3+ (the publish-only link) needs.

## Consequences

- Clients show "Managed by t3flare" with the repo as its support URL. A setting the owner wants back is a change to `managedPolicy.ts`, not a toggle.
- t3 validates the document at boot. A schema change upstream that refuses it fails the boot, and `test/capabilities.test.ts` fails first on the bump.
- Product analytics (D1) is a policy limit too (SPI-995).
