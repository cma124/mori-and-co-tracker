// Runs Code.gs against in-memory stubs of the Apps Script / Sheets APIs.
const vm = require('vm');
const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');

const CODE = fs.readFileSync(__dirname + '/Code.gs', 'utf8');

function createEnv(initialRows) {
  const rows = (initialRows || []).map(r => r.slice());
  let maxCols = 26;
  const fmts = {};               // 1-based column -> number format applied to header row..end
  const props = { APP_USERNAME: 'admin', APP_PASSWORD: 's3cret' };

  const setCell = (r, c, v) => {
    const row = rows[r] = rows[r] || [];
    while (row.length < c) row.push('');
    row[c] = v;
  };
  const range = (r, c, nr, nc) => {
    const self = {
      getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const src = rows[r - 1 + i] || []; const line = []; for (let j = 0; j < nc; j++) line.push(src[c - 1 + j] === undefined ? '' : src[c - 1 + j]); out.push(line); } return out; },
      setValues: (v) => { v.forEach((row, i) => row.forEach((x, j) => setCell(r - 1 + i, c - 1 + j, x))); return self; },
      setNumberFormat: (f) => { if (r === 1 && nr > 1) for (let j = 0; j < nc; j++) fmts[c + j] = f; return self; },
    };
    ['setFontWeight', 'setBackground'].forEach(m => self[m] = () => self);
    return self;
  };
  const sheet = {
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((m, r) => Math.max(m, r.length), 0),
    getMaxRows: () => 1000,
    getMaxColumns: () => maxCols,
    insertColumnsAfter: (pos, n) => { maxCols += n; },
    getRange: range,
    setFrozenRows: () => {},
    appendRow: (arr) => rows.push(arr.slice()),
    deleteRow: (n) => rows.splice(n - 1, 1),
  };
  const ss = { getSheetByName: () => sheet, insertSheet: () => sheet };

  const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  let held = false;
  const ctx = {
    console, Date, Math, Number, JSON, String, Map, Array, Object, isFinite, RegExp,
    Logger: { log: console.log },
    Session: { getScriptTimeZone: () => 'Asia/Bangkok' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => props[k] = v }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss },
    LockService: { getScriptLock: () => ({ hasLock: () => held, waitLock() { if (held) throw new Error('lock already held'); held = true; }, releaseLock() { held = false; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      sleep() {},
      computeHmacSha256Signature: (p, k) => [...crypto.createHmac('sha256', k).update(p).digest()],
      base64EncodeWebSafe: (x) => b64(typeof x === 'string' ? Buffer.from(x) : Buffer.from(x)),
      base64DecodeWebSafe: (s) => [...Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')],
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString() }),
      formatDate: () => 'x',
    },
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);

  const call = (body) => JSON.parse(vm.runInContext('doPost(' + JSON.stringify({ postData: { contents: JSON.stringify(body) } }) + ').getContent()', ctx));
  const login = call({ action: 'login', username: 'admin', password: 's3cret' });
  return { rows, fmts, call, token: login.data.token, login, run: (code) => vm.runInContext(code, ctx) };
}

const base = { date: '2026-10-09', productCode: '00123', productName: 'Shampoo', productBrand: 'Sunsilk', unitPrice: 50, quantity: 10, rate: 125, unitSellingPrice: 10000, additionalCost: 5000, additionalDiscount: 1000 };

/* ================================================================== */
/* 1. Fresh sheet                                                      */
/* ================================================================== */
{
  const env = createEnv();
  const { call, token, rows } = env;

  // auth
  assert.strictEqual(call({ action: 'list' }).error, 'UNAUTHORIZED');
  assert.strictEqual(call({ action: 'login', username: 'admin', password: 'bad' }).ok, false);
  assert.ok(env.login.ok && token);
  assert.strictEqual(call({ action: 'list', token: token + 'x' }).error, 'UNAUTHORIZED');

  // validation
  const bad = (o) => call({ action: 'create', token, item: Object.assign({}, base, o) });
  assert.ok(!bad({ productName: '' }).ok);
  assert.ok(!bad({ quantity: 0 }).ok);
  assert.ok(!bad({ rate: 0 }).ok);
  assert.ok(!bad({ rate: '' }).ok);
  assert.match(bad({ customerPhone: 'call me' }).error, /phone/i);
  assert.match(bad({ customerName: 'x'.repeat(151) }).error, /too long/);
  assert.match(bad({ customerAddress: 'x'.repeat(501) }).error, /too long/);
  assert.strictEqual(rows.length, 1, 'only header row written so far (failed creates add nothing)');

  // header created with all 23 columns, text-format on text columns incl. phone
  const header = rows[0];
  assert.strictEqual(header.length, 23);
  assert.ok(header.includes('Unit Selling Price (MMK)'));
  assert.ok(header.includes('Customer Name') && header.includes('Customer Phone') && header.includes('Customer Address'));
  assert.strictEqual(env.fmts[header.indexOf('Customer Phone') + 1], '@');
  assert.strictEqual(env.fmts[header.indexOf('Date') + 1], '@');

  // create + computed fields + customer fields
  const mk = (o) => call({ action: 'create', token, item: Object.assign({}, base, o) });
  const a = mk({ customerName: 'Aye Aye', customerPhone: '09 123 456 789', customerAddress: 'No. 5, Yangon' });
  assert.ok(a.ok, JSON.stringify(a));
  assert.strictEqual(a.data.unitSellingPrice, 10000);
  assert.strictEqual(a.data.sellingPrice, 100000, 'selling price = unit selling price x quantity');
  assert.strictEqual(a.data.totalPriceThb, 500);
  assert.strictEqual(a.data.totalPriceMmk, 62500);
  assert.strictEqual(a.data.netAmount, 37500);
  assert.strictEqual(a.data.calcTotalCost, 67500);
  assert.strictEqual(a.data.calcNetAmount, 33500);
  assert.strictEqual(a.data.customerName, 'Aye Aye');
  assert.strictEqual(a.data.customerPhone, '09 123 456 789');
  assert.strictEqual(a.data.customerAddress, 'No. 5, Yangon');
  assert.strictEqual(rows[1][header.indexOf('Customer Phone')], '09 123 456 789');

  // unit selling price rules
  assert.match(bad({ unitSellingPrice: -1 }).error, /unit selling price/i);
  const tiny = mk({ unitSellingPrice: 0.1, quantity: 3, date: '2026-10-09' });
  assert.strictEqual(tiny.data.sellingPrice, 0.3, 'no floating point noise');
  const third = mk({ unitSellingPrice: 33333.3333, quantity: 3, date: '2026-10-09' });
  assert.strictEqual(third.data.sellingPrice, 100000, 'a derived 4-decimal unit price round-trips to the original total');
  const noPrice = mk({ unitSellingPrice: '', quantity: 2, date: '2026-10-09' });
  assert.strictEqual(noPrice.data.sellingPrice, 0, 'blank unit selling price = 0');
  const { unitSellingPrice: _drop, ...legacyBase } = base;
  const legacy = call({ action: 'create', token, item: Object.assign({}, legacyBase, { sellingPrice: 90000, date: '2026-10-09' }) });
  assert.ok(legacy.ok, JSON.stringify(legacy));
  assert.strictEqual(legacy.data.unitSellingPrice, 9000, 'older clients sending a total selling price still work');
  assert.strictEqual(legacy.data.sellingPrice, 90000);
  for (const x of [tiny, third, noPrice, legacy]) assert.ok(call({ action: 'delete', token, id: x.data.id }).ok);

  const b = mk({ date: '2026-10-05', productName: 'shampoo ', productBrand: 'Dove', quantity: 5, unitSellingPrice: 0 });
  const c = mk({ date: '2026-10-01', productName: 'Soap', productBrand: 'dove', quantity: 3, customerName: 'Mg Mg', customerPhone: '+95 9 1234' });

  // get / list order (createdAt desc)
  assert.strictEqual(call({ action: 'get', token, id: a.data.id }).data.customerAddress, 'No. 5, Yangon');
  const list = call({ action: 'list', token }).data;
  assert.strictEqual(list.length, 3);
  assert.ok(list[0].createdAt >= list[1].createdAt && list[1].createdAt >= list[2].createdAt);

  // update keeps id/createdAt, changes customer fields; blank customer fields are allowed
  const u = call({ action: 'update', token, id: a.data.id, item: Object.assign({}, a.data, { quantity: 20, customerPhone: '' }) });
  assert.ok(u.ok, JSON.stringify(u));
  assert.strictEqual(u.data.totalPriceThb, 1000);
  assert.strictEqual(u.data.sellingPrice, 200000, 'selling price follows the new quantity');
  assert.strictEqual(u.data.unitSellingPrice, 10000);
  assert.strictEqual(u.data.customerPhone, '');
  assert.strictEqual(u.data.createdAt, a.data.createdAt);
  assert.strictEqual(u.data.id, a.data.id);

  // overview (no filter)
  const ov = call({ action: 'overview', token }).data;
  assert.strictEqual(ov.itemCount, 3);
  assert.strictEqual(ov.topProductNames[0].name, 'Shampoo');   // 20 + 5 merged case-insensitively
  assert.strictEqual(ov.topProductNames[0].quantity, 25);
  assert.strictEqual(ov.topProductBrands[0].name, 'Sunsilk');
  assert.strictEqual(ov.topProductBrands[1].quantity, 8);      // Dove 5 + dove 3
  assert.strictEqual(ov.totalNetAmount, ov.totalSellingPrice - ov.totalPriceMmk);

  // overview date filters (inclusive): items dated 2026-10-09 (a), 2026-10-05 (b), 2026-10-01 (c)
  const f = (from, to) => call({ action: 'overview', token, from, to });
  assert.strictEqual(f('2026-10-02', undefined).data.itemCount, 2);          // from only
  assert.strictEqual(f(undefined, '2026-10-05').data.itemCount, 2);          // to only, inclusive
  assert.strictEqual(f('2026-10-05', '2026-10-05').data.itemCount, 1);       // single day
  assert.strictEqual(f('2026-10-01', '2026-10-09').data.itemCount, 3);
  assert.strictEqual(f('2026-11-01', '2026-11-30').data.itemCount, 0);       // empty range -> zeros, not an error
  assert.strictEqual(f('2026-11-01', '2026-11-30').data.totalSellingPrice, 0);
  assert.deepStrictEqual(f('2026-11-01', '2026-11-30').data.topProductNames, []);
  assert.strictEqual(f('', '').data.itemCount, 3);                           // blank = no filter
  const only = f('2026-10-02', '2026-10-06').data;                           // just b (Shampoo/Dove qty 5)
  assert.strictEqual(only.topProductNames[0].quantity, 5);
  assert.strictEqual(only.totalSellingPrice, 0);
  assert.match(f('2026-10-09', '2026-10-01').error, /on or before/);
  assert.match(f('10/09/2026', undefined).error, /invalid/i);

  // delete
  assert.ok(call({ action: 'delete', token, id: b.data.id }).ok);
  assert.strictEqual(call({ action: 'list', token }).data.length, 2);
  assert.ok(!call({ action: 'get', token, id: b.data.id }).ok);
}

/* ================================================================== */
/* 2. Upgrading an EXISTING sheet (old 19-column layout with data)      */
/* ================================================================== */
{
  const oldHeader = ['ID', 'Date', 'Product Code', 'Product Name', 'Product Brand', 'Unit Price (THB)', 'Quantity', 'Total Price (THB)', 'Rate', 'Total Price (MMK)', 'Selling Price (MMK)', 'Net Amount (MMK)', 'Additional Cost (MMK)', 'Additional Discount (MMK)', 'Calculated Total Cost (MMK)', 'Calculated Net Amount (MMK)', 'Remark', 'Created At', 'Updated At'];
  const oldRow1 = ['old-1', '2026-09-01', 'C1', 'Old Product', 'Old Brand', 10, 2, 20, 125, 2500, 4000, 1500, 0, 0, 2500, 1500, 'old note', '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z'];
  const oldRow2 = ['old-2', '2026-09-02', '007', 'Other', '', 5, 1, 5, 130, 650, 900, 250, 0, 0, 650, 250, '', '2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.000Z'];
  const env = createEnv([oldHeader, oldRow1, oldRow2]);
  const { call, token, rows } = env;

  const list = call({ action: 'list', token });
  assert.ok(list.ok, JSON.stringify(list));
  assert.strictEqual(rows[0].length, 23, 'unit selling price + three customer columns appended');
  assert.deepStrictEqual(rows[0].slice(19), ['Unit Selling Price (MMK)', 'Customer Name', 'Customer Phone', 'Customer Address']);
  assert.deepStrictEqual(rows[0].slice(0, 19), oldHeader, 'existing header untouched');
  assert.deepStrictEqual(rows[1].slice(0, 19), oldRow1, 'existing data untouched');
  assert.strictEqual(env.fmts[22], '@', 'phone column is plain text');
  const old = list.data.find(i => i.id === 'old-1');
  assert.strictEqual(old.productName, 'Old Product');
  assert.strictEqual(old.sellingPrice, 4000);
  assert.strictEqual(old.unitSellingPrice, 2000, 'old rows get a derived unit selling price (4000 / 2)');
  assert.strictEqual(list.data.find(i => i.id === 'old-2').unitSellingPrice, 900);
  assert.strictEqual(old.customerName, '');
  assert.strictEqual(list.data.find(i => i.id === 'old-2').productCode, '007');

  // second call does not add columns again
  call({ action: 'list', token });
  assert.strictEqual(rows[0].length, 23);

  // new item lands in the right cells (customer columns at the end)
  const n = call({ action: 'create', token, item: Object.assign({}, base, { customerName: 'New Cust', customerPhone: '0912345678', customerAddress: 'Mandalay' }) });
  assert.ok(n.ok, JSON.stringify(n));
  const last = rows[rows.length - 1];
  assert.strictEqual(last[19], 10000);          // unit selling price
  assert.strictEqual(last[20], 'New Cust');
  assert.strictEqual(last[21], '0912345678');   // leading zero kept
  assert.strictEqual(last[22], 'Mandalay');
  assert.strictEqual(last[10], 100000);         // selling price (total) in its original column
  assert.strictEqual(last[17], n.data.createdAt);

  // editing an OLD item adds customer info without disturbing the rest
  const e = call({ action: 'update', token, id: 'old-1', item: Object.assign({}, old, { customerName: 'Late Cust' }) });
  assert.ok(e.ok, JSON.stringify(e));
  assert.strictEqual(rows[1][20], 'Late Cust');
  assert.strictEqual(rows[1][10], 4000, 'selling price of an old row is unchanged by editing it');
  assert.strictEqual(rows[1][19], 2000);
  assert.strictEqual(rows[1][3], 'Old Product');
  assert.strictEqual(rows[1][17], '2026-09-01T10:00:00.000Z', 'createdAt preserved');

  // user adds their own column + drags columns around: app keeps working and keeps their data
  rows[0].push('My Notes'); rows[1].push('keep me'); rows[2].push('me too');
  const swap = (i, j) => rows.forEach(r => { const t = r[i]; r[i] = r[j]; r[j] = t; });
  swap(1, 3);                                   // Date <-> Product Name columns
  const reordered = call({ action: 'list', token }).data;
  assert.strictEqual(reordered.find(i => i.id === 'old-1').productName, 'Old Product');
  assert.strictEqual(reordered.find(i => i.id === 'old-1').date, '2026-09-01');
  assert.strictEqual(rows[0].length, 24, 'extra user column not duplicated or removed');
  const e2 = call({ action: 'update', token, id: 'old-1', item: Object.assign({}, old, { productName: 'Renamed' }) });
  assert.ok(e2.ok, JSON.stringify(e2));
  assert.strictEqual(rows[1][23], 'keep me', 'unknown column preserved on update');
  assert.strictEqual(call({ action: 'get', token, id: 'old-1' }).data.productName, 'Renamed');
  assert.ok(call({ action: 'delete', token, id: 'old-2' }).ok);
  assert.strictEqual(call({ action: 'list', token }).data.length, 2);
}

/* ================================================================== */
/* 3. setup() back-fills Unit Selling Price on existing rows           */
/* ================================================================== */
{
  const oldHeader = ['ID', 'Date', 'Product Code', 'Product Name', 'Product Brand', 'Unit Price (THB)', 'Quantity', 'Total Price (THB)', 'Rate', 'Total Price (MMK)', 'Selling Price (MMK)', 'Net Amount (MMK)', 'Additional Cost (MMK)', 'Additional Discount (MMK)', 'Calculated Total Cost (MMK)', 'Calculated Net Amount (MMK)', 'Remark', 'Created At', 'Updated At'];
  const r = (id, qty, sell) => [id, '2026-09-01', '', 'P' + id, '', 10, qty, 10 * qty, 125, 1250 * qty, sell, 0, 0, 0, 0, 0, '', '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z'];
  const env = createEnv([oldHeader, r('a', 3, 100000), r('b', 2, 0), r('c', 4, 8000)]);
  env.run('setup()');
  const col = env.rows[0].indexOf('Unit Selling Price (MMK)');
  assert.ok(col >= 0);
  assert.strictEqual(env.rows[1][col], 33333.3333);
  assert.strictEqual(env.rows[2][col], '', 'zero selling price: left blank');
  assert.strictEqual(env.rows[3][col], 2000);
  assert.strictEqual(env.rows[1][10], 100000, 'selling price itself untouched');
  // never overwrites a value someone typed; running again changes nothing
  env.rows[3][col] = 1234;
  env.run('setup()');
  assert.strictEqual(env.rows[3][col], 1234);
  assert.strictEqual(env.rows[1][col], 33333.3333);
  assert.strictEqual(env.call({ action: 'get', token: env.token, id: 'a' }).data.sellingPrice, 100000);
}

console.log('All backend checks passed.');