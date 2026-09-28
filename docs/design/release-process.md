# Release workflow and live configuration

The candidate and configuration workflows have run on GitHub; no Release has
been published. The package remains private for npm; the project license is MIT.
`POLICY` in `scripts/release-workflow.mjs`
records the verified owner, main ruleset and dedicated publisher identity.
The owner approved public scope on 2026-09-28, recorded as
`owner-public-scope/v1.3.0/2026-09-28`: skill code, documentation, examples,
tests, pinned dependencies and licenses. Release assets are limited to
`chatgpt-conductor-1.3.0.zip`, `CHANGELOG.md`, `release-manifest.json` and
`SHA256SUMS`. Private keys, tokens, chat records, personal files and local run
logs are excluded. This scope decision does not approve a candidate or publication.
Approval, draft and publication paths fail closed until policy and live
configuration checks pass. The V1.3.0 profile is single-maintainer: one allowlisted
owner approves the two explicit release stages; an independent PR reviewer is not required.
An environment name or repository variable alone is never accepted as protection.

The local product and packaging target is 1.3.0. The older exact `v1.2.0`
rulesets are preserved. Each new version needs its own exact creation and
immutable tag rules; changing a package version does not extend protection.
The release jobs now use the registered publisher App via the official pinned
`actions/create-github-app-token` action. Publisher authentication succeeded in
configuration run `36456454954`; a successful complete live preflight and both
owner decisions are still required. Do not reuse 1.2.0 candidate or approval evidence.

## Publisher authentication and configuration preflight

The private App is `QT7-C23 Conductor Publisher` (Integration ID `5109993`,
installation `165834076`). The fixed client ID is public configuration. An owner
must generate its private key and store it as repository Actions secret
`CONDUCTOR_PUBLISHER_PRIVATE_KEY`; never paste it into a chat or commit it.
The installation covers only `ChatGPT-Conductor`, with Contents:write,
Actions:read and Administration:read (Metadata:read is automatic).

Each trusted release job mints its own token for this repository. Read jobs
request Contents:read except `publish-release.check`: draft visibility requires
push access, so it requests the App's already-granted Contents:write permission.
The helper nevertheless rejects every non-GET request in check, approval,
configuration and verification modes. Only prepare/publish writer modes may
send mutations. All built-in `GITHUB_TOKEN` permissions stay read-only.
Tokens are revoked by the action at job end. The helper checks the action's
installation ID and App slug against trusted policy. Candidate verification
children receive no credential environment variables.

Dispatch `preflight-release` on main to gather a read-only configuration report
and download the `configuration-preflight` artifact. It reports license,
public-evidence consent, publisher identity, repository identity, immutable
releases, owner environment, exact main/tag rules and local `gh` verification
command support. Its `stage=configuration` READY is only configuration readiness;
candidate CI, deterministic bytes and both owner decisions are checked by their
later gates. Command support does not prove a release attestation already exists.
Unreadable evidence includes only the gate, optional ruleset ID and HTTP status
(or null for a transport failure). Missing bypass arrays are listed by ruleset
ID. Raw errors, response bodies and credentials are not included in the report.

Bypass actor visibility must be tested with the actual installation token.
GitHub documents that this property can be omitted for callers lacking ruleset
write access. Omission remains UNKNOWN, never an empty bypass list. The optional
existing `RELEASE_CONFIG_TOKEN` can supply configuration reads; no additional
token or Administration:write permission is created automatically. Resolve any
live visibility limitation before releasing.

## Verification and byte identity

`verify.yml` runs `npm ci --ignore-scripts` then `node scripts/verify.mjs` on
Windows/Linux and Node 22/24, with contents read only. Pull requests never receive
release privileges. Actions are pinned to full official commits. Workflows use
JSON syntax, a YAML subset, so offline tests parse actual jobs, permissions,
dependencies and checkout references without another runtime dependency.

Exact product paths in `.gitattributes` use `-text`: checkout preserves committed
bytes even with Windows autocrlf enabled. Existing legacy fixture bytes are not
normalized. The packager includes only explicitly named workflow files and its
existing exact dependency closure. No generic hidden-directory exception exists.

## Candidate and human approval

1. Dispatch `package-candidate` from the default branch (`main`) with a reviewed
   full 40-hex commit. Trusted workflow/helper code is checked out separately from
   candidate source. The read-only job checks actual candidate HEAD, runs the
   fixed verification entrypoint and makes two byte-identical builds.
2. Download/review the explicit `candidate` artifact. Its `build-evidence.json`
   binds repository, workflow path, default workflow ref/SHA, run ID/attempt,
   actual candidate source SHA, version/channel, exact payload/CHANGELOG hashes,
   and hashes of candidate.json and payload-inventory.json.
   Workflow run SHA is not treated as candidate checkout SHA. `candidate.json`
   has no fabricated release ID or installable external manifest.
3. After configuration is genuinely validated, and exact source CI is successful,
   dispatch `approve-release` with
   purpose `candidate` and an exact JSON packet. The packet fields are schema=1,
   purpose=candidate, decision=APPROVE_CANDIDATE, binding=the full build evidence,
   draft_id=null, final_assets=null, accept_ref=null and publish_ref=null.
   The single hardcoded `release-approval` environment must require the one
   allowlisted owner and permit self-review. This is owner approval #1: permission
   to prepare a draft for the exact candidate, not permission to publish it. The
   single-file `approval` artifact is identified by run ID, artifact ID and archive
   SHA256. The receipt is valid only with the exact build evidence and its source
   commit, run identity, inventory and payload digests.

The run actor and triggering actor must both be the one configured owner. Artifact
download checks authenticated GitHub run/repository/path/ref,
successful current attempt, workflow source SHA, creation time, artifact ID and
GitHub archive digest, then hashes the actual archive bytes. Safe extraction only
permits exact named flat files with size limits; candidate code is never imported
or executed by a writer. Inputs enter environment variables and validated fixed
argument arrays, never shell expressions.

Actions archive requests use `application/vnd.github+json` at the REST download
endpoint; release-asset byte requests use `application/octet-stream`. Remote-read
failures report only a fixed operation label (including draft metadata, main
HEAD, tag identity and source ancestry) and an HTTP status when available,
never credentials, response bodies, signed download URLs or transport messages.

## Draft preparation

`prepare-release` takes candidate commit plus candidate and approval run IDs,
artifact IDs and archive digests. Its protected read-only check job rebuilds and
verifies the actual candidate and compares approved hashes. The dependent writer
checks out only trusted default workflow source, reauthenticates both artifacts,
and rechecks remote configuration, current main HEAD and the latest exact-source
four-matrix CI run. The reviewed source must still be main HEAD for preparation,
avoiding a need for Workflows:write when creating the tag and draft. It creates a new lightweight `refs/tags/v1.3.0`
at the exact candidate commit; existing tags cause refusal, never force/reuse.
It creates a draft, obtains the real ID, generates the external manifest through
the existing packager and uploads only ZIP, CHANGELOG.md, release-manifest.json
and SHA256SUMS. It downloads all four and compares every byte digest.

The `draft-packet` artifact is a proposal, not approval. Its ACCEPT and publish
references are null and cannot pass publishing. Failure leaves the draft/tag for
explicit human investigation; no automatic cleanup, replacement or tag reuse.
Preparation never sets draft=false.

## Owner approval #2 and publishing

Review the exact draft assets and obtain final Chat ACCEPT plus a distinct explicit
owner decision to publish. These are separate authorization domains: Chat ACCEPT
does not publish, and release approval never grants task execution authority. Put
the two durable references in `accept_ref` and `publish_ref`; they must differ.
Dispatch `approve-release` with purpose `publish`. Its `release-approval`
environment produces a second immutable approval artifact. This is owner approval
#2, bound to the full candidate evidence, exact draft Release ID, and SHA-256 of
all four final assets. Candidate payload and CHANGELOG hashes must still match
approval #1. References in packet JSON are evidence labels; they cannot create
either approval.

Dispatch `publish-release` with that approval artifact and the exact draft ID.
The read-only check and writer require current main HEAD to equal the trusted
workflow run SHA. A workflow repair may advance main after draft preparation:
GitHub's comparison must prove that the unchanged approved candidate source is
an ancestor of that workflow SHA, and the latest exact-source verify runs for
both commits must be completed/successful with all four matrix jobs from their
current attempts. A moved main HEAD, unrelated source or failed/missing CI blocks
publication. This separates operational workflow repairs from frozen payload
bytes; it does not change the candidate, tag, draft or either approval receipt.
Pagination is complete or rejected. The tag must still point
to the exact commit. Downloaded manifest fields and SHA256SUMS must match the
approved candidate and actual draft ID. Only then can the writer set draft=false.
The separate read-only post job checks immutable=true, exact tag/asset set/hashes,
`gh release verify` and `gh release verify-asset` for every asset. The standalone
`verify-published` workflow repeats those checks when manually dispatched.

Post-publish verification returns `VERIFIED` only when publication identity, all
asset bytes and all attestations pass. If publication is confirmed but any check
fails or cannot complete, status is `PUBLISHED_UNVERIFIED`, with
`installable=false`; the verification detail is BLOCKED for a known mismatch and
UNKNOWN when evidence cannot be read. If the workflow cannot confirm whether the
Release was published, status is `PUBLICATION_UNKNOWN`; if it remains a draft,
status is `NOT_PUBLISHED`. Both are non-installable. The release may already be
publicly visible and immutable, so the workflow fails and does not replace or
rewrite it. Rerun verification after resolving a transient verification outage.
Consumers still authenticate the exact release and every required asset before
install, update or rollback; failed attestation produces no authenticated bundle
and therefore no installable target.

The read-only check, writer and post-publish verification do not have separate
environment prompts. The two `approve-release` jobs are the only environment-gated
steps. A consumed preparation receipt cannot create another tag: tag creation
fails if the exact V1.3.0 tag already exists. A publish receipt cannot publish a
different draft or be replayed after publication: exact Release ID and asset
hashes must match, and the writer requires the Release still to be a draft.

## Required remote configuration and remaining integration

- MIT is selected; the owner's approved public scope is recorded above and in
  POLICY. Each candidate and exact draft still needs its separate owner decision.
- Default branch must be `main`; the live gate reads active `main-protection`
  ruleset `24122310`, exact main inclusion, no bypass, PRs with zero required
  approvals, the four checks bound to GitHub Actions Integration `15368`, and
  no branch force-push/deletion. The approved ruleset does not require strict
  up-to-date branches. Normal
  development uses a feature branch and PR, but a second GitHub account's approval
  is not a release requirement.
  Configure two separate active tag rulesets for exact `refs/tags/v1.3.0`: creation
  permits only the reviewed publisher Integration ID, while update/deletion have
  no bypass actors. Record only live-verified ruleset IDs in POLICY. Broader,
  ambiguous or inaccessible policies fail closed. The dedicated App identity,
  rather than the built-in Actions integration, performs writes.
- Configure one `release-approval` environment with exactly the single owner
  allowlisted, `prevent_self_review=false`, and one custom branch policy:
  type=branch, name=main. Only the two owner decision jobs use it. The actual
  GitHub plan and environment behavior must be confirmed in preflight; unknown
  behavior blocks release.
- The App token explicitly requests Administration:read for repository
  immutability reads. A contents:write token does not imply that permission.
  An existing optional `RELEASE_CONFIG_TOKEN` may be reused if needed for
  configuration visibility. Unknown/disabled/inaccessible immutability or
  environment policy blocks the helper. Tokens never reach candidate children.
- Enable immutable releases, verify environment support on the repository plan,
  require the four verify checks, and confirm token permissions/actor fields,
  artifact digest/download APIs, current attempts and `gh` attestation support.
- Obtain separate authorization for a test repository/release. Exercise draft →
  immutable publication → attestation/download. No local fixture proves this.

No automatic push-to-main release, license selection, final ACCEPT or remote
configuration is performed by this implementation. Linux/Node22, actual remote
matrix, protected-environment enforcement, GitHub release attestation and actual
publication remain live integration evidence, not local test claims.

## Release preflight contract

Preflight reports `READY`, `BLOCKED`, or `UNKNOWN` per gate and overall. A
confirmed failed or mismatched gate is `BLOCKED`; an inaccessible or unobserved
fact is `UNKNOWN`; only complete positive evidence is `READY`. Missing branch
protection access, unknown immutable-release plan/API support, unknown attestation
verification capability, incomplete CI, or missing owner approval must never be
translated into false/disabled or success. At minimum the report covers exact
source identity, local verification, all four Linux/Windows × Node 22/24 CI jobs,
deterministic candidate and inventory/hash checks, each owner approval, tag and
Release identity, artifact bytes, attestation verification capability,
immutability, and post-publish verification. Pre-publish `READY` checks that
attestation verification is supported; it does not claim the not-yet-generated
release attestation passed. The actual attestation result is evaluated only after
publication. Any non-READY preflight prevents publishing. `releasePreflight(gates)`
implements and tests this three-state preflight contract; the separate
`postPublishVerification(gates)` contract reports `VERIFIED` or
`PUBLISHED_UNVERIFIED`. `preflight-release` gathers a configuration-stage report.
It deliberately does not label a not-yet-approved candidate READY for publication.
The approval, prepare and publish entrypoints independently enforce their
source, current CI, artifact, byte and decision bindings.

The earlier empty-ruleset observation is superseded by live configuration on
2026-09-28: main ruleset `24122310`, owner environment `release-approval`,
dedicated publisher installation, preserved exact 1.2.0 tag rules, and exact
1.3.0 creation rule `24127483` (only Integration `5109993`) and immutable tag rule
`24127202` (no bypass). Repository Release immutability was enabled
and verified by reloading its settings page. UI evidence does not replace the
runtime identity's API reads. No Release attestation has been verified yet.

The protection shape follows the official [repository rules REST API](https://docs.github.com/en/rest/repos/rules),
checked during implementation. App authentication follows the official
[GitHub App Actions guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow).
Immutable publication generates a release attestation as described by
[GitHub](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).
Draft visibility follows the [release API](https://docs.github.com/en/rest/releases/releases#list-releases):
only callers with push access can see drafts. Publication ancestry uses the
[commit comparison API](https://docs.github.com/en/rest/commits/commits#compare-two-commits).

## Single-maintainer policy migration

The prior multi-reviewer and three-environment contract is superseded for this
profile. Configure exactly one owner identity in the trusted policy and the one
approval environment; do not preserve duplicate `release-candidate-approval`,
`release-prepare`, and `release-publish` prompts. The PR review-count requirement
is removed; force-push/delete protection and required CI remain. Approval packet
schema 1 is retained for the existing V1.2.0 workflow contract. Old artifacts are
not upgraded or treated as new consent: they must still pass the current owner
identity, remote environment, exact source/draft, and digest checks. Reissue both
owner approvals under the revised workflow as the unambiguous migration path.
The earlier policy migration did not rewrite or authorize a V1.2.0 candidate,
tag or release. Subsequent live settings are recorded in the configuration
section above; they do not constitute either candidate or publish consent.
