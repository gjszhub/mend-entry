# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gjszhub/mend-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gjszhub/mend-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`main.ts` (Node 22, stdlib only) applies AI-written edits to a tree of text
files, in four formats — unified diffs (often with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON —
following `SPEC.md`. It finds the lines an edit names at the first of three
matching tiers (exact, trailing whitespace, full whitespace), re-indents
replacement lines at tier 2, and changes every file or none (atomic).

Practice-set score: **1000 (100/100 checks)**.

Run it with:

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`runner.ts` is the kit's trial runner (kept as-is); `check.ts` runs the
100 public practice checks in `program/generator/practice.json` of the kit:

```
node check.ts <practice.json>
```
