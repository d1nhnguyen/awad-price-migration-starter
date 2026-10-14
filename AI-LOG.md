# AI-LOG.md

Assistant: **Claude Code** (model Claude Opus 5.5), in VS Code, one session on 14 Oct 2026.
Commits it wrote carry a `Co-Authored-By: Claude` trailer.

## What I asked, what it did

| # | I asked | The assistant did | Tier (session 3) |
|---|---|---|---|
| 1 | Read the assignment and tell me what it asks | Read `requirement.md`, the rubric PDF, the session-4 slides and the starter. It summarised the task, the rubric and the deadline, and it found that the default Node (20) cannot run the starter (`node:sqlite` needs 22.5+) | 1 — read only |
| 2 | Read the code and plan before doing anything | Proposed the 6-step expand/migrate/contract plan of this repository. It pointed out: `POST /orders` also reads the price; `npm run migrate` applies *every* pending file; `traffic.js` reads `NEW_CLIENTS` only once; and the slide-19 "one wrong row" comes from the v1/v2 overlap | 1 |
| 3 | Write the code | Wrote migrations 002 and 003 (up and down), `src/app.js` for v2, v3 and v4, `scripts/backfill.js` and the tests of each tag. It worked in a scratch clone, committed, tagged and ran the tests there | 2 — wrote migration files and code |
| 4 | Finish the assignment | Added the `SIGUSR2` switch to `scripts/traffic.js`, wrote `scripts/run-ia2.sh`, `MIGRATION.md`, this file and a draft of `SELF_ASSESSMENT_REPORT.md` | 2 |

## What the assistant ran, and on what

- **Rehearsals only, on throwaway databases** in its scratch directory, on ports 4001/4002. That covered
  the tests on every tag, the backfill (interrupted and re-run) and `migrate:down` on a copy. It also
  ran two complete rehearsals of the sequence under traffic, both with zero failed requests.
  It never ran a migration against the repository's `data/app.db`.
- It found and fixed one bug of its own in `run-ia2.sh`. `timeout -s INT` signalled the whole script,
  not only the backfill. The script now sends SIGINT to the backfill's own pid.

## What I ran and checked myself

<!-- Fill in honestly before submitting: what you read line by line, what you ran, what you changed. -->

- [ ] Read the diff of every tag: `git diff v1 v2`, `git diff v2 v3`, `git diff v3 v4`, and the two migrations.
- [ ] Ran `npm test` on each tag.
- [ ] Ran the official sequence myself: `npm run ia2`. It produced the committed `traffic-log.txt` and `check-log.txt`.
- [ ] Checked `traffic-log.txt` ends with `RESULT: zero failed requests` and read every `check-log.txt` step.
- [ ] Can explain without notes: why the backfill also fixes disagreeing rows, why v3 → v2 is safe and v4 → v2 is not,
      and why step 6 is the point of no return.

## Where I disagreed with or changed the assistant's output

<!-- e.g. "kept / changed X because …" — or "none". -->
