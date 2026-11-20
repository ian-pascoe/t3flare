# A Deployment follows one t3 track, set as a Deployment setting

Status: accepted (2026-11-20). Refines [ADR-0017](0017-upstream-is-tracked-by-nightly-tag-with-an-automated-bump.md)
(the tag a t3 bump pins), [ADR-0037](0037-stock-clients-update-buttons-land-a-bump-the-do-dispatches-ci-which-proves-and-fast-forwards-main.md)
(the server Update's target policy) and [ADR-0038](0038-a-deployment-is-configured-outside-the-source-tree.md) (one
more required setting).

ADR-0017 tracked t3's nightly tags because the Owner's clients ran nightly. The nightlies change too much, several
times a day, for the Maintainer to want them on `prod`. Other Owners may still want them. So which t3 releases a
Deployment follows is a Deployment setting, its **t3 track**: `T3FLARE_T3_TRACK`, `stable` (t3's releases, `v<x.y.z>`)
or `nightly` (`v<x.y.z>-nightly.<yyyymmdd>.<run>`). The Maintainer's Deployment is set to `stable`, so the Canonical
repository's `main` follows t3's stable releases.

1. **Required, with no default** (ADR-0038 rule 1). Every deploy, the bump and the land read it. In CI it is a
   repository variable, set by `ci:setup`, because the bump's plan, the land and every deploy all need it.
2. **It names the pin.** t3 promotes a nightly's commit to a stable release, so a stable's commit also carries a
   nightly tag. The Server version is the pin's tag on the Deployment's track (`pinTagOf`). Before, it came from
   `git describe`'s choice between the two tags, which reported `prod` as stable while it tracked nightly. A pin with no
   tag on the track (a Deployment that just switched) is named by its other tag.
3. **The bump takes the newest tag on the track, and only moves forward.** The plan skips while main's pin is at or above
   that tag by semver (a release is above its own nightlies). The bump refuses a tag whose commit does not contain the
   pin's, because t3's migrations only go forward. So after a switch from nightly to stable, the bump waits for the
   first stable that contains the nightly pin. A switch from stable to nightly moves at once.
4. **An Update takes only the track's releases.** The build stamps the track into the Worker. The server Update refuses
   a target on the other track and tells the client to move to the Deployment's update track. It still refuses t3's
   track switch (`channel`), because the track is a Deployment setting. The Full gate's stock npm laptop runs the
   track's dist-tag (`latest` for stable, `nightly`).
5. **The setting does not gate the pin.** A Deployment that follows the Canonical repository's `main` without its own
   bump gets the Maintainer's stable pins. Because each stable's commit is also a nightly, a `nightly` setting still names
   those pins by their nightly tags. An Owner who wants nightlies runs their own bump (ADR-0038 rule 5).

## Considered Options

- **Switch the constant to stable.** One more constant in the source, which ADR-0038 retired, and a fork that wants
  nightlies would diverge.
- **Infer the track from the Server version at run time.** Wrong while a switched Deployment still runs the old track's
  pin.
- **Optional, defaulting to `stable`.** Friendlier to existing Deployments, but a silent default would flip a
  Deployment that runs its own nightly bump.
- **Accept t3's track switch (`channel`) in the Update.** It needs t3's migration handshake, and the bump moves the pin
  on its own anyway.

## Consequences

- A stable bump carries several days of upstream change, not one nightly's, so it is more likely to fail than an hourly
  nightly bump. The gates and the Upstream fingerprint still hold each bump. There is no nightly canary.
- The Owner keeps the stock clients on the Deployment's update track. A nightly client ahead of a stable cloud meets
  t3's own "switch tracks" note instead of an Update, and protocol skew (fragility U7) lasts until the next stable.
- Every existing Deployment sets `T3FLARE_T3_TRACK` before its next deploy, in `dev.env` and with `ci:setup` (or by hand
  as a repository variable).
