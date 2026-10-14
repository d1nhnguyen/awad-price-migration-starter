# MIGRATION.md — `menu_items.price` → `menu_items.price_vnd`

`price` holds thousands of dong as a float (`45.5` = 45,500 đ). It becomes `price_vnd`,
dong as an integer, and `price` is dropped at the end, with two instances serving
traffic the whole time and old clients still sending and reading `price` (thousands).
New clients may send and read `priceVnd` (dong) from v2 on.

The whole sequence below runs in one command, `npm run ia2` ([scripts/run-ia2.sh](scripts/run-ia2.sh)).
That command wrote [traffic-log.txt](traffic-log.txt) and [check-log.txt](check-log.txt). Every `=== step …`
heading in check-log.txt gives the line traffic-log.txt had reached at that moment.

## The plan

Code versions are git tags. Each one runs from its own worktree (`git worktree add ../ia2-vN vN`),
and every instance opens the same database file (`DB_PATH`, an absolute path). A deploy is always a
rolling restart: stop one instance (it finishes in-flight requests), start the new version on its
port, then do the same for the other instance.

| Step | What happens | Schema after the step | Code on every instance | Undo — the exact command | Earlier versions that can still run safely on this schema |
|---|---|---|---|---|---|
| 0 | start | `price REAL` (nullable) | **v1** (starter) | — | v1 |
| 1 | **expand**: migration `002_add_price_vnd`, run from the v2 worktree (`cd ../ia2-v2 && npm run migrate`) while v1 serves | `price REAL`, `price_vnd INTEGER NULL CHECK (integer > 0)` | v1 | `npm run migrate:down` (reverts 002). Only while every instance runs v1: v2+ need the column to start | **v1** ✔ — its statements name their columns and never see `price_vnd` |
| 2 | **dual write**: rolling restart to **v2**, then new clients are turned on | same | **v2**: writes `price` **and** `price_vnd` on every write path (`POST /menu`, `PATCH /menu/:id`), reads `price`, offers `priceVnd` | rolling restart back to v1: `kill <pid :3001>; (cd ../ia2-v1 && PORT=3001 npm start)`, then the same for :3002. Run the backfill again before going forward | **v1** ✔ for requests — it reads and writes `price`, which v2 keeps current. But a row v1 re-prices keeps an old `price_vnd`; only the backfill repairs it |
| 3 | **backfill**: `cd ../ia2-v2 && npm run backfill` — refuses to start unless every instance answers v2 or v3 | same, every `price_vnd` filled and equal to `round(price × 1000)` | v2 | nothing to undo: data only, `price` is untouched and is still what everyone reads. `npm run backfill` again is always safe | **v2** ✔ · v1 ✔ for requests, but it reopens rows with a wrong `price_vnd`: run the backfill again before v3 |
| 4 | **read new**: rolling restart to **v3** | same | **v3**: reads `price_vnd`, still writes **both** | rolling restart back to v2 — **done under traffic** (steps 4r and 4f in check-log.txt) | **v2** ✔ (see *The way back*) · v1 ✗ — it writes `price` alone, and v3 reads `price_vnd`: stale reads |
| 5 | **stop writing old**: rolling restart to **v4** | same, but `price` now goes stale | **v4**: `price_vnd` only — the column `price` is neither read nor written; the API still answers `price` | rolling restart back to **v3 — not v2** | **v3** ✔ (reads `price_vnd`) · v2 ✗ — it reads `price`, which v4 no longer writes: wrong prices with `200 OK` · v1 ✗ |
| 6 | **contract**: migration `003_drop_price`, run from the repository root (`npm run migrate`) — **POINT OF NO RETURN** | `price_vnd INTEGER` only | v4 | `npm run migrate:down` (reverts 003). It re-adds `price` and fills it from `price_vnd` — a rebuild, not an undo. Then v3 can be deployed again | **v4 only** · v1, v2, v3 ✗ — they select or write `price`: every request fails |

Commits, in the order they are deployed:

```
v1  2b889bd  the starter
    b8ac697  migrations/002_add_price_vnd.{up,down}.sql
v2  9ab4778  src/app.js dual write · scripts/backfill.js · tests
v3  5494a79  src/app.js reads price_vnd
v4  07073c9  src/app.js without the price column
    25e6287  migrations/003_drop_price.{up,down}.sql
    …        scripts/traffic.js (SIGUSR2), scripts/run-ia2.sh, this file, the logs
```

Each migration lives in the commit just before the code that needs it (002), or just after the code
that stopped using it (003). That way `npm run migrate` from a worktree can never apply a step too early.
`migrate` applies **every** pending file, so 002 is run from the v2 worktree, which has no 003.

### The point of no return: step 6, `DROP COLUMN price`

- **The data goes.** The column and the values it held are deleted. `003_drop_price.down.sql` adds a new
  `price` and computes it from `price_vnd`. That gives the same prices only because v2–v3 kept
  both columns equal and v4 never wrote `price` again. Whatever `price` held that is not in `price_vnd`,
  such as a sub-dong fraction written by v1 or a value written by hand, cannot come back.
- **The code cannot simply go back.** v1–v3 prepare statements on `price` when they start, and they
  fail on every request against a schema without it. Any rollback past v4 needs a schema change
  first. Under load, that is a second migration while the site is down, not a rolling restart.

Every step before it is undone by a rolling restart or by `migrate:down`, under traffic, with nothing
lost. Before step 6 you take a backup (`cp data/app.db …`, with the instances stopped, or `sqlite3 .backup`)
and you know how long a restore takes.

## Why each step works with the code that is still running

- **Step 1** only adds a nullable column with no default. SQLite changes the schema and rewrites no row.
  v1's `SELECT id, name, price`, `INSERT (name, price)` and `UPDATE … SET price` are unaffected.
  The `CHECK` puts the money rule in the database: a float or a non-positive `price_vnd` is refused,
  whoever writes it.
- **Step 2.** During the rolling restart, v1 and v2 serve together, and both read `price`. Every read
  therefore shows the last write, whichever instance made it. v2 writes both columns in one
  `UPDATE`/`INSERT`, which is atomic.
- **Step 4.** v2 and v3 serve together. v3 reads `price_vnd`, v2 reads `price`, and both write both
  columns in one statement. Each one therefore sees the other's writes.
- **Step 5.** v3 and v4 serve together. Both read `price_vnd`, and both write it. `price` stops being
  maintained, and nothing that is still running reads it.
- **Step 6.** Only v4 runs, and it does not mention `price`. SQLite re-prepares v4's statements after the
  schema change.

Prices are stored rounded to whole dong from v2 on (`price = price_vnd / 1000`), so the two columns
always hold exactly the same price. v2 and v3 then return the same `price` for every row. A
client that sends `45.1234` gets `45.123` back: a price in dong cannot hold less than one dong. A price
below one dong (`0.0001`, which v1 accepted) is now refused with 400.

## The backfill — [scripts/backfill.js](scripts/backfill.js)

```sql
UPDATE menu_items SET price_vnd = CAST(round(price * 1000) AS INTEGER)
 WHERE id > ? AND id <= ?                         -- one id range of BATCH (500) rows
   AND price IS NOT NULL AND CAST(round(price * 1000) AS INTEGER) >= 1
   AND (price_vnd IS NULL OR price_vnd <> CAST(round(price * 1000) AS INTEGER));
```

- **Small batches.** Each id range is its own short `BEGIN IMMEDIATE … COMMIT`, followed by a 20 ms pause.
  A live write waits for one batch at most. A batch takes a few milliseconds.
- **It also repairs rows that disagree, not only `NULL` ones.** This is the "zero failed requests and
  one wrong row" from the slides. During the step-2 rolling restart, v2 writes both columns of a row,
  then the v1 that is still serving re-prices that row in `price` alone. The row's `price_vnd` is now
  set but wrong. A backfill that only looks at `price_vnd IS NULL` never revisits it. In our run,
  check-log.txt shows 32 such rows at step 2 (`disagree 32`), and they are gone after step 3b.
- **Re-runnable.** Until v3, `price` is the truth. A second run, or a run after Ctrl+C, therefore
  recomputes the same values and touches only rows still wrong. check-log.txt shows it stopped halfway
  (step 3a), then run again (step 3b, `CONSISTENT`).
- **Only when nothing writes `price` alone.** Before the first batch, the script asks every instance's
  `/health` for its version. It refuses unless all answer `v2` or `v3`. v1 has no version and writes
  `price` alone. v4 no longer writes `price`, so `price` is no longer the truth to copy from.
  check-log.txt shows the refusal while v1 was still serving (step 1).
- Its ranges stop at the highest id that exists when it starts. Rows created later come from v2,
  which writes both columns. Rows with `price IS NULL` (allowed by the old schema) cannot be derived.
  They are counted and reported, never invented, and in this data there are none.

## The way back

Performed under traffic: v3 → **v2** on both instances (step 4r), then forward to v3 again (step 4f).
traffic-log.txt lines 19–31 show zero failures for that stretch, and `npm run check` says `CONSISTENT` before (step 4),
in between (4r) and after (4f).

**Why it is safe.** v3 still writes `price` on every write path. At every moment, `price` is as current
as `price_vnd`, so v2, which reads `price`, shows exactly what v3 acknowledged. While the two
versions are mixed, v2 also writes both columns, so the v3 instance still running reads v2's writes
from `price_vnd`.

**Which later rollback would not be safe.**

- **v4 → v2 (or v1).** v4 no longer writes `price`. After a few seconds of traffic, 1,196 rows
  had a `price` that nobody set: check-log.txt step 5 shows `disagree 1196`. A v2 instance would
  return those old prices with `200 OK` and log no error. That is the failure only an accountant
  finds. From v4, the way back is v3, which reads `price_vnd`.
- **Anything below v4 after step 6.** `price` no longer exists. First `migrate:down` (rebuild `price`),
  then v3.

## Why `npm run check` says INCONSISTENT twice — and why that is expected

| Where | What check-log.txt shows | Why | What makes it right again |
|---|---|---|---|
| step 2 (v2 on both) | `disagree 32` | the v1/v2 overlap described in *The backfill*. No request was wrong: both versions read `price`, which is right | the backfill, step 3b `CONSISTENT` |
| step 5 (v4 on both) | `disagree 1196` | v4 has stopped writing `price` by design, and check.js compares the two columns while both exist | dropping `price`, step 6 `CONSISTENT` |

Every other check — after the backfill, before, during and after the rollback, after the drop, and at
the end — is `CONSISTENT`.

## The contract with clients

| | v1 | v2 | v3 | v4 (before and after the drop) |
|---|---|---|---|---|
| request body | `price` | `price` and/or `priceVnd` | same | same |
| `GET /menu`, `GET /menu/:id`, `POST`/`PATCH` responses | `price` | `price` + `priceVnd` | same | same — `price` = `price_vnd / 1000` |
| `POST /orders` → `total` | thousands | thousands | thousands, summed in integer dong | same |
| `GET /health` | `{ok}` | `{ok, version}` | same | same |

- If a request sends both fields and they disagree, it is refused with 400.
- `order_items.unit_price` keeps its old unit, as the assignment says.
- Old clients get `price` in every response to the end. After the drop, it is computed at the edge.
- New clients were turned on (30%) once every instance offered `priceVnd` (after step 2). They stayed
  on through the rollback to v2, because v2 offers `priceVnd` too.

## One change to the traffic script

The rubric asks for **one** continuous run from v1 to after the last migration, **and** for new clients
once the API offers `priceVnd`. The starter's `traffic.js` read `NEW_CLIENTS` once, at start. On v1,
new clients would fail, and restarting the script would split the run.

[scripts/traffic.js](scripts/traffic.js) now also listens for `SIGUSR2`. When it receives one, it switches
`NEW_CLIENTS` to `NEW_CLIENTS_LATER` (0.3) and logs `new clients now 0.3`. That line shows in
traffic-log.txt where it happened. Nothing else about how requests are made or counted changed:
`git diff v1 -- scripts/traffic.js` is one changed line (`const` → `let`)
plus 8 added lines (the handler and its documentation).

## Replay

```bash
nvm use 26            # any Node ≥ 22.5
npm test              # on each tag: git checkout vN && npm test
npm run ia2           # the whole sequence, ~2 min; PAUSE=5 seconds between steps
```

It recreates `data/app.db`, the worktrees `../ia2-v1…v4`, traffic-log.txt and check-log.txt.
At the end, it runs `migrate:down` for 003 and for 002 on a copy of the database
(`data/down-demo.db`), then goes up again the way the plan does: 002, backfill, 003. All of that
output is at the end of check-log.txt.

## The same plan in PostgreSQL

The steps are the same, but the locks are not. Step 1 must stay a nullable column with no volatile default
(otherwise the table is rewritten under an exclusive lock). The CHECK is added `NOT VALID`, then
`VALIDATE CONSTRAINT`. Every migration sets `lock_timeout = '2s'`. The backfill keeps its batches
small, because each `UPDATE` holds row locks until it commits. A later `price_vnd NOT NULL` goes through
a `NOT VALID` check first.
