# SPI-1001 research: can a repo-scoped GitHub App installation token read a public repo outside its scope?

Researched 2026-11-13 against docs.github.com (REST and GitHub App pages). Sources were fetched and grepped as raw pages. Quotes are verbatim from those pages.

## Short answer

- **Settled by docs:** the contents-read endpoints (`GET /repos/{owner}/{repo}/contents/{path}`, `GET /repos/{owner}/{repo}/git/trees/{sha}`, `GET /repos/{owner}/{repo}/tarball|zipball/{ref}`) accept installation tokens and state that they work **without the Contents permission when only public resources are requested**. Public reads do not need the App to be installed on the repo.
- **Not settled by docs:** whether a token minted with `repositories:[A]` gets `200` (public read) or `404`/`403` on public repo `B`. The docs imply `200`, but none states it for installation tokens. Needs an empirical test.
- **Rate limits:** installation token is 5,000 req/h base, scaling up to 12,500 req/h. Unauthenticated is 60 req/h per IP. Docs tie the installation limit to the installation, not to the token's repo list.
- **JWT:** not documented as accepted for contents endpoints. Treat as unsupported until tested.

## Findings with citations

### 1. Contents-read endpoints allow public reads without repo permission (settled)

- https://docs.github.com/en/rest/repos/contents
  - Lists `GitHub App installation access tokens` among the accepted fine-grained token types for "Get repository content", with the requirement "The fine-grained token must have the following permission set: "Contents" repository permissions (read)".
  - Quote: "This endpoint can be used without authentication or the aforementioned permissions if only public resources are requested."
  - The same sentence and `allowsPublicRead: true` appear for the archive endpoints (`tarball/{ref}`, `zipball/{ref}`) on the same page.
- https://docs.github.com/en/rest/git/trees
  - Same permission block for "Get a tree" (`Contents` read; "This endpoint can be used without authentication or the aforementioned permissions if only public resources are requested.").
- https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
  - Quote: "These permissions are required to access private resources. Some endpoints can also be used to access public resources without these permissions. To see whether an endpoint can access public resources without a permission, see the documentation for that endpoint."
  - This is the general rule. Each endpoint page is the authority, and the contents/trees/archive pages state public-read explicitly.

### 2. Repo scoping limits what a token can be *granted*, not what it can read publicly (settled for the wording; behavior UNSETTLED)

- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
  - Quote: "Optionally, you can use the `repositories` or `repository_ids` body parameters to specify individual repositories that the installation access token can access. If you don't use `repositories` or `repository_ids` to grant access to specific repositories, the installation access token will have access to all repositories that the installation was granted access to. The installation access token cannot be granted access to repositories that the installation was not granted access to."
  - Quote: "The installation access token cannot be granted access to repositories that the installation was not granted access to."
  - This constrains the *mint*. It is not a statement about reads of public repos outside the installation.

### 3. Failure codes for out-of-scope access (partly settled)

- https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api
  - Quote: "If you try to use a REST API endpoint without a token or with a token that has insufficient permissions, you will receive a `404 Not Found` or `403 Forbidden` response."
- https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api
  - Quote: "If you make a request to access a private resource and your request isn't properly authenticated, you will receive a `404 Not Found` response. GitHub uses a `404 Not Found` response instead of a `403 Forbidden` response to avoid confirming the existence of private repositories."
  - For installation tokens: "The GitHub App has access to any repositories that the endpoint will affect."
  - **Reading this together:** 404 is the documented answer for *private* resources. Public resources are covered by the public-read sentence in finding 1, so a scoped token should get `200` on public `B`. The docs do not state the status for a scoped installation token against an out-of-scope public repo.
  - **UNSETTLED.** Test below.

### 4. Rate limits (settled for the documented values; scoping effect UNSETTLED)

- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
  - Unauthenticated: "You can make unauthenticated requests if you are only fetching public data. Unauthenticated requests are associated with the originating IP address, not with the user or application that made the request." and "The primary rate limit for unauthenticated requests is 60 requests per hour."
  - Installation token: "GitHub Apps authenticating with an installation access token use the installation's minimum rate limit of 5,000 requests per hour. If the installation is on a GitHub Enterprise Cloud organization, the installation has a rate limit of 15,000 requests per hour."
  - Scaling: "Installations that have more than 20 repositories receive another 50 requests per hour for each repository. ... The rate limit cannot increase beyond 12,500 requests per hour."
  - PAT: "All of these requests count towards your personal rate limit of 5,000 requests per hour."
  - Secondary limits (all tokens): "No more than 100 concurrent requests are allowed." and "No more than 900 points per minute are allowed for REST API endpoints". Most GET is 1 point.
  - **Scoping effect: UNSETTLED.** The docs tie the limit to the *installation* (scaled by installation repo count), not to the token's `repositories` list. Read the `x-ratelimit-limit` header on a scoped token and an unscoped token from the same installation to see whether they match.
  - **Bucket sharing: UNSETTLED.** Whether all tokens minted for one installation share one 5,000/h bucket is implied by "the installation's ... rate limit" but not stated. Test by alternating calls between two tokens and watching `x-ratelimit-remaining`.

### 5. Git over HTTPS with an installation token (partly settled)

- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
  - Quote: "You can also use an installation access token to authenticate for HTTP-based Git access. Your app must have the "Contents" repository permission. You can then use the installation access token as the HTTP password. Replace `TOKEN` with the installation access token: `git clone https://x-access-token:TOKEN@github.com/owner/repo.git`."
- Anonymous public git clone is not addressed by the cloning page I checked (https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository). No public-read statement appeared in it.
  - **UNSETTLED** for smart-HTTP (`git clone`/`git fetch`) on an out-of-scope public repo with a scoped token. The "Contents" requirement is worded for the App's own repos. The REST public-read sentence does not cover git transport.

### 6. JWT (UNSETTLED for contents; documented as app-level only)

- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app
  - Quote: "If a REST API endpoint requires you to authenticate as an app, the documentation for that endpoint will indicate that you must use a JWT to access the endpoint."
  - JWT is documented for app-level endpoints (`GET /app`, `GET /app/installations`, `POST /app/installations/{id}/access_tokens`). The contents endpoints list only user-to-server, installation (server-to-server), and fine-grained PAT token types. JWT is not listed.
  - **UNSETTLED.** Test: `GET /repos/{owner}/{repo}/contents/README.md` with `Authorization: Bearer <JWT>` against a public repo.

### 7. Unscoped token (settled by the same rules)

- Unscoped installation tokens get all repos the installation has, per the access-tokens quote in finding 2. For public reads, the same "public resources" sentence applies, so scoping should not change the public-read result. This is the same UNSETTLED behavior from finding 3, not a separate question.

### 8. Comparison: fine-grained PAT (for contrast only)

- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
  - Quote: "Tokens always include read-only access to all public repositories on GitHub."
  - This states the rule explicitly for fine-grained PATs. The GitHub App pages do not repeat it. This is the strongest hint for the App case, but it is not an App-specific statement.

### 9. Practical limits for the read path (settled)

- Contents API: 1 MB files support all features; 1–100 MB files need raw/object media types; over 100 MB not supported; "This API has an upper limit of 1,000 files for a directory. If you need to retrieve more files, use the Git Trees API." (https://docs.github.com/en/rest/repos/contents)
- Git Trees recursive: "The limit for the tree array is 100,000 entries with a maximum size of 7 MB when using the recursive parameter." (https://docs.github.com/en/rest/git/trees)
- Archives: "Source code archives are generated on request, cached for a while, and then deleted." (https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives)

## UNSETTLED items and the empirical test that would settle each

Repo IDs below are placeholders. Use a public repo `B` the installation does not cover, and a private repo `P` in the same org.

1. **Scoped token, out-of-scope public repo, REST.**
   - Mint with `repositories:["A"]` (A in installation). Call `GET https://api.github.com/repos/{owner}/{B}/contents/README.md` and `GET .../git/trees/HEAD?recursive=1` and `GET .../tarball/HEAD`.
   - Expected by docs: `200`. Record status, `x-accepted-github-permissions`, and body.
   - Control: same call with no token (expect `200`), and with a token scoped to `B` only (expect `200`).
   - Also call against private `P` outside scope: expect `404`.
   - If the result is `404` or `403` for public `B`, the docs' public-read sentence does not extend to scoped installation tokens. That would be a significant finding.

2. **Scoped token, out-of-scope public repo, git transport.**
   - `git clone https://x-access-token:$TOKEN@github.com/{owner}/{B}.git` on a public repo `B`.
   - Also `git ls-remote https://github.com/{owner}/{B}.git` with no credentials, as control.
   - Record exit code and any `remote: ... 403/404` text.

3. **JWT on contents endpoints.**
   - `GET /repos/{owner}/{B}/contents/README.md` with `Authorization: Bearer <JWT>` (public `B`, and a repo the App is installed on).
   - Record status and error body. Docs do not list JWT as accepted here, so an error is an acceptable outcome, but the error type should be recorded.

4. **Rate-limit scoping and bucket sharing.**
   - Compare `x-ratelimit-limit` between a scoped and an unscoped token from the same installation.
   - Alternate two tokens from the same installation and check whether `x-ratelimit-remaining` decrements on a shared counter.
   - Check whether public-repo reads through an installation token decrement the same counter as installation-repo reads.

5. **Unauthenticated limit.**
   - Docs say 60/h per IP. Confirm `x-ratelimit-limit: 60` on a no-token call to `GET /rate_limit` or any public endpoint.

## Notes

- All links above were fetched 2026-11-13. Scratch files went to `/tmp` only. The only repo file written is this one.
- Docs version header: the pages reference `X-GitHub-Api-Version: 2026-03-10`. Use that header in all test calls so results match the documented behavior.
