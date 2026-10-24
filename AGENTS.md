# LocalMind agent instructions

Applies to this entire repository. Follow the user's current request and preserve unrelated work.

## Read first

- Read `PRD.md` for scope, `ARCHITECTURE.md` for contracts and security, and `TASKS.md` for dependencies.
- Read `docs/progress.md` for verified implementation status. Planning documents describe the target, not completed features.
- Implement only the requested task or milestone. For an MVP request, finish M0/M1 through T17; later milestones require their own scope.
- When changing a contract or limit, update affected documentation, shared types, implementation, and meaningful tests together.

## Workspace and commands

- `apps/web`: React, Vite, TypeScript, Tailwind, checked-in shadcn-style components.
- `apps/server`: Fastify, TypeScript, native local Ollama adapter; SQLite/Drizzle persistence is planned.
- `packages/contracts`: shared schemas, types, and constants. No server-only imports here.
- Use Node from `.nvmrc` and pnpm from `package.json`. Keep exact dependency versions and `pnpm-lock.yaml`.
- `pnpm install --frozen-lockfile`: reproduce dependencies.
- `pnpm dev`: frontend on `127.0.0.1:5173`, backend on `127.0.0.1:3210`.
- `pnpm build` then `pnpm start`: production at `http://127.0.0.1:3210`.
- `pnpm run doctor`: safe environment/native SQLite/installed-model diagnostics, without inference.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`: static and automated checks.
- `pnpm test:e2e`: build and browser smoke tests; requires `pnpm exec playwright install chromium` once.
- `pnpm check`: all implemented checks. Do not use pass-with-no-tests to fake a passing suite.

## Privacy and security invariants

- Bind only loopback. Keep the production and development origins explicit; no wildcard hosts/CORS or public tunnels.
- Ollama is fixed to `http://127.0.0.1:11434`. No arbitrary URL proxy, redirects, remote provider, telemetry, cloud database, or implicit downloads.
- Never pull, replace, or load models merely to inspect inventory. Preserve existing Ollama configuration unless the task requires a specific change.
- Default official tag: `qwen3.5:2b-q4_K_M`. Community seed: `huihui_ai/qwen3.5-abliterated:2B`. Detect absence; never silently substitute models.
- Model labels and loopback URLs alone do not prove local inference. Follow the architecture's metadata/eligibility and offline checks.
- Keep tokens in memory. Guard API reads and writes with Host/Origin/session checks. Never put tokens in URLs or logs.
- Persist private data only in the validated owner-only application-support directory specified by ARCHITECTURE, never the checkout or browser storage.
- Use 0700 directories, 0600 files, parameterized SQL, reviewed migrations, and atomic state transitions. Protect WAL, temporary data, and backups too.
- Do not claim local storage is encrypted. MVP application data is plaintext; FileVault has a separate threat boundary.
- Treat prompts, documents, retrieved passages, and model output as untrusted. No model-controlled tools, shell execution, file reads, or network actions.
- Disable raw HTML and remote media in chat rendering. Bundle assets locally. Never execute generated code or automatically open generated links.

## Implementation discipline

- Keep strict TypeScript and shared response schemas. Avoid `any`, blanket suppressions, and exposing raw provider errors.
- Separate the injectable server factory from process startup. Keep network calls outside database transactions.
- Maintain one generation slot, 4,096-token default context, 512-token output, and supported thinking-off behavior; use the documented alternatives only.
- Persist acceptance before streaming and final state before reporting completion. Handle cancellation, duplicate requests, disconnects, and restart explicitly.
- Use synthetic fixtures and isolated temporary databases. Never commit private prompts, photos, credentials, or model traces.
- Test changed behavior at the appropriate level; real sockets for streaming, real SQLite for persistence, real-device measurements for performance.
- Keep UI keyboard-accessible, respect IME/reduced motion, and show truthful unavailable states. Do not add nonfunctional feature controls.
- Do not commit, push, publish, deploy, or create a remote repository unless requested. Do not delegate unless the user asks for delegation.
- Update task checkboxes only after verification. End with changes, checks/results, limitations, and the next incomplete task.
