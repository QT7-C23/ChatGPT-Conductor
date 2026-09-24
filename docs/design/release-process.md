# Local release workflow proposals

These workflows are local implementation proposals. They have not run on GitHub.
The package remains private for npm; the project license is MIT. `POLICY` in
`scripts/release-workflow.mjs` records MIT but deliberately has no public-evidence approval
or authorized reviewers. All approval, draft and publication paths fail closed
until a separately approved M8 configuration change and live integration checks.
An environment name or repository variable alone is never accepted as protection.

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
3. After configuration is genuinely validated, dispatch `approve-release` with
   purpose `candidate` and an exact JSON packet. The packet fields are schema=1,
   purpose=candidate, decision=APPROVE_CANDIDATE, binding=the full build evidence,
   draft_id=null, final_assets=null, accept_ref=null and publish_ref=null.
   Its hardcoded `release-candidate-approval` environment must require an
   allowlisted reviewer. The observed self-review setting is recorded; the same
   owner may approve separate stages when repository policy permits. The resulting single-file `approval` artifact is the
   specific approval input, identified by run ID, artifact ID and archive SHA256.

The approved actor and triggering actor must both be in the reviewed reviewer
allowlist. Artifact download checks authenticated GitHub run/repository/path/ref,
successful current attempt, workflow source SHA, creation time, artifact ID and
GitHub archive digest, then hashes the actual archive bytes. Safe extraction only
permits exact named flat files with size limits; candidate code is never imported
or executed by a writer. Inputs enter environment variables and validated fixed
argument arrays, never shell expressions.

## Draft preparation

`prepare-release` takes candidate commit plus candidate and approval run IDs,
artifact IDs and archive digests. Its protected read-only check job rebuilds and
verifies the actual candidate and compares approved hashes. The dependent writer
checks out only trusted default workflow source, reauthenticates both artifacts,
and rechecks remote configuration. It creates a new lightweight `refs/tags/v1.2.0`
at the exact candidate commit; existing tags cause refusal, never force/reuse.
It creates a draft, obtains the real ID, generates the external manifest through
the existing packager and uploads only ZIP, CHANGELOG.md, release-manifest.json
and SHA256SUMS. It downloads all four and compares every byte digest.

The `draft-packet` artifact is a proposal, not approval. Its ACCEPT and publish
references are null and cannot pass publishing. Failure leaves the draft/tag for
explicit human investigation; no automatic cleanup, replacement or tag reuse.
Preparation never sets draft=false.

## Separate final acceptance and publishing

Review the exact draft assets, complete independent review and obtain final chat
ACCEPT plus a distinct explicit publish approval. Insert their separate durable
references into `accept_ref` and `publish_ref` in the draft packet. Dispatch
`approve-release` with purpose `publish`. Its separate hardcoded `release-publish`
environment emits a new approval artifact. This artifact binds full build
identity, version/channel, draft ID and all four final digests. Candidate payload
and CHANGELOG hashes must still match the candidate approval.

Dispatch `publish-release` with that approval artifact and the exact draft ID.
Both the read-only check and protected writer require the latest verify run for
the candidate SHA to be completed/successful, with all four matrix jobs from its
current attempt. Pagination is complete or rejected. The tag must still point
to the exact commit. Downloaded manifest fields and SHA256SUMS must match the
approved candidate and actual draft ID. Only then can the writer set draft=false.
The separate read-only post job checks immutable=true, exact tag/asset set/hashes,
`gh release verify` and `gh release verify-asset` for every asset. The standalone
`verify-published` workflow repeats those checks when manually dispatched.
Failure reports a blocked run; it never replaces published assets.

## Required remote configuration and remaining integration

- MIT is selected; the owner must still approve what evidence may be
  public. A reviewed policy change records those decisions and authorized users.
- Default branch must be `main`; the live gate requires enforced admin protection,
  PR review, strict four-matrix required checks and no branch force-push/deletion.
  Configure two separate active tag rulesets for exact `refs/tags/v1.2.0`: creation
  permits only the reviewed publisher Integration ID, while update/deletion have
  no bypass actors. Their exact ruleset IDs and publisher ID are unconfigured in
  POLICY. Broader, ambiguous or inaccessible policies fail closed. Validate the
  actual GITHUB_TOKEN integration identity/creation permission in M8 before use.
- Configure the three named environments with required allowlisted reviewers
  and one custom branch policy: type=branch, name=main. The helper records each
  observed self-review setting. Prepare and publish are separate protected
  approval stages/events; reviewer identity overlap is allowed, including a
  single-owner repository when its actual environment settings permit it.
- Provide the protected read-only `RELEASE_CONFIG_TOKEN` with Administration:read
  for the repository immutability API. A contents:write token does not imply that
  permission. Unknown/disabled/inaccessible immutability or environment policy
  blocks the helper. The token is not passed to candidate child processes.
- Enable immutable releases, verify environment support on the repository plan,
  require the four verify checks, and confirm token permissions/actor fields,
  artifact digest/download APIs, current attempts and `gh` attestation support.
- Obtain separate authorization for a test repository/release. Exercise draft →
  immutable publication → attestation/download. No local fixture proves this.

No automatic push-to-main release, license selection, final ACCEPT or remote
configuration is performed by this implementation. Linux/Node22, actual remote
matrix, protected-environment enforcement, GitHub release attestation and actual
publication remain live integration evidence, not local test claims.

The protection shape follows the official [repository rules REST API](https://docs.github.com/en/rest/repos/rules),
checked read-only during implementation. Strict settings are an implementation
requirement; this citation does not claim those settings exist in this repository.

## Single-maintainer approval boundary

Environment approval and pull-request approval are separate gates. The current repository gate still requires at least one approving PR review and administrator enforcement. GitHub does not allow a PR author to approve their own PR. Allowing environment self-review does not satisfy that requirement. A single account authoring and merging its own PR cannot satisfy this policy. An independently eligible reviewer, or a separately authorized eligible PR author with the maintainer reviewing, is required; verify actual GitHub eligibility before relying on this route. No local review record substitutes for a GitHub approval.

See [GitHub PR review rules](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews) and [environment approval rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments). Reviewer identities, environment self-review settings and all remaining release policy fields require explicit configuration and approval.
