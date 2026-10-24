# Tested setup compatibility

Verified on 2026-10-23 on macOS arm64. Exact transitive versions are in `pnpm-lock.yaml`.

| Component | Version |
| --- | --- |
| Node.js LTS | 24.21.0 |
| pnpm | 12.5.1 |
| TypeScript | 6.0.3 |
| React / React DOM | 19.3.1 |
| Vite | 8.3.5 |
| Tailwind CSS | 4.3.3 |
| Fastify / static plugin | 5.12.7 / 10.1.7 |
| Drizzle ORM / Kit | 0.45.4 / 0.31.11 |
| better-sqlite3 / embedded SQLite | 13.0.3 / 3.53.4 |
| Vitest / Playwright | 5.0.5 / 1.64.1 |
| Ollama | 0.40.3 |

TypeScript 6.0.3 matches the installed typescript-eslint peer range; TypeScript 7 was deliberately not selected. Node 24 is an [LTS release](https://nodejs.org/en/about/previous-releases). The [Fastify static compatibility table](https://github.com/fastify/fastify-static#compatibility) supports this Fastify major. Tailwind uses its [Vite integration](https://tailwindcss.com/docs/installation/using-vite); component aliases/configuration follow the [shadcn Vite setup](https://ui.shadcn.com/docs/installation/vite).

Native SQLite was compiled successfully with this machine's developer tools and Python. A fresh machine may need Xcode Command Line Tools and Python to build native dependencies. Only better-sqlite3 and esbuild dependency build scripts are allowlisted. Do not broadly enable all dependency scripts to fix an installation issue.

Both expected Ollama tags were detected without loading a model. T05 metadata eligibility and thinking-off checks are now implemented and tested; cloud-disabled configuration, real inference behavior, and memory/latency measurements remain separate verification.

The current Drizzle Kit dependency chain emits deprecation notices for two esbuild-kit packages. Installation, build, lint, and tests pass; revisit those transitive dependencies when upgrading the migration tooling. No prerelease was used to suppress the notices.

## T05 metadata compatibility — 2026-10-24

Read-only inspection of local `/api/version`, `/api/tags`, `/api/show`, and `/api/ps` during planning observed Ollama 0.40.3 and no resident models. Only safe metadata was recorded; templates, modelfiles, and licenses were not retained.

| Exact installed tag | Artifact bytes | Metadata | Thinking-off |
| --- | --- | --- | --- |
| `qwen3.5:2b-q4_K_M` | 1,945,781,358 | GGUF, Q4_K_M, qwen35, file type 15, completion | `thinking.values` includes false |
| `huihui_ai/qwen3.5-abliterated:2B` | 1,945,323,683 | GGUF, Q4_K_M, qwen35, file type 15, completion | `thinking.values` includes false |

Both advertised vision/tools/thinking; T05 enables none of those features and performs no inference. Eligibility uses structured metadata rather than tag spelling alone. The community model lacks some optional official-model fields; these are not treated as missing required compatibility evidence.

Focused verification: `pnpm exec vitest run --project integration apps/server/tests/integration/models.test.ts` passed 29 tests after one repair. Synthetic provider fixtures, real loopback transport tests, and temporary SQLite databases cover the implementation. The live inspection above is separate from the fixture tests and does not attest Ollama cloud settings or offline generation. Fastify 5.12.7 works with its supported `LogController` configuration, eliminating FSTDEP023. Its default serializer cannot compile the shared profile tuple/intersection schema; the model inventory routes therefore validate the unchanged schema and encode JSON locally. No package version was changed.
