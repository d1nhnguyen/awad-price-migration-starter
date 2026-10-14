# SELF_ASSESSMENT_REPORT.md — IA#2 Zero-downtime migration

Student ID: ⟨MSSV⟩ · Submission: `⟨MSSV⟩_95.zip`

<!-- Line numbers marked ⟨…⟩ come from YOUR run of `npm run ia2`: every "=== step" heading in
     check-log.txt says which line traffic-log.txt had reached. Fill them in, then re-check every claim. -->

| # | Criterion | Max | Claimed | Evidence |
|---|---|---|---|---|
| 1 | The plan | 20 | 19 | `MIGRATION.md` › *The plan*: 7 rows, each with the schema after the step, the code on every instance, the exact undo command, and which earlier versions are still safe. The point of no return is step 6, with the reason (*The point of no return*). The rows match tags `v1`–`v4` and `migrations/002_*`, `003_*` (`git log --oneline --decorate`) |
| 2 | Expand and dual write | 20 | 19 | `migrations/002_add_price_vnd.up.sql` is its own migration, and v1 keeps serving on it (check-log step 1; traffic-log lines ⟨step 1 line⟩–⟨step 2 line⟩). Tag `v2` `src/app.js`: `q.insert` and `q.setPrice` both write both columns; `priceVnd` is offered, `price` is still returned. Tests: `git checkout v2 && npm test`. Both migrations have a `.down.sql`; `migrate:down` was run for each on a copy, last section of `check-log.txt` |
| 3 | Backfill | 15 | 15 | `scripts/backfill.js`: id-range batches of 500, one short transaction each, while traffic runs. Refuses while v1 serves (check-log step 1). Interrupted and re-run (steps 3a/3b), `CONSISTENT` right after it (3b). Also repairs the rows the v1/v2 overlap left wrong (step 2 `disagree` > 0 → 3b `0`) |
| 4 | Zero failed requests | 20 | 18 | `traffic-log.txt` is one run, from v1 (line ⟨first⟩) to after migration 003 (check-log step 6 → line ⟨step 6 line⟩), ending `RESULT: zero failed requests` (last line). Rolling restarts appear as `down`/`back` lines, one instance at a time. `new clients now 0.3` at line ⟨line⟩, after v2 was on both. Note: new clients are switched on by a SIGUSR2 added to `traffic.js` (`MIGRATION.md` › *One change to the traffic script*) |
| 5 | The way back | 15 | 14 | v3 → v2 → v3 under traffic: check-log steps 4, 4r, 4f, all `CONSISTENT`. Traffic-log lines ⟨step 4 line⟩–⟨step 4f line⟩ have zero failures. `MIGRATION.md` › *The way back* says why it is safe and why v4 → v2 is not (step 5 `disagree`) |
| 6 | Contract | 10 | 10 | `migrations/003_drop_price.up.sql` runs after v4 (which neither reads nor writes `price`, tag `v4` `src/app.js`) is on both instances (check-log steps 5 → 6). Every endpoint still returns `price` after the drop. Traffic-log lines ⟨step 6 line⟩–end are clean |
| | **Total** | **100** | **95** | |

## What I did not manage

- `npm run check` reports INCONSISTENT at two steps (2 and 5). Both are expected, and both are
  resolved by the next step; `MIGRATION.md` explains them. The v1/v2 overlap cannot be avoided
  without a database trigger, and I chose not to use one.
- `price_vnd` stays nullable after the contract. Making it `NOT NULL` in SQLite needs a table rebuild.
  It was left out, and `npm run check` guards it instead.
- The traffic script was changed (one line changed and 8 added, `SIGUSR2`) to switch new clients on without breaking the run in two.
