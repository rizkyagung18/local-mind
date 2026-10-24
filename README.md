# LocalMind

A local LLM workspace for a MacBook Air M1 with 8 GB memory.

**Current stage: project setup.** The starter page and protected local connection check work toward the planned application. Streaming chat, persistence, and model selection are subsequent tasks.

## Run

Use Node 24.21.0 and pnpm 12.5.1.

```sh
pnpm install --frozen-lockfile
pnpm run doctor
pnpm dev
```

Open <http://127.0.0.1:5173>. To run the production build:

```sh
pnpm build
pnpm start
```

Open <http://127.0.0.1:3210>. Stop with Ctrl+C. Do not run development and production together because both use backend port 3210.

## Checks

```sh
pnpm exec playwright install chromium
pnpm check
```

Dependency and browser installation can require internet access. The installed starter app uses local assets and same-origin requests. The setup does not initialize a persistent database or perform inference.

See [AGENTS.md](./AGENTS.md), [PRD.md](./PRD.md), [ARCHITECTURE.md](./ARCHITECTURE.md), [TASKS.md](./TASKS.md), and [progress](./docs/progress.md).
