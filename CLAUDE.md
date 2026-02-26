# rs-bench — Benchmark Tasks (Harbor)

Benchmark suite for evaluating AI agents on RuneScape gameplay tasks.
Uses [rs-sdk](https://github.com/MaxBittker/rs-sdk) as the game environment (cloned at Docker build time).

All task directories are **generated** — never edit them directly.

## Source of truth

| Path | Purpose |
|------|---------|
| `generate-tasks.ts` | Generates all task directories (16 standard XP + 22 variants) |
| `shared/check_xp.ts` | XP verifier for 10m single-skill tasks |
| `shared/check_skill_xp.ts` | XP verifier for 30m single-skill tasks (includes tracking) |
| `shared/check_total_level.ts` | Total level verifier (includes tracking) |
| `shared/skill_tracker.ts` | Standalone skill tracker (single source of truth — copied into Docker image at build time) |
| `docker/` | Shared Docker image source (pre-built, pushed to GHCR) |

## Regenerate tasks

```bash
bun generate-tasks.ts
```

Run this before `harbor run`. Generated directories are gitignored.

## Running benchmarks

```bash
# Standard 10m XP benchmarks (all models in parallel)
./run.sh

# 30m per-skill XP benchmarks (all 16 skills)
./run-skills-30m.sh

# Total-level benchmarks (configurable duration)
./run-total-level.sh --duration 8m
./run-total-level.sh --duration 1h
```

Each task has an `environment/Dockerfile` that `FROM`s the pre-built GHCR image, so Modal pulls the image with no build step beyond the layer cache.

## Adding a new task

1. Add a new entry to the `SKILLS` array (for standard XP-grind tasks) or `VARIANTS` array (for custom tasks) in `generate-tasks.ts`
2. If the task needs a new verifier, add it to `shared/`
3. Run `bun generate-tasks.ts`

## Docker image

All tasks use the pre-built image `ghcr.io/maxbittker/rs-agent-benchmark:v16` (8x game speed via `NODE_TICKRATE=50`). The image clones [rs-sdk](https://github.com/MaxBittker/rs-sdk) at a pinned ref. Variant tasks that need different env settings use a thin `FROM` layer on top.

Build and push:
```bash
cd docker && ./build.sh
```
