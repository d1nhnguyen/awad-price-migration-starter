import { createServer } from 'node:http';

// v4 of the menu service. The column price is neither read nor written any more:
// price_vnd (dong, integer) is the only stored price, so migration 003 can drop price
// once every instance runs v4. Old clients still send and read price in thousands —
// it is converted here, at the edge. From now on price goes stale: the way back is
// v3 (reads price_vnd), never v2 (reads price).
const VERSION = 'v4';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const error = (res, status, code, message) => json(res, status, { error: code, message });

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

const isPrice = (p) => typeof p === 'number' && Number.isFinite(p) && p > 0 && p <= 100000;
const isPriceVnd = (v) => Number.isInteger(v) && v > 0 && v <= 100000 * 1000;
const toVnd = (price) => Math.round(price * 1000);

// Old clients send price (thousands), new clients priceVnd (dong). Returns the price
// in dong, or null if neither is valid, or if both are sent and they disagree.
function priceVndOf(body) {
  if (body.price === undefined && body.priceVnd === undefined) return null;
  if (body.price !== undefined && !isPrice(body.price)) return null;
  if (body.priceVnd !== undefined && !isPriceVnd(body.priceVnd)) return null;
  const vnd = body.priceVnd ?? toVnd(body.price);
  if (body.price !== undefined && toVnd(body.price) !== vnd) return null;
  return vnd >= 1 ? vnd : null; // isPrice lets through 0.0001, which is no dong at all
}
const PRICE_REQUIRED = 'price (thousands of dong) or priceVnd (dong, integer) is required';

export function createApp(db) {
  const q = {
    list: db.prepare('SELECT id, name, price_vnd FROM menu_items ORDER BY id LIMIT ? OFFSET ?'),
    get: db.prepare('SELECT id, name, price_vnd FROM menu_items WHERE id = ?'),
    insert: db.prepare('INSERT INTO menu_items (name, price_vnd) VALUES (?, ?)'),
    setPrice: db.prepare('UPDATE menu_items SET price_vnd = ? WHERE id = ?'),
    insertOrder: db.prepare("INSERT INTO orders (created_at) VALUES (datetime('now'))"),
    insertLine: db.prepare('INSERT INTO order_items (order_id, menu_item_id, qty, unit_price) VALUES (?, ?, ?, ?)'),
  };

  // Old clients keep reading price in thousands: it is derived here, at the edge.
  const view = (row) => ({
    id: row.id, name: row.name,
    price: row.price_vnd === null ? null : row.price_vnd / 1000,
    priceVnd: row.price_vnd,
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, version: VERSION });

    if (parts[0] === 'menu' && parts.length === 1) {
      if (req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        return json(res, 200, q.list.all(limit, offset).map(view));
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const vnd = body && priceVndOf(body);
        if (!body || typeof body.name !== 'string' || !body.name || !vnd)
          return error(res, 400, 'invalid_body', `name (string) and ${PRICE_REQUIRED}`);
        const { lastInsertRowid } = q.insert.run(body.name, vnd);
        return json(res, 201, view(q.get.get(lastInsertRowid)));
      }
    }

    if (parts[0] === 'menu' && parts.length === 2) {
      const id = Number(parts[1]);
      const row = Number.isInteger(id) ? q.get.get(id) : undefined;
      if (!row) return error(res, 404, 'not_found', `menu item ${parts[1]} not found`);
      if (req.method === 'GET') return json(res, 200, view(row));
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const vnd = body && priceVndOf(body);
        if (!vnd) return error(res, 400, 'invalid_body', PRICE_REQUIRED);
        q.setPrice.run(vnd, id);
        return json(res, 200, view(q.get.get(id)));
      }
    }

    if (req.method === 'POST' && url.pathname === '/orders') {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.items) || body.items.length === 0)
        return error(res, 400, 'invalid_body', 'items: [{menuItemId, qty}] is required');
      db.exec('BEGIN IMMEDIATE');
      try {
        const { lastInsertRowid: orderId } = q.insertOrder.run();
        let totalVnd = 0; // integer dong: no float drift however many lines
        for (const { menuItemId, qty } of body.items) {
          const item = q.get.get(menuItemId);
          if (!item || !Number.isInteger(qty) || qty < 1) throw Object.assign(new Error(), { status: 400 });
          q.insertLine.run(orderId, item.id, qty, item.price_vnd / 1000); // unit_price keeps its old unit
          totalVnd += item.price_vnd * qty;
        }
        db.exec('COMMIT');
        return json(res, 201, { id: Number(orderId), total: totalVnd / 1000 });
      } catch (e) {
        db.exec('ROLLBACK');
        if (e.status === 400) return error(res, 400, 'invalid_item', 'unknown menuItemId or bad qty');
        throw e;
      }
    }

    return error(res, 404, 'not_found', 'no such route');
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) error(res, 500, 'internal', e.message);
    });
  });
}
