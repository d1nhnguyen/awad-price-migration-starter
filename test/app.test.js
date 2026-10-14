import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { open } from '../src/db.js';
import { createApp } from '../src/app.js';

let db, server, base;
before(async () => {
  db = open(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.up.sql')).sort())
    db.exec(readFileSync(new URL(f, dir), 'utf8'));          // every migration, in order
  db.exec("INSERT INTO menu_items (name, price, price_vnd) VALUES ('Phở bò', 45.5, 45500), ('Trà đá', 5, 5000)");
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const columns = (id) => ({ ...db.prepare('SELECT price, price_vnd FROM menu_items WHERE id = ?').get(id) });

test('GET /menu/:id returns price in thousands and priceVnd in dong', async () => {
  assert.deepEqual(await call('GET', '/menu/1'), { status: 200, body: { id: 1, name: 'Phở bò', price: 45.5, priceVnd: 45500 } });
});

test('GET /menu lists price and priceVnd', async () => {
  const r = await call('GET', '/menu?limit=2');
  assert.deepEqual(r.body.map((x) => [x.price, x.priceVnd]), [[45.5, 45500], [5, 5000]]);
});

test('PATCH /menu/:id from an old client writes both columns', async () => {
  const r = await call('PATCH', '/menu/2', { price: 6 });
  assert.equal(r.status, 200);
  assert.equal(r.body.price, 6);
  assert.equal(r.body.priceVnd, 6000);
  assert.deepEqual(columns(2), { price: 6, price_vnd: 6000 });
});

test('PATCH /menu/:id from a new client writes both columns', async () => {
  const r = await call('PATCH', '/menu/2', { priceVnd: 7500 });
  assert.deepEqual([r.status, r.body.price, r.body.priceVnd], [200, 7.5, 7500]);
  assert.deepEqual(columns(2), { price: 7.5, price_vnd: 7500 });
});

test('POST /menu writes both columns, from old and new clients', async () => {
  const old = await call('POST', '/menu', { name: 'Bún chả', price: 40 });
  assert.deepEqual([old.status, old.body.price, old.body.priceVnd], [201, 40, 40000]);
  assert.deepEqual(columns(old.body.id), { price: 40, price_vnd: 40000 });
  const neu = await call('POST', '/menu', { name: 'Cơm tấm', priceVnd: 35500 });
  assert.deepEqual([neu.status, neu.body.price, neu.body.priceVnd], [201, 35.5, 35500]);
  assert.deepEqual(columns(neu.body.id), { price: 35.5, price_vnd: 35500 });
});

test('price is stored rounded to whole dong, so both columns agree', async () => {
  const r = await call('PATCH', '/menu/2', { price: 7.0004 });
  assert.deepEqual([r.body.price, r.body.priceVnd], [7, 7000]);
  assert.deepEqual(columns(2), { price: 7, price_vnd: 7000 });
});

test('a bad price is refused', async () => {
  for (const body of [{ price: -1 }, { priceVnd: 45.5 }, { priceVnd: 0 }, { price: 0.0001 }, { price: 45.5, priceVnd: 45000 }, {}])
    assert.equal((await call('PATCH', '/menu/1', body)).status, 400, JSON.stringify(body));
  assert.equal((await call('POST', '/menu', { name: 'x', priceVnd: '45500' })).status, 400);
  assert.deepEqual(columns(1), { price: 45.5, price_vnd: 45500 });
});

test('POST /orders totals at the current price', async () => {
  await call('PATCH', '/menu/2', { price: 6 });
  const r = await call('POST', '/orders', { items: [{ menuItemId: 1, qty: 2 }, { menuItemId: 2, qty: 1 }] });
  assert.deepEqual(r, { status: 201, body: { id: 1, total: 97 } });
});

test('errors have one shape', async () => {
  assert.deepEqual((await call('GET', '/menu/999')).body.error, 'not_found');
  assert.equal((await call('PATCH', '/menu/1', { price: -1 })).status, 400);
});

test('/health names the version', async () => {
  assert.deepEqual((await call('GET', '/health')).body, { ok: true, version: 'v3' });
});

test('reads come from price_vnd, not price', async () => {
  db.exec('UPDATE menu_items SET price = 1 WHERE id = 1');   // what v3 must not look at
  assert.deepEqual((await call('GET', '/menu/1')).body, { id: 1, name: 'Phở bò', price: 45.5, priceVnd: 45500 });
  assert.deepEqual((await call('POST', '/orders', { items: [{ menuItemId: 1, qty: 3 }] })).body.total, 136.5);
  db.exec('UPDATE menu_items SET price = 45.5 WHERE id = 1');
});
