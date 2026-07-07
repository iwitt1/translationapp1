# /docs/archive/ — Archived & retired documentation

This folder holds (1) point-in-time **snapshots** of the doc set taken before large rewrites,
and (2) **retired** docs that are no longer part of the active set but are kept for reference.
Nothing here is maintained — these are frozen records. Active docs live one level up in
`/docs/`.

## How this folder is organized

- `YYYY-MM-DD-<reason>/` — a full frozen snapshot of every doc as it existed on that date,
  original filenames preserved. Use these to see or restore prior state.
- `retired/` — individual docs that were removed from the active set (their job is done), each
  carrying a banner at the top explaining when and why it was retired.

## Contents

### `2026-07-07-pre-cleanup/`
Full snapshot of all 12 `/docs/` files **plus** the root `README.md` (saved as
`README-root.md`), taken immediately before the **docs legibility cleanup** of 2026-07-07
(roadmap item "Docs legibility cleanup"; see `decisions.md` 2026-07-07 "Docs legibility
cleanup + new conventions"). This is the rollback point if any of the cleanup rewrites lost
information that wasn't intended to be dropped.

Git equivalent: tag `docs-pre-cleanup-2026-07-07` (created by Isaac against the pre-cleanup
commit). Either the tag or this folder restores prior state.

### `retired/`
- `phase2-implementation.md` — the Phase 2 build spec + Sonnet prompt. Phase 2 shipped
  (prod cutover 2026-06-11); `decisions.md` 2026-06-09 pre-authorized retiring it once Phase 2
  completed. Retired here 2026-07-07.

## Restoring something

To restore a file from a snapshot, copy it back up into `/docs/`:

```
cp docs/archive/2026-07-07-pre-cleanup/<file>.md docs/<file>.md
```

Or restore the whole pre-cleanup tree from the git tag:

```
git checkout docs-pre-cleanup-2026-07-07 -- docs/
```
