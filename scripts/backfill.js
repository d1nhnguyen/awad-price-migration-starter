// Backfill menu_items.price_vnd from price — step 3 of the IA#2 plan.
//
// Start it only when every instance writes both columns (v2 or v3). While a v1 still
// serves, it re-prices `price` alone, and any row it touches after its batch here
// is wrong again. So the script first asks every instance for its version and refuses
// unless all of them answer v2 or v3. (v4 is refused too: it no longer writes price,
// so price is no longer the truth to copy from.)
//
// Each batch is one short transaction over a range of ids, so a live write waits
// for one batch at most. A batch fixes rows with no price_vnd AND rows whose
// price_vnd disagrees with price: during the rolling restart v1 → v2, a v1 instance
// can re-price a row that v2 had already written both columns for, and the classic
// `WHERE price_vnd IS NULL` backfill would never look at that row again.
// Until v3, price is the truth, so running it again — or killing it halfway and
// starting it again — gives the same result.
//
//   BATCH=500       rows per batch (by id range)
//   PAUSE_MS=20     pause between batches, so live writes get the lock
//   TARGETS=http://localhost:3001,http://localhost:3002   instances to ask first
//   FORCE=1         skip that question (only for a database no instance serves)
import { open, DB_PATH } from '../src/db.js';

const BATCH = Number(process.env.BATCH ?? 500);
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 20);
const TARGETS = (process.env.TARGETS ?? 'http://localhost:3001,http://localhost:3002').split(',');
const SAFE = new Set(['v2', 'v3']);

if (!process.env.FORCE) {
  for (const t of TARGETS) {
    let version;
    try { version = (await (await fetch(`${t}/health`, { signal: AbortSignal.timeout(2000) })).json()).version; }
    catch (e) { console.error(`${t} did not answer (${e.cause?.code ?? e.name}) — cannot tell what it runs; not starting`); process.exit(1); }
    if (!SAFE.has(version)) {
      console.error(`${t} runs ${version ?? 'v1 (no version in /health)'}, which does not write both columns; not starting`);
      process.exit(1);
    }
    console.log(`${t} runs ${version}`);
  }
}

const db = open();
const cols = new Set(db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name));
if (!cols.has('price') || !cols.has('price_vnd')) { console.error('needs both price and price_vnd — run migration 002 first'); process.exit(1); }

const NEEDS = `price IS NOT NULL AND CAST(round(price * 1000) AS INTEGER) >= 1
  AND (price_vnd IS NULL OR price_vnd <> CAST(round(price * 1000) AS INTEGER))`;
const fix = db.prepare(`UPDATE menu_items SET price_vnd = CAST(round(price * 1000) AS INTEGER)
  WHERE id > ? AND id <= ? AND ${NEEDS}`);
const count = (sql) => db.prepare(sql).get().n;

// Rows inserted after this point come from v2/v3, which write both columns.
const maxId = count('SELECT coalesce(max(id), 0) n FROM menu_items');
console.log(`db ${DB_PATH} · ${count(`SELECT count(*) n FROM menu_items WHERE ${NEEDS}`)} rows to fix · ids 1..${maxId} · batches of ${BATCH}`);

let stop = false;
process.on('SIGINT', () => { stop = true; });

let fixed = 0, batches = 0, from = 0;
for (; from < maxId && !stop; from += BATCH) {
  db.exec('BEGIN IMMEDIATE');
  try { fixed += Number(fix.run(from, from + BATCH).changes); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  if (++batches % 10 === 0) console.log(`  up to id ${from + BATCH}: ${fixed} rows fixed`);
  await new Promise((r) => setTimeout(r, PAUSE_MS));
}

console.log(`${stop ? `stopped after id ${from}` : 'done'} · ${batches} batches · ${fixed} rows fixed`);
console.log(`still to fix: ${count(`SELECT count(*) n FROM menu_items WHERE ${NEEDS}`)}` +
  ` · no price at all (cannot be derived): ${count('SELECT count(*) n FROM menu_items WHERE price IS NULL AND price_vnd IS NULL')}`);
if (stop) console.log('stopped by Ctrl+C — run it again to finish; rows already fixed are skipped');
