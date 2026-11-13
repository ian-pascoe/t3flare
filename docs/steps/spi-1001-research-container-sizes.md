# SPI-1001 research: Cloudflare Container instance sizes, limits, pricing

Research date: 2026-11-13. Primary sources only: developers.cloudflare.com docs and changelog, and `@cloudflare/workers-types` on disk.

Items marked **UNSETTLED** conflict between sources or are not stated by any source read.

## Source gaps

- **`@cloudflare/containers` is not on disk.** The t3flare worktree has no `node_modules` (`ls node_modules` → "No such file or directory"). A search of `~/src` and `~/.t3` found no `@cloudflare/containers` package. The only copy of `@cloudflare/workers-types` found is `/Users/ianpascoe/src/cloudpid/node_modules/@cloudflare/workers-types` (version `5.20261112.1`). That copy is cited below. Its `index.d.ts` is the only type source used here.
- The `pricing` page at `/containers/platform-details/pricing/` returns 404. The live page is `https://developers.cloudflare.com/containers/platform/pricing/`.

## 1. Runtime per-start instance size

**Documented, not only in types.** Per-start sizing exists only under the `durable_object` scheduling policy.

- `default` policy: size comes from Wrangler `instance_type`, one per application. "With the `default` scheduling policy, call `container.start()` without options." (`https://developers.cloudflare.com/containers/api/durable-object-container/`, Nov 9 2026)
- `durable_object` policy: "Set `instance` in `ctx.container.start()` to one of the following named instance types: `lite`, `standard-1`, `standard-2`, `standard-3`, `standard-4`. The runtime does not accept `basic` or the legacy `dev` and `standard` aliases. If you omit `instance`, the Container uses `lite`." (`https://developers.cloudflare.com/containers/configuration/scheduling-policy/`, Nov 4 2026, section "Choose an instance size at runtime")
- Custom object: "You can also supply a custom instance object..." with `vcpu`, `memoryMib`, `diskMb`. "`memoryMib` is in mebibytes and `diskMb` is in megabytes. Both must be positive integers." (`https://developers.cloudflare.com/containers/api/durable-object-container/`, `start` → Parameters → `instance`)
- Errors: "`start()` throws a `TypeError` when ... `instance` names an unknown type. `start()` throws a `RangeError` when a custom `instance` value is missing or invalid." (same page, `start` → Exceptions)

**Constraints from the deployed class:**

- Under `durable_object`, Wrangler rejects `instance_type` and `max_instances`: "Wrangler rejects every other Container application field for this policy, including `image`, `instance_type`, `max_instances`, rollout settings, and placement constraints." (`https://developers.cloudflare.com/workers/wrangler/configuration/`, Containers section, "durable_object" entry). Also: "The `durable_object` policy does not support `max_instances`. Running instances count toward your account limits." (`https://developers.cloudflare.com/containers/configuration/scheduling-policy/`, "Use the Durable Object scheduling policy")
- So a `durable_object` start is **not** constrained by a deployed `instance_type` or `max_instances`. It is constrained only by the account-level limits (section 4) and the per-instance limits (section 3).
- Under `default`, `instance_type` is the only size and `max_instances` defaults to 20 ("Defaults to 20", Wrangler configuration page, Containers section).

**UNSETTLED:** the runtime types list `"basic"` as a valid `instance` value (`workers-types/index.d.ts:3798`), but the docs say the runtime does not accept it (scheduling-policy page). Treat `basic` as **not usable** at runtime, per the docs. The type is looser than the runtime.

## 2. Named instance types

Source: `https://developers.cloudflare.com/containers/platform/limits/` (Last updated Nov 12 2026), "Instance Types" table. The same table appears on the pricing page.

| Type | vCPU | Memory | Disk |
|---|---|---|---|
| lite | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 | 1/2 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

- Quote: "The `dev` and `standard` instance types are preserved for backward compatibility and are aliases for `lite` and `standard-1`, respectively."
- No `cpu-` or `mem-` named types appear in any source read. The question about them is **answered: none documented**.
- Runtime accepts only `lite`, `standard-1..4` (section 1). `basic` is in the Wrangler `default` list only (`https://developers.cloudflare.com/workers/wrangler/configuration/`: "Supported values are `"lite"`, `"basic"`, `"standard-1"`, ... `"standard-4"`").

## 3. Custom-size bounds

**Two different rule sets, depending on policy.**

**`durable_object` policy** (`https://developers.cloudflare.com/containers/platform/limits/`, "Custom Instance Types"):

- "Custom instance types using the `durable_object` scheduling policy have the following minimums: vCPU 1/16 (`0.0625`), Memory 256 MiB, Disk 2 GB (`2000` MB)."
- "Maximum resources per instance are subject to your account limits." Per-instance maxima from the same page's Account limits table: vCPU 4, memory 12 GiB, disk 20 GB.
- Maximum vCPU/memory/disk: **4 vCPU / 12 GiB / 20 GB** (per-instance account default).
- Memory-per-vCPU ratio: **UNSETTLED.** The current page does not state one for `durable_object`.

**`default` policy** (older page version, `https://developers.cloudflare.com/containers/platform/limits/index.md`, "Last updated Nov 2, 2026"; same figures in the Feb 2026 changelog):

| Resource | Limit |
|---|---|
| Minimum vCPU | 1 |
| Maximum vCPU | 4 |
| Maximum Memory | 12 GiB |
| Maximum Disk | 20 GB |
| Memory to vCPU ratio | Minimum 3 GiB memory per vCPU |

- "For workloads requiring less than 1 vCPU, use the predefined instance types such as `lite` or `basic`."

**Disk-to-memory ratio:** removed. Quote: "Custom Container instance types no longer have a disk to memory ratio limit ... You can now allocate up to the 20 GB disk maximum to any custom instance type. ... The other custom instance type constraints do not change, including the minimum of 3 GiB of memory per vCPU." (`https://developers.cloudflare.com/changelog/product/containers/`, Sep 29 2026 entry. The per-entry URL 404s, so cite the product changelog.)

**UNSETTLED:** whether the 3 GiB/vCPU minimum and the 1 vCPU minimum still apply to `durable_object` custom sizes. The `durable_object` section (1/16 vCPU, 256 MiB) suggests they do not, but no source says so.

Wrangler `default` custom-instance defaults (`https://developers.cloudflare.com/workers/wrangler/configuration/`, "Custom instance types"): `vcpu` defaults to `0.0625`, `memory_mib` to `256`, `disk_mb` to `2000`.

## 4. Account-wide concurrent limits

**Two conflicting values. Both are documented, and the newer one is UNSETTLED until confirmed.**

Current (`https://developers.cloudflare.com/containers/platform/limits/`, Last updated Nov 12 2026):

| Resource | Limit |
|---|---|
| Concurrent memory | 60 TiB |
| Concurrent vCPU | 15,000 |
| Concurrent disk | 300 TB |

Earlier (`https://developers.cloudflare.com/containers/platform/limits/index.md`, Nov 2 2026; changelog Feb 25 2026, `https://developers.cloudflare.com/changelog/product/containers/`):

- "Memory for concurrent live Container instances | 400GiB | 6TiB ... vCPU ... | 100 | 1,500 ... Disk ... | 2TB | 30TB."

A 10x jump between Nov 2 and Nov 12 with no changelog entry seen. **UNSETTLED.**

- Quote (current page): "All instance size maximums and account limits on this page are defaults and can be increased."
- **Workers Paid plan qualifier: UNSETTLED.** The limits page says "The following limits apply per account" with no plan name. No source read ties these numbers to Workers Paid specifically.

**Do three `standard-4` containers fit? Yes, under either set.**

- Three `standard-4` = 12 vCPU, 36 GiB memory, 60 GB disk.
- Against the current set: 12 / 15,000 vCPU; 36 GiB ≈ 0.035 TiB / 60 TiB; 60 GB ≈ 0.06 TB / 300 TB.
- Against the earlier set: 12 / 1,500 vCPU; 36 GiB ≈ 0.035 TiB / 6 TiB; 60 GB ≈ 0.06 TB / 30 TB.
- Per-instance check: each `standard-4` is exactly at the 4 vCPU / 12 GiB / 20 GB per-instance maximum (limits page), so it is allowed.
- Caveat: the limits apply to concurrently running instances, so stopped instances do not count. The `durable_object` docs say running instances count toward account limits. Sleep behavior: "Charges stop after the container instance goes to sleep" (pricing page).

## 5. Pricing

Source: `https://developers.cloudflare.com/containers/platform/pricing/` (Last updated Nov 13 2026).

| Resource | Workers Paid included/month | Overage rate |
|---|---|---|
| Memory | 25 GiB-hours | $0.0000025 per GiB-second |
| CPU | 375 vCPU-minutes | $0.000020 per vCPU-second |
| Disk | 200 GB-hours | $0.00000007 per GB-second |

- Quote: "Containers are billed for every 10ms that they are actively running at the following rates, with included monthly usage as part of the $5 USD per month Workers Paid plan."
- Quote: "Memory and disk usage are based on the *provisioned resources* for the instance type you select, while CPU usage is based on *active usage* only."
- Free plan: "N/A" for all three.
- Derived, not stated by Cloudflare: a `standard-4` running for one hour, at full CPU, costs 4 × 3600 × $0.00002 = $0.288 CPU, 12 × 3600 × $0.0000025 = $0.108 memory, and 20 × 3600 × $0.00000007 = $0.00504 disk.
- Egress is billed separately: $0.025/GB in North America and Europe, with 1 TB included (pricing page).
- Snapshots: "available at no charge during the public beta."

## Other relevant facts

- Snapshot max size 20 GB; retention 30 days (limits page, Snapshot limits).
- Image size max equals instance disk space; total image storage per account 50 GB (limits page).
- `durable_object` policy is in **public beta** (scheduling-policy page).
- Changelog Feb 25 2026: "You can now run 15,000 instances of the lite instance type, 6,000 instances of basic, over 1,500 instances of standard-1, or over 1,000 instances of standard-2 concurrently." (under the earlier limits).

## Open items (UNSETTLED)

1. Account concurrent limits: 60 TiB / 15,000 vCPU / 300 TB (Nov 12 page) vs 6 TiB / 1,500 vCPU / 30 TB (Nov 2 page, Feb 2026 changelog). Confirm with the dashboard or support.
2. Whether limits are Workers-Paid-specific.
3. Memory-per-vCPU ratio and 1-vCPU minimum for `durable_object` custom sizes.
4. Whether `basic` is accepted by `ctx.container.start({ instance })`. Types say yes, docs say no.
5. `@cloudflare/containers` SDK types: not on disk. Only `workers-types` was checked.
