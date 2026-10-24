# LocalMind — Product Requirements

Version: 1.0 · Date: 2026-10-24 · Status: M0 complete; T07 persistent chats and T08 pure context assembly implemented. T08 passed 52 focused tests; T09 is next and has not started. Generation wiring and streaming chat MVP remain in development.

Read with [ARCHITECTURE.md](./ARCHITECTURE.md) for technical contracts and [TASKS.md](./TASKS.md) for ordered work. This file owns scope and acceptance criteria; ARCHITECTURE owns protocol and schema details; TASKS owns execution order. Change all affected documents together when changing a decision.

## 1. Product and starting point

LocalMind is a single-user, offline-first, ChatGPT-like browser application running on the user's Mac. It provides private conversations with locally installed Ollama models, saves conversations on the Mac, and later accepts user-selected local documents and photos. Audio, video, and retrieval over documents are subsequent milestones. No account, cloud provider, remote inference, analytics, or automatic model download is part of the product.

The primary device is a MacBook Air M1 with 8 GB unified memory. A small quantized model and modest context are deliberate constraints, not temporary defaults to remove as soon as the UI works.

The project is already present in the Work surface as the local **Local LLM** project. These three files are its implementation handoff. The preceding “Local LLM Setup” chat remains reference material; this handoff does not depend on reading that chat.

### Observed environment

Read-only checks on 2026-10-23 found Ollama 0.40.3 responding on `127.0.0.1:11434` and both models below installed. These are observations, not a runtime availability guarantee. No inference benchmark or configuration change was performed while writing these documents.

| Profile ID | UI label | Exact installed tag | Reported quantization | Local artifact size |
| --- | --- | --- | --- | --- |
| `general` | General · Official Qwen | `qwen3.5:2b-q4_K_M` | Q4_K_M | 1,945,781,358 bytes |
| `abliterated` | Abliterated · Community model | `huihui_ai/qwen3.5-abliterated:2B` | Q4_K_M | 1,945,323,683 bytes |

Both currently report completion, vision, tools, and thinking capabilities; both advertise `false` as an allowed thinking value. MVP enables text completion only. The installed models report different parameter-size metadata; do not assume the community model is behaviorally or structurally identical to the official model.

The explicit official quantization tag must remain the default. Do not silently substitute `qwen3.5:2b`, `latest`, or a larger model. The model library lists tags separately, and artifact size is not the runtime memory requirement. [Ollama model tags](https://ollama.com/library/qwen3.5/tags).

## 2. Goals and non-goals

### Goals

1. Start a local conversation, see an answer stream, and stop generation reliably.
2. Select either installed model profile and clearly see which model generated each answer.
3. Reopen saved conversations after a browser refresh or application restart.
4. Remain useful with the internet disconnected after dependencies and model files are installed.
5. Keep model inputs, outputs, and future attachments local through enforceable application boundaries.
6. Provide a clear path to local documents, photos, retrieval, and media processing without making them prerequisites for MVP.

### Explicit MVP exclusions

Uploads, image input, document extraction, OCR, RAG, embeddings, audio, video, web search, tool execution, shell access, agents, plugins, remote providers, LAN sharing, multi-user accounts, mobile access, synchronization, automatic downloads, fine-tuning, conversation branching, regeneration, message editing, custom system prompts, and application-managed encryption are excluded.

The interface should not expose nonfunctional upload or media controls. A simple roadmap view or explanatory settings text is acceptable; placeholder actions that appear usable are not.

## 3. User experience

The desktop layout has a conversation sidebar, a transcript, a model selector, and a composer. Include new chat, rename, delete, copy answer, connection status, and Stop. Use React, Vite, TypeScript, Tailwind CSS, and shadcn/ui with local assets and a system font stack. Support keyboard navigation, visible focus, a readable dark/light theme, and narrow browser windows.

Enter sends; Shift+Enter inserts a newline. Respect IME composition. Announce generation status accessibly without reading every streamed token. Keep the user's scroll position when they scroll away from the latest answer. Send and model switching are disabled while that chat has an active run; Stop remains usable. A second tab must not bypass the server's concurrency rules.

T06 provides the responsive shell, model settings, and theme selection. T07 adds saved-chat creation, reopening, renaming, deletion confirmation, persisted per-chat profile switching, and paginated plain-text history with assistant provenance. On reload, the newest chat opens; the sidebar allows reopening other chats. Chat selection remains in memory, while chat content and profile selection persist in SQLite. Active chats cannot be renamed, switched, or deleted. Messaging remains disabled and no upload/media controls are exposed. Only the non-sensitive appearance preference is persisted in browser storage.

### First launch

1. Open `http://127.0.0.1:3210` for the production build.
2. Inspect local Ollama availability and installed model metadata.
3. Show the official profile selected for a new chat. If unavailable, show the reason and allow explicit selection of the other ready profile.
4. Show both profile rows even if one is absent. An absent community model says “Not installed”; a discovered but unsupported model says “Incompatible.”
5. Allow an explicit community-profile mapping to a compatible installed model. Never guess from the word “uncensored,” change a user's mapping automatically, or download a model.

The two modes select different model weights. They are not a prompt trick or a global safety setting. “General” is not a guarantee of safe or correct answers; “Abliterated” is not a guarantee of unrestricted behavior, accuracy, or trustworthiness. Both modes have identical application permissions and privacy protections.

### Sending, stopping, and recovering

- Saving a submitted turn creates a user message and one associated assistant message. Stream answer text into that assistant message.
- Show “Preparing model” before output and “Generating” during output. Thinking traces are not displayed or stored in MVP.
- Stop preserves partial answer text and labels it “Stopped.” A refresh or disconnected stream cancels the run; it does not silently keep generating in the background.
- A server restart marks unfinished runs “Interrupted.” Previously completed messages survive. A hard crash may lose at most the latest uncheckpointed partial text under normal storage conditions.
- Failed, stopped, and interrupted answer pairs remain visible but are excluded from subsequent model context. The user can explicitly send their question again as a new turn; no automatic retry or duplicate user-message insertion occurs.
- Model changes affect the next turn only. Earlier answers retain their model label. Previous completed turns may enter the next model's context; switching does not isolate conversation history. Start a new chat for separation.
- If older turns no longer fit the context window, display a clear “Older messages omitted from this response” notice. Preserve them in storage. Never silently truncate the latest user message.

T08 now provides the pure backend context builder: a fixed versioned system prompt, conservative UTF-8 byte estimates, a full current message, and the newest contiguous suffix of eligible completed pairs. It never skips an oversized eligible pair to backfill older turns, changes stored history, summarizes, or calls a model. Non-completed and incomplete pairs are omitted; cross-chat or contradictory metadata is rejected. These policies passed 52 synthetic tests. The future generation caller must supply complete history/run metadata and invoke the builder before storing a turn; the composer remains disabled until later tasks connect generation.

## 4. Requirements

| ID | Priority | Requirement |
| --- | --- | --- |
| FR-01 | MVP | Detect Ollama, refresh installed models, distinguish ready/missing/incompatible/unreachable states, and show corrective instructions. |
| FR-02 | MVP | Provide the two named profiles, exact model mappings, digest-change detection, and explicit switching without fallback or downloads. |
| FR-03 | MVP | Create, list, rename, reopen, and delete chats with SQLite persistence. Derive an initial title locally from the first prompt; do not make a title-generation model call. |
| FR-04 | MVP | Stream answer text, support cancellation, expose failures, and preserve partial output and model provenance. |
| FR-05 | MVP | Enforce one global generation, fixed resource limits, context budgeting, optimistic concurrency, and duplicate-request protection. |
| FR-06 | MVP | Enforce local-only endpoints, local model eligibility, browser-request protections, safe rendering, and content-free operational logs. |
| FR-07 | MVP | Store private data outside the repository in an owner-only local directory; document encryption, backups, and deletion limits honestly. |
| FR-08 | MVP | Provide accessible loading, empty, offline, missing-model, busy, stopped, interrupted, and error states. |
| FR-09 | M2 | Accept bounded, explicitly selected local text documents, text PDFs, DOCX files, and photos; show extraction/processing state and useful limits. |
| FR-10 | M3 | Retrieve relevant local document passages with source citations, isolation by selected collection, and deletion propagation. |
| FR-11 | M4 | Add bounded local audio transcription and video frame/transcript processing through cancellable background jobs. |

## 5. Resource and performance budget

These are initial engineering limits and test targets, **not measured performance claims**. ARCHITECTURE is the authoritative definition of all constants.

| Item | Starting limit or target |
| --- | --- |
| Simultaneous generations | 1 across all chats and browser tabs; no waiting queue |
| Loaded models | LocalMind uses at most 1 at a time; unload its previous model before switching |
| Context | 4,096 total tokens; optional server-configured 2,048-token low-memory setting |
| Output | Maximum 512 generated tokens per turn |
| Prompt allocation | At 4,096 context: 3,072 estimated input tokens, 512 output, 512 safety reserve |
| Raw user text | 16 KiB UTF-8 maximum; it must also fit the smaller prompt budget |
| Thinking | Request `false` only when supported; reject incompatible profiles for MVP |
| Idle model residency | 2 minutes; no startup prewarming |
| Request deadlines | 5 seconds for discovery; 60 seconds to first upstream object; 30 seconds between objects; 180 seconds overall |
| Local UI | Send/Stop feedback under 100 ms; visible delta within 150 ms of backend receipt under normal load |
| Warm first answer text | Target median ≤5 seconds and p95 ≤15 seconds for the benchmark workload |
| Cold first answer text | Target ≤60 seconds, subject to storage, available memory, and model compatibility |
| Text generation planning range | Rough working estimate 10–30 tokens/second; measure both models before publishing results |
| Memory planning | Allow roughly 2.5–4 GiB for one runtime and its working memory; target backend + one production browser tab below 750 MiB |

The Mac's 8 GB is shared by CPU, GPU, macOS, and other apps. A roughly 1.95 GB model file does not imply 1.95 GB total inference memory. Model loading, context, image tensors, and concurrent apps add pressure. Fanless sustained workloads can slow down. Do not advertise the model's large theoretical context as practical on this device.

Run performance checks with the production build, native Apple Silicon dependencies, no Docker requirement, and no second inference client. Capture cold/warm timing, tokens/second, backend memory, model residency, Activity Monitor memory pressure, swap change, and a sustained ten-minute run. A healthy target is green memory pressure, no out-of-memory failures, and less than 512 MiB swap growth over that run. Missing a target requires investigation and a recorded budget/default adjustment before release, not fabricated benchmark claims. Correctness, privacy, and recovery gates cannot be waived by a performance result.

## 6. Privacy, security, and trust

### Local runtime boundary

LocalMind serves only loopback and calls only the fixed loopback Ollama service. It has no cloud integration or arbitrary URL fetcher. All fonts, scripts, icons, and code-highlighting assets are bundled. Chat rendering must not fetch external images, link previews, or embedded content. An external link requires a deliberate user action and a notice that it opens outside LocalMind.

Dependency installation, optional model installation, and Ollama's own updater are separate from offline runtime. Document the prerequisite downloads. Disable Ollama cloud features in the operator setup and verify the application with network access blocked; never claim that configuring LocalMind controls every other process on the Mac. Ollama documents local-only configuration and loopback binding in its [FAQ](https://docs.ollama.com/faq).

### Storage

Use `~/Library/Application Support/LocalMind/` for database, temporary processing data, and future attachment files. Directories are owner-only (`0700`), files owner read/write (`0600`), and creation uses `umask 077`. Resolve and validate paths; reject symlinks where files are created. Do not store chat content in browser local storage, telemetry, request logs, repository files, or cloud-synced Documents folders.

MVP SQLite and future attachment files are plaintext at the application layer. Recommend macOS FileVault for disk protection; it does not protect data from the logged-in user, malware, privileged processes, browser extensions, or an unlocked session. Password-based encrypted storage/SQLCipher is a separate later design, including keys, attachments, WAL, temporary files, backup, and recovery. Do not label MVP “encrypted” merely because data is local.

Delete removes records from the active application and, after M2, schedules associated files and derivatives for removal. SSD wear leveling, SQLite journals, filesystem snapshots, swap, and backups mean deletion is not guaranteed forensic erasure. A local backup/export is an additional sensitive copy controlled by the user. MVP includes a documented consistent backup/restore procedure, not a backup service.

### Prompt injection and untrusted content

User text, attachments, OCR, retrieved chunks, and generated answers are untrusted data. Use a fixed server-owned system instruction and structured roles. Never concatenate a document into system instructions or let model output change settings, model mappings, paths, or permissions. No tools, shell execution, URL fetching, or automatic actions are available to either model.

Later extracted content is delimited and attributed to its source. This reduces ambiguity but does not make instructions inside a document harmless. The enforceable boundary is that the model has no authority to access additional data or perform actions. Safe rendering and backend policy remain necessary even when the model follows a malicious instruction. This design follows the layered approach described in [OWASP's prompt injection guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html).

## 7. Milestones and gates

Effort ranges are planning estimates for one experienced implementer, not calendar commitments. Finish each gate before expanding scope.

| Milestone | Scope | Exit gate | Rough effort |
| --- | --- | --- | --- |
| M0 — Foundation | Workspace, contracts, local storage, loopback guard, model discovery, compatibility checks | Private local skeleton; compatible installed profiles detected; reproducible setup | 1–2 focused days |
| M1 — MVP | Persistent text chat, streaming, Stop, two profiles, recovery, privacy and performance tests | All AC-01–AC-15 pass; measured M1 report and operator instructions exist | 3–5 focused days |
| M2 — Local attachments | Bounded documents and single-photo turns; extraction workers; source previews; cleanup | AC-16–AC-18 pass; existing MVP gates stay green | 3–5 focused days |
| M3 — Local retrieval | Selected document collections, bounded retrieval, citations, optional local embeddings | AC-19 passes; no simultaneous embedding and chat inference | 3–5 focused days |
| M4 — Local media | Local transcription, video frame sampling, cancellable jobs | AC-20 passes; bounded disk, runtime, memory, and output | 4–7 focused days |

After M4, separately evaluate app-managed encryption, chat export UI, richer search, branching, and packaging. Do not implement these opportunistically during MVP.

## 8. Acceptance tests

Tests use synthetic fixtures, not private conversations. Mocked provider tests establish protocol behavior; real installed-model tests establish compatibility. An unavailable community model must not prevent general chat or the missing-model test suite from passing.

| ID | Test and required result |
| --- | --- |
| AC-01 | Start with Ollama stopped: history still opens, composer explains unavailable inference, and no uncaught error occurs. Start Ollama and refresh: ready profiles become usable without restarting LocalMind. |
| AC-02 | Enumerate both currently installed tags. Remove one from a fixture inventory: its row remains visible but disabled. Missing official never silently uses community; missing community never silently uses official. Unknown/cloud/incompatible models are rejected server-side. |
| AC-03 | Send to General, then explicitly switch and send to Abliterated. Each request uses the selected exact tag, and stored answers keep their model/digest snapshots after later switching. Old loaded model is released before the new one is requested. |
| AC-04 | Stream Unicode text split across arbitrary byte boundaries. Text arrives incrementally without duplication, dropped characters, exposed thinking fields, or malformed Markdown execution. Final stored text equals the reconstructed stream. |
| AC-05 | Stop mid-answer: UI acknowledges immediately, upstream cancellation is requested within 1 second, partial answer is retained with cancelled status, and no new generation starts until upstream cleanup is resolved. |
| AC-06 | Create, rename, reopen, and delete chats. Restart both frontend and backend. Completed messages and profile selections persist, ordering remains correct, and deletion removes the active records. |
| AC-07 | Simulate a browser disconnect and a backend kill separately. Disconnect cancels; restart marks surviving active rows interrupted. Partial checkpoints remain usable, no run resumes automatically, and database integrity passes. |
| AC-08 | Send concurrently from two tabs and repeat a request key. At most one run is accepted; duplicates identify the existing run without adding messages. A stale chat version or reused key with different content is rejected. |
| AC-09 | Send a long history: older completed pairs are omitted and the notice is shown. Latest input exceeding budget yields a clear error and no persisted turn. Stored history is unchanged by trimming. Failed/stopped pairs are excluded. |
| AC-10 | Run the production app and real model with internet blocked. New/reopened chats and switching work. Observe no non-loopback application requests, remote resources, implicit model pulls, or cloud fallback. |
| AC-11 | Attempt foreign Origin, null Origin, forged Host/DNS-rebinding requests, unauthenticated API reads/writes, arbitrary provider URLs, cloud aliases, and form submissions. All are rejected. A second LAN device cannot connect. |
| AC-12 | Render script tags, SVG payloads, event attributes, dangerous URLs, and remote tracking images in model output. They remain inert; no network request or automatic action occurs. Model instructions to read files or send secrets have no execution path. |
| AC-13 | Inspect data, WAL/SHM, logs, temporary files, and repository. Permissions meet the storage policy; prompts/tokens/answers are absent from logs and browser storage. Backup restores a coherent database. UI copy accurately states plaintext storage and deletion limits. |
| AC-14 | Exercise provider timeout, malformed stream, truncated stream, missing model after discovery, digest change, full disk, and persistence failure. State is explicit, no silent fallback/retry occurs, and completion is never reported before durable commit. |
| AC-15 | Complete keyboard/IME/scroll/accessibility checks and the M1 performance protocol. Record actual results, versions, settings, and any resolved target misses; no invented speed or memory result. |
| AC-16 | M2: Upload allowed text/PDF/DOCX fixtures and reject executable, macro-enabled, oversized, deceptive MIME, traversal, archive-bomb, and parser-timeout fixtures. Files never execute or fetch remote resources. Scanned PDFs report OCR unavailable until implemented. |
| AC-17 | M2: Ask about one bounded local photo using a profile verified for vision. Strip EXIF from the derivative, enforce pixel/byte limits, and use only the selected image. A text-only profile fails clearly. |
| AC-18 | M2: Restart during extraction, remove an attachment/chat, and run cleanup. Jobs recover or fail explicitly; originals, derivatives, extracted text, and temporary files obey retention and deletion policy. |
| AC-19 | M3: Retrieve only from selected local collections, resolve citations to real source spans, test malicious document instructions, and remove a source. Deleted chunks/vectors stop appearing; missing embedding models never invoke a cloud service. |
| AC-20 | M4: Process bounded audio/video fixtures offline, cancel mid-job, and simulate worker crashes. Timestamps and source references survive; limits and cleanup are enforced; unsupported media fail clearly. |

## 9. Definition of MVP done

M0 and M1 tasks are complete, AC-01–AC-15 have recorded evidence, the production build works from a documented clean installation, and both current model mappings have been exercised on the target Mac. The missing-model path is tested independently. No attachment, RAG, or media prerequisite remains hidden in MVP. The operator can start, stop, inspect status, locate data, back up, restore, and delete local data without a cloud account.
