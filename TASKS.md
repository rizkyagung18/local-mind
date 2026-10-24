# LocalMind — Ordered Implementation Tasks

Version: 1.0 · Date: 2026-10-24 · Status: M0 complete; T07 chat management and T08 pure context assembly implemented with focused checks passing. T09 is next and has not started; generation wiring and streaming chat remain pending.

Read [PRD.md](./PRD.md), then [ARCHITECTURE.md](./ARCHITECTURE.md), before changing code. This file is the execution order for Codex or Claude Code. Verified implementation status is recorded in docs/progress.md. Checkboxes distinguish completed setup from remaining application work.

## 1. Execution rules

1. Implement M0 and M1 first. Stop feature expansion at the M1 release gate. Attachments, RAG, embeddings, and media are later milestones, even though both installed models advertise vision/tools capabilities.
2. Follow the numbered order and explicit dependencies. Do not mark a task complete until its deliverables and verification pass. A later task may reuse earlier tests rather than duplicating them.
3. Keep the stack fixed: React/Vite/TypeScript/Tailwind/shadcn/ui; Fastify; local SQLite/Drizzle; native Ollama. No hosted database, remote provider, Docker prerequisite, or extra agent framework.
4. Inspect existing files and applicable repository instructions before editing. Preserve unrelated work. If a contract must change, update PRD, ARCHITECTURE, contracts, tests, and affected task acceptance together.
5. Models are already installed on the observed Mac. Recheck actual inventory rather than pulling them. Do not download a replacement, select a bigger alias, change model weights, or start a cloud service to get a test passing.
6. Tests use synthetic text/files and temporary storage. Never include real prompts, answers, photos, documents, tokens, or raw model templates in commits, logs, fixtures, or reports.
7. Keep user data in the private application-support directory, not beside these documents. `.gitignore` is supplementary protection, not a reason to put a database in the repository.
8. Keep changes small enough to review. Record tested versions, failures, resolved deviations, and evidence. Do not claim a benchmark from estimates or a passing mock.
9. Setup commands are available in package.json and README.md. Commands for later features, such as backup, remain future deliverables until their tasks pass.

## 2. Dependency and release map

| Phase | Tasks | Gate |
| --- | --- | --- |
| M0 — Foundation | T01–T06 | Builds locally, private storage/session work, installed model statuses are accurate |
| M1 — Text-chat MVP | T07–T17 | AC-01–AC-15; real-device validation and operator documentation |
| M2 — Attachments | T18–T23 | AC-16–AC-18 plus M1 regression gates |
| M3 — Retrieval | T24–T27 | AC-19 plus earlier gates |
| M4 — Audio/video | T28–T31 | AC-20 plus earlier gates |

Main dependency path: T01 → T02 → T03 → T04 → T05 → T06 → T07 → T08/T09 → T10 → T11 → T12 → T13/T14 → T15 → T16 → T17. Individual tasks below specify all required prerequisites. Slash-separated items represent branches that must both be completed before joining.

## 3. M0 — Foundation

### T01 — Create a reproducible native workspace

Depends on: none.

- [x] Inspect the current folder, installed Node/package manager, Ollama version, and architecture. Establish Git only if the implementation workspace is not already versioned; create no remote repository automatically.
- [x] Create `apps/web`, `apps/server`, and `packages/contracts` using pnpm workspaces and strict TypeScript. Pin a supported Node LTS, package manager, and mutually compatible stable dependencies.
- [x] Add React/Vite, Tailwind/shadcn components, Fastify, Drizzle, `better-sqlite3`, a schema/type solution, Vitest, and Playwright. Avoid prerelease dependencies unless a documented compatibility requirement makes them necessary.
- [x] Add root scripts `dev`, `build`, `start`, `typecheck`, `lint`, `test`, `test:integration`, `test:e2e`, and `doctor`. Ensure a production build runs without Vite or internet access.
- [x] Ignore dependency/build output, local environment files, SQLite/WAL/SHM, logs, backups, temporary media, and test artifacts. Do not create real application data in the checkout.

Deliverables: workspace manifests, lockfile, compiler/build settings, initial scripts, `.gitignore`, and `docs/compatibility.md` with actual versions. Verify the driver's embedded SQLite is ≥3.51.3 or a documented fixed backport, not just that the system CLI is patched.

Verification: clean dependency installation and typecheck/build pass on Apple Silicon; `doctor` reports safe metadata without printing private environment values. Dependency installation may use the network; app runtime must not require it.

### T02 — Encode contracts, constants, and state machines

Depends on: T01.

- [x] Implement the exact M1 DTOs, error-code union, profile IDs, run statuses, broker states, limits, and SSE event union from ARCHITECTURE.
- [x] Define application-owned schemas with explicit response shapes and strict unknown-field rejection. Define request normalization/fingerprint behavior without rewriting user content.
- [x] Validate trusted configuration: fixed local host/provider, data directory, only 4,096 or 2,048 context, 512-token output, and all byte/time limits.
- [x] Write a short transition table in code/docs for run state, assistant state, and broker cleanup. Keep `cancelRequested` distinct from terminal status.

Deliverables: `packages/contracts`, server config module, contract fixtures.

Verification: schema tests reject raw model/URL/tool/role injection, unknown fields, invalid IDs, overlarge content, unsafe host config, and illegal state transitions. Tests confirm sample contracts and constants are compatible with all three planning documents.

Verified 2026-10-23: 61 focused tests passed on the first run using `pnpm exec vitest run --project unit packages/contracts/src/contracts.test.ts apps/server/src/config/config.test.ts`. No full-suite, build, lint, or typecheck rerun was performed for T02. Physical storage validation remains T03; runtime wiring remains T04 and subsequent service tasks.

### T03 — Build private storage and transactional schema

Depends on: T01, T02.

- [x] Create validated owner-only storage under `~/Library/Application Support/LocalMind/`, with `umask 077`, 0700 directories, and 0600 files. Reject symlink/path/ownership hazards and known synced/repository locations.
- [x] Implement the single-instance data-directory lock and one database connection. Enable the documented WAL, synchronous, FK, and busy settings.
- [x] Create Drizzle migrations for `model_profiles`, `chats`, `messages`, and `runs`, with all FK, uniqueness, status, and sequence constraints.
- [x] Add the partial unique index enforcing one active run. Seed exactly the two permanent profile records, without a model download or prewarm.
- [x] Add repository methods that perform atomic turn insertion, bounded partial checkpoints, terminal compare-and-set updates, and chat deletion. Keep network work out of transactions.

Deliverables: schema, committed migrations, repositories, storage/lock helpers.

Verification: use real temporary SQLite databases to test migration, rollback, FK enforcement, role/chat pairing, active-run uniqueness, duplicate keys, two-process lock rejection, restrictive sidecar permissions, unsafe paths, and storage failures. Existing data is never discarded on a migration or integrity error. Covers the persistence foundation of AC-06, AC-08, AC-13, and AC-14.

Verified 2026-10-23: `pnpm exec vitest run --project integration apps/server/tests/integration/storage.test.ts` passed 22 tests after one repair attempt (corrected Drizzle descending-index declarations). Tests use real isolated SQLite files, child processes, and injected write failures; no real disk exhaustion or user data was involved. No full suite, build, lint, or typecheck was run. Server startup/routes and interrupted-run/runtime reconciliation remain later tasks.

### T04 — Implement the loopback server and local session guard

Depends on: T01, T02, T03.

- [x] Create an injectable Fastify app factory and separate production listener bound to `127.0.0.1:3210`.
- [x] Add exact Host/Origin/fetch-metadata checks, no proxy trust, no permissive CORS, and the same-origin bootstrap route.
- [x] Require the in-memory session token on all other API reads and mutations. Redact it from logs; do not persist it or put it in URLs.
- [x] Serve production assets with the specified headers/CSP. Set API responses to no-store and enforce body limits before expensive work.
- [x] Add safe structured errors, content-free bounded logs, and the authenticated health contract.

Deliverables: security/lifecycle plugins, session/health routes, static serving and headers.

Verification: real HTTP tests reject foreign/null Origin, forged Host, missing/wrong tokens, forms, cross-origin preflights, and permissive development settings in production. Bootstrap only succeeds through the intended flow. Confirm listen sockets are loopback-only. Covers AC-11 and AC-13.

Verified 2026-10-23: `pnpm exec vitest run --project integration apps/server/tests/integration/server-security.test.ts` passed 25 tests after one repair attempt (test imports now use the contracts package's exported validator). Tests used real loopback sockets on temporary ports, temporary private databases, synthetic static assets, and bounded log files. No full suite, build, lint, typecheck, or existing tests were run. The top-level logging-option warning observed during T04 was subsequently fixed and regression-tested in T05.

### T05 — Discover and bind installed model profiles

Depends on: T02, T03, T04.

- [x] Implement fixed-target Ollama transport with no redirects or inherited outbound proxy, finite response size, and discovery timeout.
- [x] Implement version/tags/show/ps adapters and the six availability states. Validate local GGUF metadata, artifact ceiling, completion, and explicit no-thinking compatibility.
- [x] Add `GET /models`, `POST /models/refresh`, and `PATCH /model-profiles/:id` exactly as specified, including profile version/digest checks.
- [x] Pin first eligible seed digests; require explicit binding for later digest changes/custom community mappings. Preserve mappings during outages.
- [x] Reject remote-backed, missing, incompatible, too-large, and ambiguous models. Treat cloud-name filtering as one check, not the whole local-only policy.

Deliverables: provider metadata adapter, model registry, routes, sanitized synthetic fixtures, compatibility report entries.

Verification: inventory fixtures cover both tags, each missing separately, Ollama unavailable, changed digest, cleared mapping, unknown thinking metadata, remote metadata, incompatible capabilities, large models, redirects, and a delayed response. Read the actual installed models without loading them. Covers AC-01–AC-03 and AC-11.

Verified 2026-10-24: `pnpm exec vitest run --project integration apps/server/tests/integration/models.test.ts` passed 29 tests after one repair attempt. Fastify could not compile the existing tuple/intersection response schema; a route-local serializer now validates against the unchanged shared contract before JSON encoding. The logging deprecation is fixed with `LogController`. Only this new test file was run, twice; no full suite, build, lint, typecheck, or UI tests. Read-only local metadata inspection confirmed both expected GGUF models and explicit thinking-off support without loading models; see docs/compatibility.md.

### T06 — Build the accessible application shell

Depends on: T01, T02, T04, T05.

- [x] Create sidebar/transcript/composer regions, theme, responsive layout, and keyboard focus behavior using local assets.
- [x] Add session bootstrap and a typed API client. On expired token, bootstrap once and refetch; never automatically resend a generation.
- [x] Add model status/refresh/binding views with both profiles always visible and clear unavailable reasons.
- [x] Configure development Vite on `127.0.0.1:5173` with strict port/host checks and the API proxy. Keep the production origin at 3210.
- [x] Hide upload, retrieval, voice, and video actions until their milestone is implemented. Store only non-sensitive preferences such as theme in browser storage.

Deliverables: usable shell, status components, API client, development configuration.

Verification: keyboard and narrow-window smoke checks; inspect network requests for remote assets; official-missing and community-missing views are understandable. Confirm production contains no development-only security relaxation. M0 can now exit.

T06 verification on 2026-10-24: all 7 new API-client tests passed in the complete Vitest run; all 8 browser tests passed (6 new shell scenarios and 2 updated starter scenarios). The frontend production build passed after fixing the binding payload's nullable union. Vite already had the required loopback host, strict port, host allowlist, disabled CORS, and same-origin API proxy; its configuration was not changed.

Original T06 full-suite result: `pnpm test`, `pnpm test:integration`, and `pnpm test:e2e` each stopped in the existing contracts build, which lacked required Node/Web API types. Running `pnpm exec vitest run` directly executed all unit/integration tests: **155 passed, 1 failed**. The failure was the older T04 health expectation (`not_checked` versus T05's `reachable`) in `apps/server/tests/integration/server-security.test.ts`. `pnpm --filter @localmind/web build` and `pnpm exec playwright test` passed. The contracts configuration and old server test were outside that turn's scope.

M0 blocker follow-up on 2026-10-24: explicit Node types repair contracts compilation; lifecycle tests now inject synthetic provider metadata, assert startup discovery, and cover degraded startup plus storage release during provider outage. `pnpm test` passed **78 tests** and `pnpm test:integration` passed **79 tests**, on the first attempt. `pnpm test:e2e` passed contracts/frontend builds but stopped before browser tests at existing server errors: `String.isWellFormed` is absent from the configured ES2023 library (`src/db/repository.ts:29`), and model-route serializer types do not match Fastify's route schema type (`src/routes/models.ts:10–11`). These newly exposed files were left unchanged; no repair retries were used. M0 remained blocked at that point; T07 had not started.

Browser tests use temporary storage, synthetic provider metadata, built frontend assets, and the source server through tsx. The test-only loopback port 43210 maps its exact Host/Origin headers to the canonical origin, leaving the existing listener on 3210 and production security configuration untouched. Two repairs were made: the T06 binding type fix and isolated test-port configuration after a listener conflict. No test failure was retried beyond the requested limit.

M0 build-blocker resolution on 2026-10-24: the server compiler now includes `ES2024.String`, matching the pinned Node runtime without changing repository validation. The model serializer accepts Fastify's unknown schema input, explicitly allows the registered inventory/error schemas, and still validates before encoding. Four new regression cases cover both model endpoints rejecting invalid response data and both lone-surrogate forms being rejected before run mutation. `pnpm test` passed **78**, `pnpm test:integration` passed **83**, and `pnpm test:e2e` passed the complete production build plus **8 browser tests**. All passed on the first attempt; no repair retries were needed. The reported M0 blockers are resolved. Lint and whole-repository typecheck were not rerun; no M1 or inference verification is claimed.

## 4. M1 — Streaming text-chat MVP

### T07 — Implement persistent chat management

Depends on: T03, T04, T06.

- [x] Add create/list/get/rename/delete chat routes, message pagination, expected-version enforcement, and the corresponding UI.
- [x] Use stable sequence ordering and bounded history queries. Support latest-page loading and older-message pagination.
- [x] Derive the first title from user text locally while preserving manually edited titles.
- [x] Guard active chats against rename/switch/delete and make all deletion consequences visible before the user confirms deletion.

Deliverables: chat services/routes, sidebar management, empty/error/history states.

Verification: create/rename/delete/reopen/restart tests, pagination ties, stale versions, cascade integrity, manual-title preservation, and absence of model calls for titles. Covers AC-06 and part of AC-08.

T07 verification on 2026-10-24: `pnpm exec vitest run --project unit apps/web/src/lib/chats-api.test.ts` passed **7 tests**; `pnpm exec vitest run --project integration apps/server/tests/integration/chats.test.ts` passed **15 tests**; `pnpm --filter @localmind/web build` passed; `pnpm exec playwright test tests/e2e/chats.spec.ts` passed **4 tests** after two test-only repairs. The first repair waits for server-confirmed profile selection instead of requiring an immediate radio change; the second distinguishes the create button from a saved chat named “New chat”. No further repair attempts or test runs followed the passing results.

Coverage includes SQLite/server restart persistence, chat ordering ties and bounded message pages, historical provenance, locally derived/manual titles, version and profile-binding races, persisted/cleanup activity guards, atomic cascades, safe errors/authentication, client session non-replay, UI reload/reopen/delete confirmation, conflict retry, plain-text history, keyboard dialogs, and narrow layout. Tests use synthetic metadata and temporary databases; no model inference is performed. Browser history/activity cases use synthetic response fixtures; restart persistence is covered by the integration test. Existing tests, migrations, shared schemas, repository, lifecycle, and browser harness/configuration were preserved. No full suite, backend build, lint, or whole-repository typecheck ran. T08 remains unstarted; the composer is disabled.

### T08 — Implement conservative context assembly

Depends on: T02, T05, T07.

- [x] Version the fixed server system prompt and construct structured roles exclusively on the backend.
- [x] Implement byte-plus-role-overhead input estimates, system/current-message reservation, whole-pair history selection, and omitted-message counts.
- [x] Exclude pairs whose runs are failed/cancelled/interrupted. Preserve stored history unchanged.
- [x] Reject a current message that cannot fit before creating a run. Support only the documented 4,096/2,048 context choices.

Deliverables: pure context-builder service and multilingual/synthetic fixtures.

Verification: exact budget boundaries, long history, emoji/CJK/Indonesian/code, missing pairs, prior partial answers, no cross-chat input, and no automatic summarization. Covers AC-09 and the input-authority portion of AC-12.

T08 verification on 2026-10-24: `pnpm exec vitest run --project unit apps/server/src/services/context.test.ts` passed **52 tests on the first run**. No repair attempts were needed. Coverage includes the fixed prompt/version, both exact budget boundaries, multilingual UTF-8 estimates, role authority, newest eligible-pair suffix selection, long histories, omission counts, missing pairs, non-completed runs, length-limited completed answers, immutable inputs, both profiles, cross-chat/duplicate/contradictory metadata, and malformed Unicode. Only this new test file ran; no full suite, build, lint, typecheck, or live model checks were performed.

The pure builder reuses T02 limits/schemas and accepts stored message/run DTOs compatible with T07; T05 eligibility remains the later caller's responsibility. No changes to those dependencies were required. Rejection occurs within the pure builder; later generation orchestration must call it before repository acceptance and pass complete history/run metadata. No route or generation wiring is added in T08. T09 is next and has not started.

### T09 — Implement bounded Ollama streaming

Depends on: T02, T05.

- [ ] Add `/api/chat` request construction with exact tag, structured messages, fixed options, no tools, `stream:true`, and supported `think:false`.
- [ ] Implement streaming UTF-8/NDJSON parsing, line limits, provider error mapping, final `done:true` verification, and metric normalization.
- [ ] Discard thinking fields; reject unexpected tool-call output. Implement first-object, idle, overall timeout signals and AbortController support.
- [ ] Add explicit owned-model unload and residency checks using the pinned Ollama API; do not download or prewarm a model.

Deliverables: inference adapter and deterministic fake-provider fixtures/server.

Verification: split every representative multibyte/line boundary, multiple objects per read, CRLF, no final newline, malformed JSON, oversize lines/output, upstream error, thinking-only output, premature EOF, and abort. Covers AC-04 and AC-14. Do not run a large model to manufacture memory pressure.

### T10 — Implement the generation broker and persistence lifecycle

Depends on: T03, T08, T09.

- [ ] Implement one global generation slot and explicit idle/running/draining/blocked states with no queue.
- [ ] Check idempotency before busy/version rejection, then recheck transactionally at acceptance. Store request fingerprints and immutable model/options/context provenance.
- [ ] Atomically persist the two messages and preparing run before exposing acceptance. Apply version/sequence/title rules.
- [ ] Stream into a bounded buffer, checkpoint at the specified cadence, and commit final state before success.
- [ ] Implement terminal races, cancellation, unload-before-switch, five-second cleanup, unresolved-runtime blocking, and storage-failure blocking. Never infer that socket abort alone stopped the model.

Deliverables: generation service and broker wired to repositories/provider.

Verification: simultaneous two-chat attempts accept exactly one; repeated keys create no extra messages; changed payload conflicts; stop/completion race has one terminal state; persistence failure cannot produce success; unrelated resident models are not killed. Covers AC-03, AC-05, AC-08, and AC-14.

### T11 — Expose streaming, cancellation, and recovery routes

Depends on: T04, T07, T10.

- [ ] Add POST turns with SSE framing, accepted/status/delta/done/error events, heartbeat comments, no compression, and bounded write backpressure.
- [ ] Add GET run, POST cancel, and POST runtime recovery. Keep terminal states idempotent and error envelopes stable.
- [ ] Detect genuine response/socket disconnects without treating a completed request-body read as cancellation.
- [ ] Return preflight failures before SSE and before persistence. After headers, use terminal events; after transport loss, rely on stored state.

Deliverables: routes and a real HTTP streaming test harness.

Verification: incremental delivery occurs before completion; cancel and disconnect abort upstream; incomplete SSE cannot be mistaken for success; stalled consumers are bounded; duplicate request returns existing IDs; runtime recovery cannot kill unrelated processes. Fastify's in-process injection alone is insufficient here. Covers AC-04, AC-05, AC-07, AC-08, and AC-14.

### T12 — Finish the text-chat UI and stream reconciliation

Depends on: T06, T07, T11.

- [ ] Add composer send/Stop behavior, request keys, expected versions, streaming text reducer, final refresh, and retry-as-new-send behavior.
- [ ] On Stop, request cancellation before aborting the browser reader. On refresh/disconnect, reconcile saved state; never replay/reconnect a generation automatically.
- [ ] Render safe Markdown/code, with raw HTML and images disabled. Make external navigation deliberate with no prefetch.
- [ ] Add preparing/generating/stopped/failed/interrupted/limit-reached and context-omission states. Display assistant model provenance.
- [ ] Implement IME-safe Enter handling, copy action, accessible status announcements, focus, and user-controlled scrolling.

Deliverables: fully usable General streaming chat UI.

Verification: browser tests cover incremental Unicode, Stop, refresh during generation, restart, off-bottom scrolling, keyboard/IME, expired session, malicious Markdown, remote-image payloads, and no content/token persistence in browser storage. Covers AC-04–AC-07, AC-09, AC-12, and AC-15.

### T13 — Complete explicit mode switching and missing-model UX

Depends on: T05, T10, T12.

- [ ] Connect the per-chat selector to versioned chat updates. Disable changing it during an active run and explain that a new chat separates history.
- [ ] Make community mapping explicit, show its exact installed tag, and surface digest changes without overwriting history snapshots.
- [ ] Show missing/unsupported/unreachable states without fallback. A missing profile must not break the other one or prevent opening old chats.
- [ ] Display model unloading/loading status on the next send and allow Stop while preparing.

Deliverables: two working modes and complete absence/change handling.

Verification: both actual installed tags generate at least one text response, with correct persisted provenance; synthetic missing-model cases pass independently; a cross-tab stale switch fails cleanly; no two LocalMind models remain resident after a switch. Covers AC-01–AC-03 and AC-08.

### T14 — Complete restart, backup, deletion, and storage recovery

Depends on: T03, T10, T11, T12.

- [ ] Add startup reconciliation of unfinished runs and previous owned runtime, without resuming generation.
- [ ] Handle graceful shutdown, hard process termination, locked/corrupt/full database, and checkpoint errors without overwriting user data.
- [ ] Add the stopped-app `pnpm backup` helper using the driver API and the shared data-directory lock, plus stopped-app restore validation. Keep sensitive copies owner-only.
- [ ] Finish delete-chat UX and accurate storage/encryption/deletion explanations. Ensure logs do not contain prompts, answers, paths, or session tokens.

Deliverables: recovery lifecycle, backup helper/procedure, storage-related user messages.

Verification: kill/restart during a stream, compare surviving checkpoint prefix, test terminal-state reconciliation, back up a recoverable uncheckpointed-WAL fixture, restore and run integrity checks, enforce lock ownership, and inject full-disk/persistence failures. Covers AC-06, AC-07, AC-13, and AC-14.

### T15 — Run adversarial and offline integration checks

Depends on: T07, T08, T09, T10, T11, T12, T13, T14.

- [ ] Add automated security regressions for Host/Origin/rebinding attempts, forms, token-less reads, arbitrary URLs, cloud aliases/metadata, redirects, unsafe rendering, and model-generated instructions/tool calls.
- [ ] Test two-tab concurrency, duplicate request conflicts, model removal/change between discovery and dispatch, malformed/slow/truncated streams, and downstream backpressure.
- [ ] Run the production build with non-loopback outbound access denied. Inspect browser requests and application/provider connections; test both profiles and saved history.
- [ ] Verify storage permissions, sidecars, log rotation/redaction, no remote assets/service worker, and no sensitive browser/repository persistence.
- [ ] Start `docs/validation-m1.md`, mapping every AC-01–AC-14 to automated or manual evidence with exact commands and results. Record limitations honestly.

Deliverables: security/integration/browser regression suite and validation evidence.

Verification: all correctness/privacy gates pass; there is no automatic fallback/download even when tests intentionally remove a model or block internet access. This is required release work, not an optional later security pass.

### T16 — Measure and tune the actual M1 experience

Depends on: T13, T14, T15.

- [ ] Run ARCHITECTURE's benchmark protocol on the M1 8 GB Mac using the production build, both exact installed tags/digests, one cold run and ten warm runs per profile, plus the ten-minute sustained workload.
- [ ] Record first visible answer latency, actual generated tokens/duration, model loading time, browser/backend memory, model residency, memory pressure, swap change, and cancellation responsiveness.
- [ ] Compare results to PRD targets. Investigate slow UI or memory pressure before increasing context/model size. Evaluate the defined 2,048-context mode if needed; document any change to defaults consistently.
- [ ] Complete keyboard/IME/accessibility and low-memory/error-state checks. Avoid adding visual features or background workloads that undermine the device budget.

Deliverables: completed performance/accessibility section of `docs/validation-m1.md`, with reproducible workload and actual observations.

Verification: AC-15 has evidence; no out-of-memory failures or unresolved cancellation/cleanup issues. A performance target miss is recorded and resolved through tuning or an explicit documented budget revision, not hidden by relabeling estimates as measurements. Re-run only checks affected by tuning.

### T17 — Package and release the MVP locally

Depends on: T16.

- [ ] Write `docs/SETUP.md` with tested install/start/stop commands, production URL, prerequisite downloads, exact default models, profile binding, and missing-model recovery.
- [ ] Document Ollama local-only/loopback/single-model settings and how they apply to the actual Ollama process. Preserve unrelated settings; never imply Fastify environment changes reconfigure an existing service.
- [ ] Include data location, plaintext/FileVault explanation, backups/restore, deletion limits, logs, interrupted runs, runtime-blocked recovery, and port conflicts.
- [ ] Run clean-checkout build/start, final typecheck/lint/test/integration/e2e checks, then an offline smoke test with the installed artifacts.
- [ ] Verify the acceptance matrix is complete, all known release-blocking defects are resolved, and the interface contains no nonfunctional future-feature controls.

Deliverables: runnable local MVP, operator guide, lockfile, migrations, validation report, and a concise release note with actual limitations.

Gate: PRD AC-01–AC-15 pass. **MVP is complete here. Do not start T18 as part of an MVP-only implementation request.**

## 5. M2 — Local files, documents, and photos

### T18 — Add bounded attachment admission and quarantine

Depends on: T17.

- [ ] Add attachment/job/association/cleanup-outbox migrations and strict M2 contracts without changing existing M1 behavior.
- [ ] Implement authenticated, streaming multipart upload, exact allowlisted types, opaque storage keys, owner-only quarantine, and metadata lookup.
- [ ] Enforce all byte/pixel/selection/chat/application quotas from ARCHITECTURE, including reservations and cleanup on failed uploads.
- [ ] Reject remote URLs, traversal, symlinks, MIME deception, unsupported formats, oversized files, and macro-enabled Office content.

Deliverables: upload/storage routes, safe metadata UI, quota accounting.

Verification: admission/path/quota/rollback fixtures, MIME mismatch, boundary-size uploads, and interrupted upload cleanup. No uploads execute or fetch anything. Starts AC-16 and AC-18.

### T19 — Add safe text and document extraction

Depends on: T18.

- [ ] Choose and pin local TXT/Markdown/PDF/DOCX parsers. Record their security/resource behavior and disable remote relationships/resources.
- [ ] Implement the bounded worker lifecycle, 30-second extraction deadline, memory controls, PDF page/text bounds, and DOCX archive-entry/ratio/decompressed-size limits.
- [ ] Produce extracted text with stable page/character spans and a bounded source preview. Scanned PDFs fail with an explicit OCR-unavailable message.
- [ ] Treat extracted instructions as data; never execute macros/scripts/embedded objects or elevate source content into system instructions.

Deliverables: parser workers, source-span format, extraction states, safe preview UI.

Verification: normal documents, multilingual text, malicious prompt instructions, external relationships, zip bombs, parser crashes/timeouts, no-text PDFs, and worker restart. Finish document portions of AC-16; no OCR dependency is required for the initial M2 release.

### T20 — Add bounded local photo handling

Depends on: T18, T19.

- [ ] Validate image dimensions before expensive decoding; re-encode a ≤1,024-pixel derivative with EXIF removed, preserving the private original.
- [ ] Add authenticated binary fetch and short-lived Blob previews with correct revocation. Never publish a static file directory or token-bearing URL.
- [ ] Verify vision support for the bound model and exercise the native Ollama image-input path with a synthetic local image.
- [ ] Measure image prompt overhead and memory on the target device; define a conservative per-model image reserve inside the existing context window. Reject unmeasured/unsupported model-image combinations.

Deliverables: image processor, preview route/UI, capability check, measured vision budget.

Verification: malformed/huge images, EXIF/GPS removal from derivatives, one-photo limit, text-only model rejection, offline inference, and memory bounds. Covers AC-17.

### T21 — Integrate selected attachments into turns

Depends on: T19, T20.

- [ ] Extend turn input and fingerprints with attachment IDs and excerpt ranges. Validate same-chat ownership, ready state, count/total size, and active-run retention.
- [ ] Add document excerpt selection and show when only part of a document will be used. Keep the latest user input intact and apply shared context budgeting to all included material.
- [ ] Store included excerpt/source spans in message associations. Build delimited source blocks as untrusted user-level data; never insert them as system instructions.
- [ ] Pass only the selected bounded photo derivative to a verified vision model. Keep tools, network, and arbitrary file access disabled.

Deliverables: attachment composer controls and bounded multimodal/context integration.

Verification: exact selected sources enter the request; unrelated chats/files never enter; injection text cannot change model settings or access more data; oversize combinations reject before run acceptance; idempotency remains correct. Covers AC-16 and AC-17.

### T22 — Complete attachment retention, cleanup, and backup

Depends on: T18, T21.

- [ ] Implement tombstones and the transactional cleanup outbox. Prevent deleted files from being used immediately, and retry physical deletion safely.
- [ ] Delete originals, derivatives, extracted text, included source snapshots, and temporary files while retaining already generated conversation text until its chat is deleted.
- [ ] Reconcile interrupted extraction jobs and stale quarantine/temp files on startup; validate all cleanup paths under private storage.
- [ ] Extend backups to a coherent database-plus-files manifest; verify hashes and restore references without missing-file inconsistencies.

Deliverables: cleanup worker, expanded backup/restore, retention UI copy.

Verification: crash between DB tombstone and file removal, repeated cleanup, missing files, active-file deletion rejection, quota release, and full restore. Covers AC-18 and M2 extensions to AC-13.

### T23 — Release and validate attachments

Depends on: T22.

- [ ] Run AC-16–AC-18 and affected M1 regressions, plus offline/security/memory checks for each parser and the vision path.
- [ ] Record supported formats, caps, scanned-PDF limitations, source selection, deletion behavior, and real-device results in `docs/validation-m2.md` and the setup guide.
- [ ] If adding OCR, make it an explicit separately measured local-engine extension with installation/cancellation/cleanup tests; do not silently add a cloud OCR dependency.

Deliverables: bounded local document/photo release with passing evidence. M2 must remain useful without OCR.

Gate: AC-16–AC-18 and affected M1 regressions pass; resource and privacy evidence is recorded in the M2 report.

## 6. M3 — Local retrieval

### T24 — Implement selected collections and keyword retrieval

Depends on: T23.

- [ ] Add collection/membership/chunk schemas, parser-version/content-hash metadata, and FTS5 indexing for ready extracted sources.
- [ ] Cap the initial library at 2,000 chunks; preserve page/character spans and define deterministic bounded chunking.
- [ ] Add explicit collection selection, server-side scoping, top-four candidate retrieval, and final prompt-budget trimming.
- [ ] Exclude tombstoned/unready sources immediately; never retrieve from every chat by default.

Deliverables: collection management, keyword retrieval path, source selection contract.

Verification: cross-collection isolation, retrieval on synthetic known passages, long-result trimming, missing/deleted source exclusion, and no automatic embeddings/model acquisition. Starts AC-19.

### T25 — Add optional local embeddings under the shared budget

Depends on: T24.

- [ ] Select a small compatible local embedding model only at this milestone; document source/license, exact tag/digest, dimensions, installation size, and measured runtime costs.
- [ ] Add a missing-model state and explicit keyword-only fallback. Do not auto-install or call a cloud embedding endpoint.
- [ ] Persist normalized vector BLOBs with content/parser/model versioning and dimension checks. Start with bounded local similarity search; benchmark before adding a vector extension.
- [ ] Schedule embedding work through the shared single-model resource broker, unloading chat/embedding models between workloads.

Deliverables: optional local embedding path, index invalidation/rebuild, resource measurements.

Verification: different model dimensions/digests cannot mix, cancelled jobs recover, rebuilds invalidate stale data, embeddings and chat never overlap, and keyword retrieval still works with embeddings absent. Extends AC-19.

### T26 — Make citations and retrieval deletion reliable

Depends on: T24, T25.

- [ ] Snapshot included chunks/source spans per run and expose authenticated citation navigation.
- [ ] Validate citations against supplied source IDs; mark nonexistent citations as invalid. Do not fabricate references from model text.
- [ ] Extend deletion/outbox/backup handling to chunks, vectors, collection membership, and source snapshots.
- [ ] Add adversarial retrieved-document fixtures and ensure instructions in them cannot fetch URLs, read other files, or alter model/profile configuration.

Deliverables: trustworthy source navigation, deletion propagation, injection regression fixtures.

Verification: citations resolve to actual selected spans, removed sources disappear from retrieval, no cross-collection leakage occurs, and model instructions have no action channel. Completes AC-19 behavior.

### T27 — Validate and release retrieval

Depends on: T26.

- [ ] Run AC-19, relevant earlier regressions, offline retrieval tests, and sustained memory/latency measurements.
- [ ] Record retrieval quality on a small synthetic question/source set, including misses and unsupported answers; do not equate a cited answer with a verified fact.
- [ ] Publish `docs/validation-m3.md` and setup instructions for optional embedding installation, keyword-only use, collection scoping, and deletion/reindexing.

Deliverables: offline retrieval release with measured resource behavior and source integrity evidence.

Gate: AC-19 and affected earlier regressions pass, including deletion, collection isolation, and missing-embedding-model behavior.

## 7. M4 — Local audio and video

### T28 — Extend bounded workers for media

Depends on: T27.

- [ ] Verify and pin native local FFmpeg/ffprobe and whisper.cpp candidates, including model assets and licenses. Require explicit installation; no download during processing.
- [ ] Add the separate media-upload contract, media attachment/job types, duration/byte/codec checks, shared quota reservations, one-job scheduling, 10-minute processing deadlines, and persisted progress.
- [ ] Invoke fixed binaries with argument arrays and network protocols disabled. Isolate parser workers where supported and document remaining same-user process risks.
- [ ] Implement owned-process-group cancellation, restart recovery, and temporary-output caps/cleanup.

Deliverables: bounded media worker infrastructure and compatibility report.

Verification: command/path injection, URL input, bad codec/metadata, decompression limits, deadline/cancellation, missing binaries/models, and worker crash fixtures. Starts AC-20.

### T29 — Add local transcription

Depends on: T28.

- [ ] Enforce audio ≤10 minutes and 50 MiB, normalize locally, and transcribe with the measured small local model.
- [ ] Store timestamped transcript segments/source references and expose a text preview that can enter the existing bounded document/retrieval flow.
- [ ] Serialize transcription against chat/embedding model work. Keep speech synthesis and real-time voice calls out of scope.

Deliverables: upload-to-transcript flow with progress and cancellation.

Verification: synthetic speech and silence, multilingual sample limitations, duration/size boundaries, offline behavior, source timestamps, cancellation, and quota cleanup. Covers audio portions of AC-20.

### T30 — Add sampled local video analysis

Depends on: T28, T29.

- [ ] Enforce video ≤2 minutes and 100 MiB. Sample at most ten timestamped frames, resize to ≤1,024 pixels, and optionally use the locally extracted audio transcript.
- [ ] Process frames in bounded sequential jobs; do not submit all frames as an unmeasured giant vision prompt.
- [ ] Preserve evidence timestamps and make the UI clear that analysis uses sampled frames/transcript. Integrate only budgeted summaries/evidence into chat.
- [ ] Extend cancel/delete/backup behavior to all decoded derivatives, transcript segments, and frame files.

Deliverables: local video evidence workflow with explicit sampling limits.

Verification: bad codec/container, long/oversized video, timestamp consistency, max-frame/decoded-output limits, memory pressure, interrupted job, and full cleanup. Covers video portions of AC-20.

### T31 — Validate media and update the full operator guide

Depends on: T30.

- [ ] Run AC-20 and affected prior gates with outbound network denied, including Stop/cancel while each worker is active.
- [ ] Record actual transcription/video throughput, memory, temperature-related slowdown, limits, and unsupported formats in `docs/validation-m4.md`.
- [ ] Update installation, optional assets, source privacy, deletion, backup/restore, and failure recovery guidance. Preserve the lightweight text-chat path.

Deliverables: bounded offline media release with all milestone acceptance evidence.

Gate: AC-20 and affected earlier regressions pass; the guide and M4 report document the tested codecs, local assets, quotas, and cancellation behavior.

## 8. Acceptance coverage and handoff

| Acceptance IDs | Primary tasks |
| --- | --- |
| AC-01–AC-03 | T05, T10, T13, T15 |
| AC-04–AC-05 | T09–T12, T15 |
| AC-06–AC-08 | T03, T07, T10–T15 |
| AC-09 | T08, T12, T15 |
| AC-10–AC-12 | T04–T06, T08–T09, T12, T15, T17 |
| AC-13–AC-14 | T03–T05, T09–T11, T14–T15 |
| AC-15 | T06, T12, T16–T17 |
| AC-16–AC-18 | T18–T23 |
| AC-19 | T24–T27 |
| AC-20 | T28–T31 |

For a fresh coding session, use this instruction:

> Implement LocalMind M0 and M1 by following PRD.md, ARCHITECTURE.md, and TASKS.md in order. Start with the first incomplete task, inspect the current repository before changing it, and preserve unrelated work. Use the installed local Ollama models and never add cloud services, model downloads, attachments, RAG, or media to MVP. Complete the specified verification and record real results. Stop feature expansion at T17 and report remaining limitations honestly.

When finishing an implementation session, update task checkboxes only for verified work and record the next incomplete task, changed files, checks run, and any unresolved blocker in the implementation report. Documentation being complete does not mean application tasks or acceptance tests have passed.
