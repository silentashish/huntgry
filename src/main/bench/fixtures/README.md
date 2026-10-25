# Bench fixtures (CI only)

A synthetic master profile (`master-profile.md`) and a two-job bench set (`set/`) for
`src/main/bench/bench.test.ts`. They run with the fake agent (`src/main/cli/fixtures/fake-claude.mjs`):
the `BENCH_OUTPUT` and `BENCH_LATE` words in the descriptions are its mode words. A real bench set holds the
user's own jobs and stays out of the repository (see `docs/changes/152-tailoring-benchmark.md`).
