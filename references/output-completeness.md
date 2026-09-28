# Output Completeness / DeliveryManifestV1（M9）

This is a local delivery extension, separate from schema-2 ProjectState, Execution/Result Packets, content Review and execution authorization. It does not add lifecycle states or public CLI commands. The production entry is `scripts/delivery-manifest.mjs`; M1's isolated spike remains historical and is not imported by production.

## When to plan

Use `planDelivery({ artifact_id, artifact_revision, artifact_kind, sections, policy? })` for an expected long Spec, PRD, Architecture Review, Product Brief or multi-part execution plan. Each input section is `{ id, content }`, an authored semantic unit with a stable identity. Actual text must exist before computing its digest: an outline may name future sections, but cannot invent their hashes or claim them delivered. Amend the plan and advance the artifact revision if scope, wording, section order or boundaries change.

The default fast path returns `{ manifest: null, emissions: [] }` when **both** the normalized body is below 12,000 characters and the section count is below 24. It performs no content hashing, creates no markers and writes nothing. These are conservative local heuristics, not calibrated platform limits. Ordinary Router recommendations bypass planning altogether. An explicit long explain/report request can use `prepareRoutingExplanation({ recommendation, extended: true, sections })`; it still needs to reach a length/section threshold. A short expanded explanation also has no manifest.

Long output is packed in original section order, at most 12 sections per Part and a 6,000-character heuristic budget per Part by default. Actual segment-marker characters and separators are counted; 512 further characters are reserved for framing and the final marker. Counts use JavaScript string length after CRLF → LF normalization, **not** host tokens, bytes, quota or measured usage. Callers may supply explicit local budget overrides. No tokenizer, model, network, watcher or estimation service is called. The budget cannot guarantee that a platform will display a message intact.

One Segment is one supplied semantic section, nested within a Part. A single section too large for the available budget is preserved and marked `oversize=true`. Before sending such a section, the author/host should supply smaller meaningful subsections and form a new plan; the helper never cuts a paragraph, code block or other semantic unit at an arbitrary character. It also does not send output by itself.

## Formal manifest boundary

`validateDeliveryManifest` rejects missing/unknown fields, unknown versions, invalid budgets, duplicate identities, altered digests and inconsistent boundaries. Validate before consuming automatic recovery or approval scopes.

| Field | Contract |
|---|---|
| contract / version | `DeliveryManifestV1` / `1` |
| artifact_id / artifact_revision | Stable ASCII ID / positive integer; independent from Packet versions |
| artifact_kind | spec, prd, architecture_review, product_brief, execution_plan, router_explanation |
| policy | heuristic=`characters_and_sections`, long_chars, long_sections, max_chars, max_sections, reserve_chars |
| parts | Ordered nonempty `{ id, sha256, segments }` records |
| segments | Ordered `{ id, section_id, sha256, chars, oversize }` records; IDs globally unique |
| digest | Canonical SHA-256 of the complete plan body, excluding digest/marker |
| completion_marker | Exact `ARTIFACT COMPLETE <artifact_id>@<artifact_revision> <digest>` |

The existing `resultDigest` canonical hashing utility is reused. Segment SHA-256 is over the canonical JSON string of normalized text. Only line endings are normalized; wording, whitespace, section order and identity remain significant. Part SHA-256 covers its ordered segment metadata, which includes each content digest. Manifest SHA-256 binds identity, revision, kind, policy and the ordered Parts. The manifest contains no full visible body. `planDelivery` returns separate `emissions` with text and exact Segment markers for the host to send.

The manifest's expected marker is a template, **not** evidence that it has been emitted or received. Digests prove consistency with supplied evidence, not authorship, semantic completeness or user consent.

## Observations and completeness

Pass chronological observations to `inspectDelivery(manifest, events)`. Every event carries `kind`, `artifact_id`, `artifact_revision`, `manifest_digest`, `source`, and a real `evidence_ref`. The caller verifies source trust, chronology and the actual content; strings naming a source do not authenticate it.

| kind | Additional fields / allowed source |
|---|---|
| delivered | part_id, segment_id, section_id, content, sha256, exact Segment marker; emission / host / user |
| confirmed | Same content fields; host / user only, after independent readable-content verification |
| truncated | part_id, segment_id (first affected Segment, or null if its boundary is unknown); host / user only |
| completion | exact observed marker; emission / host / user |

Each Segment marker is `SEGMENT COMPLETE <artifact_id>@<artifact_revision> <part_id>/<segment_id> <content_sha256>`. A matching digest without its Segment marker is insufficient. Invalid receipt bytes, bindings or sources fail closed. Do not turn partial text into a valid whole-Segment receipt; keep it unconfirmed and report the affected boundary.

`planned` means no delivery observation. `delivered` means actual matching content and marker were emitted/read according to the supplied evidence. `confirmed` requires independent host/user receipt evidence. A normal response ending or a model's statement “I sent everything” establishes none of these by itself. The `emission` source must represent a real recorded emission of the matching content/marker, not the intention to send it.

A Part is complete when every expected Segment has matching delivery evidence and its exact Segment marker. The whole artifact has `complete=true` only when **all** Parts are complete and the exact final marker was observed after those deliveries. An early marker is not credited retroactively. Missing Parts give `incomplete`; all bodies present with no valid final marker give `unknown` and `complete=false`.

Local emission evidence plus exact markers can establish local output completeness without host confirmation. In that case **UI visibility remains `unknown`**. Independent confirmations of all Segments give visibility=`confirmed`. There is no API for reading UI truncation state. The module cannot prove what an unobserved UI displayed and does not pretend that it can. Completion is a delivery fact, not project COMPLETE or content acceptance.

A trusted truncation report marks the specified Segment and the remainder of its Part `incomplete`, invalidates the previously observed artifact marker and keeps earlier confirmed boundaries. If the section is unknown, the affected Part is conservatively invalidated from its first Segment. Later independently received Parts remain intact. New emission/confirmation evidence and a fresh final-marker observation are needed after recovery. Exact duplicate observations are idempotent; replaying an old receipt after a report cannot resurrect invalidated delivery. Reusing an evidence reference for conflicting events is rejected.

## Resume and approval

`resumeDelivery(manifest, events, { from_part_id? })` returns the first missing/invalidated `{ part_id, segment_id, section_id }` and only the pending Segments in plan order. Already delivered/confirmed segments, including later received Parts, are omitted. Delivered but unconfirmed Segments are listed separately in `unconfirmed_segments`: when visibility is unknown, the host should seek receipt verification instead of assuming unseen text is accepted. If no body is missing and only the final marker is absent, emit/check that marker only. An explicit requested Part cannot skip an earlier gap. Do not repeat external actions described in any recovered text.

Natural language such as “继续”, “被截断了”, or “从 Part 3 继续” is interpreted by Chat/the host into these existing helpers. For “last visible §61”, establish whether §61 was complete: if confirmed through §60, resume at §61; if §61 and its marker were confirmed, resume at §62. With no reliable section evidence, resume the affected Part and request confirmation. There is no `/delivery` or new shell command. Explicit requests to resend already confirmed text may select original `emissions` in the host; content revision instead needs a new artifact revision, hashes and approvals.

`approveDelivery` requires an exact artifact/revision/digest and explicit nonempty `part_ids`, plus the existing trustworthy user-instruction/delegation source and approval reference. An ambiguous “可以” without a uniquely identified visible scope is rejected as `ambiguous_scope`. Only fully delivered, independently confirmed Parts are eligible. Parts 1/2 may be content-approved while 3/4 are absent; the scope records only their IDs and digests. It never creates Packet approval, side-effect permission or ACCEPT Review.

Before reuse, `validateDeliveryApproval` rechecks content bindings and current receipt validity. Changed content, plan or revision invalidates old scopes conservatively, even if some sections remain unchanged. A truncation report also invalidates scopes covering that Part. Unaffected Parts in the unchanged plan can retain their approvals. Delivery confirmation ≠ content approval ≠ execution authorization; existing Packet/replan/reauthorize/preflight/side-effect/Review gates remain authoritative.

## Workshop, persistence and failure isolation

`createProductBrief` returns a delivery plan on long output. Its actual authored sections (including titles, introduction, decisions with existing trusted references, and footer) are bound; the draft/ready presentation comment stays outside their digest so receipt verification cannot change the body. Long Briefs require a manifest matching the **current** text, whole-artifact completion and independently confirmed visibility before status=`ready` / `decision_ready=true`. The legacy boolean `deliveryComplete` cannot bypass this check. An incomplete or corrupt long transfer stays `draft`; recommendations from that draft must not be promoted into newly confirmed decisions. Independently approved historical decisions may still be quoted with their original references. Even a ready Brief grants no authorization. Short Briefs keep the existing host-established `deliveryComplete` path and require no manifest.

Ordinary same-session long delivery stays in memory. Only real long-transfer recovery or cross-session handoff warrants saving the current manifest, necessary receipt/source references and the actual artifact at the existing explicitly chosen handoff location. The host owns explicit saving and permission/path/atomicity checks; there is no guessed root, automatic write, database, journal or telemetry service. A JSON round trip preserves the protocol. To avoid duplicating text in durable receipts, the host may store content references and reconstruct `event.content` from the actual artifact when consuming the records; it must read/verify those bytes before claiming receipt consistency. Persisting receipt metadata alone is not enough to resume without the artifact.

Old schema-2 states without a manifest remain legal. The extension is never inserted into ProjectState or Packet. `inspectDelivery` returns `delivery_manifest_missing` / `delivery_recovery_unavailable` for missing/damaged delivery data; `resumeDelivery` requests `rebuild_delivery_plan`. It never labels ProjectState corrupted, changes migration or rolls back execution. Rebuild from actual artifact and trustworthy receipts; without them, report recovery unavailable instead of guessing approved boundaries. Existing Result/side-effect evidence governs execution recovery independently.

## Incident abstraction and verification

`tests/fixtures/delivery-incident.json` records an abstraction of the reported four-Part Architecture Spec incident, not the original document or a live UI observation. `tests/delivery-manifest.test.mjs` reconstructs 160 identified sections, 40 per Part. Confirmed §1–60 resumes at Part 2 / §61 with 100 missing Segments; no Part 1 is replayed. A later report at §61 after other Parts were received invalidates only §61–80 and the final marker. Accepted Parts 1/2 plus absent Part 3 cannot approve Part 4, and a subsequent ambiguous approval cannot extend the scope.

Tests A–M, strict-contract failures, actual marker budgeting, evidence replay, threshold boundaries and JSON recovery are included in the existing unified `node scripts/verify.mjs` entrypoint. M1 Spike is still verified separately. These are local protocol tests; they do not prove real UI truncation detection, platform token budgets, live transport behavior or concurrent durable-host writes.
