/**
 * Product Tracker – Google Apps Script backend
 *
 * Deploy as a Web App (Execute as: Me, Who has access: Anyone).
 * Configure in Project Settings → Script properties:
 *   APP_USERNAME   login username
 *   APP_PASSWORD   login password
 *   SPREADSHEET_ID (optional) only needed if this script is NOT bound to the sheet
 *   TOKEN_SECRET   (optional) auto-generated on first use
 *
 * All requests are POST with a JSON body (sent as text/plain to avoid CORS preflight):
 *   { action, token, ...payload }
 * All responses: { ok: true, data } or { ok: false, error }
 *
 * COLUMNS ARE MATCHED BY HEADER NAME, NOT BY POSITION.
 *  - Any column from COLUMNS that is missing in row 1 is appended at the end of the header row
 *    (this is how an existing sheet gets the new Customer columns without touching its data).
 *  - You can reorder the sheet's columns freely, and add your own extra columns; the app keeps them intact.
 *  - Do not rename the headers the app uses (a renamed header is treated as a missing column).
 */

const SHEET_NAME = 'Items';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// textFormat: column is stored as plain text (keeps leading zeros in phone numbers/codes and
// stops text such as "=1+1" from being turned into a formula).
const COLUMNS = [
  { key: 'id',                 header: 'ID',                          type: 'text', textFormat: true },
  { key: 'date',               header: 'Date',                        type: 'text', textFormat: true },
  { key: 'productCode',        header: 'Product Code',                type: 'text', textFormat: true },
  { key: 'productName',        header: 'Product Name',                type: 'text', textFormat: true },
  { key: 'productBrand',       header: 'Product Brand',               type: 'text', textFormat: true },
  { key: 'unitPrice',          header: 'Unit Price (THB)',            type: 'num' },
  { key: 'quantity',           header: 'Quantity',                    type: 'num' },
  { key: 'totalPriceThb',      header: 'Total Price (THB)',           type: 'num' },
  { key: 'rate',               header: 'Rate',                        type: 'num' },
  { key: 'totalPriceMmk',      header: 'Total Price (MMK)',           type: 'num' },
  { key: 'unitSellingPrice',   header: 'Unit Selling Price (MMK)',    type: 'num' },
  { key: 'sellingPrice',       header: 'Selling Price (MMK)',         type: 'num' },   // = Unit Selling Price x Quantity (computed by the server)
  { key: 'netAmount',          header: 'Net Amount (MMK)',            type: 'num' },
  { key: 'additionalCost',     header: 'Additional Cost (MMK)',       type: 'num' },
  { key: 'additionalDiscount', header: 'Additional Discount (MMK)',   type: 'num' },
  { key: 'calcTotalCost',      header: 'Calculated Total Cost (MMK)', type: 'num' },
  { key: 'calcNetAmount',      header: 'Calculated Net Amount (MMK)', type: 'num' },
  { key: 'remark',             header: 'Remark',                      type: 'text', textFormat: true },
  { key: 'customerName',       header: 'Customer Name',               type: 'text', textFormat: true },
  { key: 'customerPhone',      header: 'Customer Phone',              type: 'text', textFormat: true },
  { key: 'customerAddress',    header: 'Customer Address',            type: 'text', textFormat: true },
  { key: 'createdAt',          header: 'Created At',                  type: 'text', textFormat: true },
  { key: 'updatedAt',          header: 'Updated At',                  type: 'text', textFormat: true },
];

const COL_BY_KEY = {};
const COL_BY_HEADER = {};
COLUMNS.forEach(function (c) { COL_BY_KEY[c.key] = c; COL_BY_HEADER[c.header] = c; });

const PHONE_RE = /^[0-9+()\-.,\/;\s]+$/;

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

function doGet() {
  return json_({ ok: true, data: { service: 'Product Tracker API' } });
}

function doPost(e) {
  let result;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    result = route_(req);
  } catch (err) {
    result = { ok: false, error: (err && err.message) || String(err) };
  }
  return json_(result);
}

/** Run once from the editor (optional): creates / upgrades the sheet and asks for permissions. */
function setup() {
  const o = open_();
  const filled = backfillUnitSelling_(o);
  secret_();
  Logger.log('Setup complete. Sheet "%s" is ready.%s', SHEET_NAME,
    filled ? ' Filled Unit Selling Price (MMK) for ' + filled + ' existing row(s).' : '');
}

/** Existing rows have no Unit Selling Price yet: fill it from Selling Price / Quantity. Never overwrites a value. */
function backfillUnitSelling_(o) {
  const last = o.sh.getLastRow();
  const uCol = o.layout.indexOf('unitSellingPrice');
  const sCol = o.layout.indexOf('sellingPrice');
  const qCol = o.layout.indexOf('quantity');
  if (last < 2 || uCol < 0 || sCol < 0 || qCol < 0) return 0;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const data = o.sh.getRange(2, 1, last - 1, o.layout.length).getValues();
    const out = [];
    let filled = 0;
    data.forEach(function (r) {
      const blank = r[uCol] === '' || r[uCol] === null || r[uCol] === undefined;
      const selling = Number(r[sCol]);
      const qty = Number(r[qCol]);
      if (blank && isFinite(selling) && selling > 0 && isFinite(qty) && qty > 0) {
        out.push([round4_(selling / qty)]);
        filled++;
      } else {
        out.push([r[uCol]]);
      }
    });
    if (filled) o.sh.getRange(2, uCol + 1, out.length, 1).setValues(out);
    return filled;
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

function route_(req) {
  const action = req.action;
  if (action === 'login') return login_(req.username, req.password);

  requireAuth_(req.token);

  switch (action) {
    case 'overview': return { ok: true, data: overview_(req.from, req.to) };
    case 'list':     return { ok: true, data: listItems_() };
    case 'get':      return { ok: true, data: getItem_(req.id) };
    case 'create':   return { ok: true, data: withLock_(function () { return createItem_(req.item); }) };
    case 'update':   return { ok: true, data: withLock_(function () { return updateItem_(req.id, req.item); }) };
    case 'delete':   return { ok: true, data: withLock_(function () { return deleteItem_(req.id); }) };
    default:         throw new Error('Unknown action: ' + action);
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------------ */
/* Auth (credentials live in Script Properties, never in the browser)  */
/* ------------------------------------------------------------------ */

function login_(username, password) {
  const props = PropertiesService.getScriptProperties();
  const u = props.getProperty('APP_USERNAME');
  const p = props.getProperty('APP_PASSWORD');
  if (!u || !p) throw new Error('Server credentials are not configured (set APP_USERNAME and APP_PASSWORD in Script properties).');

  const okUser = safeEqual_(String(username || ''), u);
  const okPass = safeEqual_(String(password || ''), p);
  if (!(okUser && okPass)) {
    Utilities.sleep(800); // slow down guessing
    throw new Error('Invalid username or password.');
  }
  return { ok: true, data: { token: issueToken_(u), expiresInMs: TOKEN_TTL_MS } };
}

function secret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('TOKEN_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('TOKEN_SECRET', s);
  }
  return s;
}

function sign_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret_()));
}

function issueToken_(username) {
  const payload = username + '|' + (Date.now() + TOKEN_TTL_MS);
  return Utilities.base64EncodeWebSafe(payload) + '.' + sign_(payload);
}

function requireAuth_(token) {
  const fail = function () { throw new Error('UNAUTHORIZED'); };
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) fail();
  const parts = token.split('.');
  let payload;
  try {
    payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  } catch (e) { fail(); }
  if (!safeEqual_(sign_(payload), parts[1] || '')) fail();
  const exp = Number(payload.split('|').pop());
  if (!exp || Date.now() > exp) fail();
}

function safeEqual_(a, b) {
  const x = String(a), y = String(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* Sheet access (header-driven)                                        */
/* ------------------------------------------------------------------ */

function sheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No spreadsheet found. Bind this script to a sheet or set SPREADSHEET_ID.');
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

function readHeader_(sh) {
  const lastCol = sh.getLastColumn();
  if (!lastCol) return [];
  return sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
}

/**
 * Makes sure every column the app needs exists in row 1 (appending the missing ones at the end),
 * then returns `layout`: for each sheet column, the item key it holds (or null for columns the app
 * doesn't know about, which are left untouched).
 */
function ensureLayout_(sh) {
  let header = readHeader_(sh);

  if (COLUMNS.some(function (c) { return header.indexOf(c.header) < 0; })) {
    const lock = LockService.getScriptLock();
    const alreadyHeld = lock.hasLock();
    if (!alreadyHeld) lock.waitLock(20000);
    try {
      header = readHeader_(sh); // re-read inside the lock
      const missing = COLUMNS.filter(function (c) { return header.indexOf(c.header) < 0; });
      if (missing.length) {
        const start = header.length + 1;
        const end = start + missing.length - 1;
        if (sh.getMaxColumns() < end) sh.insertColumnsAfter(sh.getMaxColumns(), end - sh.getMaxColumns());
        sh.getRange(1, start, 1, missing.length)
          .setValues([missing.map(function (c) { return c.header; })])
          .setFontWeight('bold')
          .setBackground('#eef0ff');
        sh.setFrozenRows(1);
        header = header.concat(missing.map(function (c) { return c.header; }));
        // plain-text format for text columns (new ones, and existing ones of an older sheet)
        COLUMNS.forEach(function (c) {
          const idx = header.indexOf(c.header);
          if (c.textFormat && idx >= 0) sh.getRange(1, idx + 1, sh.getMaxRows(), 1).setNumberFormat('@');
        });
      }
    } finally {
      if (!alreadyHeld) lock.releaseLock();
    }
  }

  const seen = {};
  return header.map(function (h) {
    const c = COL_BY_HEADER[h];
    if (!c || seen[c.key]) return null; // unknown or duplicate header
    seen[c.key] = true;
    return c.key;
  });
}

function open_() {
  const sh = sheet_();
  return { sh: sh, layout: ensureLayout_(sh) };
}

function rowToItem_(row, layout) {
  const item = {};
  COLUMNS.forEach(function (c) { item[c.key] = c.type === 'num' ? 0 : ''; });
  layout.forEach(function (key, i) {
    if (!key) return;
    const c = COL_BY_KEY[key];
    let v = row[i];
    if (c.type === 'num') {
      v = (v === '' || v === null || v === undefined) ? 0 : (Number(v) || 0);
    } else if (v instanceof Date) {
      v = Utilities.formatDate(v, Session.getScriptTimeZone(), c.key === 'date' ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm:ss");
    } else {
      v = (v === null || v === undefined) ? '' : String(v);
    }
    item[key] = v;
  });
  // Rows saved before "Unit Selling Price" existed have it blank: derive it so editing such a row
  // keeps its Selling Price unchanged (4 decimals, because Selling Price is rounded to 2).
  if (!item.unitSellingPrice && item.sellingPrice > 0 && item.quantity > 0) {
    item.unitSellingPrice = round4_(item.sellingPrice / item.quantity);
  }
  return item;
}

/** Builds a sheet row for `item`, starting from `base` (existing row values) so unknown columns survive. */
function itemToRow_(item, layout, base) {
  const row = base ? base.slice() : new Array(layout.length).fill('');
  layout.forEach(function (key, i) {
    if (key) row[i] = item[key] === undefined ? '' : item[key];
  });
  return row;
}

function readAll_(o) {
  const last = o.sh.getLastRow();
  if (last < 2) return [];
  return o.sh.getRange(2, 1, last - 1, o.layout.length).getValues()
    .map(function (r) { return rowToItem_(r, o.layout); })
    .filter(function (i) { return i.id; });
}

function findRow_(o, id) {
  const last = o.sh.getLastRow();
  const idCol = o.layout.indexOf('id') + 1;
  if (last < 2 || !id || idCol < 1) return -1;
  const ids = o.sh.getRange(2, idCol, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* Item logic                                                          */
/* ------------------------------------------------------------------ */

function round2_(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function round4_(n) { return Math.round((n + Number.EPSILON) * 10000) / 10000; }

/** Validates input and computes every derived field on the server (source of truth). */
function build_(input) {
  input = input || {};
  const num = function (v) { const n = Number(v); return isFinite(n) ? n : 0; };

  const date = String(input.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date is required (YYYY-MM-DD).');
  const productName = String(input.productName || '').trim();
  if (!productName) throw new Error('Product name is required.');

  const customerName = String(input.customerName || '').trim();
  const customerPhone = String(input.customerPhone || '').trim();
  const customerAddress = String(input.customerAddress || '').trim();
  if (customerName.length > 150) throw new Error('Customer name is too long (max 150 characters).');
  if (customerPhone.length > 40) throw new Error('Customer phone is too long (max 40 characters).');
  if (customerPhone && !PHONE_RE.test(customerPhone)) throw new Error('Customer phone can only contain digits, spaces and + ( ) - . , / ;');
  if (customerAddress.length > 500) throw new Error('Customer address is too long (max 500 characters).');

  const unitPrice = num(input.unitPrice);
  const quantity = num(input.quantity);
  const rate = num(input.rate);
  const hasUnitSelling = input.unitSellingPrice !== undefined && input.unitSellingPrice !== null && input.unitSellingPrice !== '';
  // Older clients sent a total `sellingPrice`; accept it by turning it into a unit price.
  const unitSellingPrice = round4_(hasUnitSelling ? num(input.unitSellingPrice) : (quantity > 0 ? num(input.sellingPrice) / quantity : 0));
  const additionalCost = num(input.additionalCost);
  const additionalDiscount = num(input.additionalDiscount);

  if (unitPrice < 0) throw new Error('Unit price cannot be negative.');
  if (quantity <= 0) throw new Error('Quantity must be greater than 0.');
  if (rate <= 0) throw new Error('Rate must be greater than 0.');
  if (unitSellingPrice < 0) throw new Error('Unit selling price cannot be negative.');
  if (additionalCost < 0 || additionalDiscount < 0) throw new Error('Additional cost/discount cannot be negative.');

  const sellingPrice = round2_(unitSellingPrice * quantity);
  const totalPriceThb = round2_(unitPrice * quantity);
  const totalPriceMmk = round2_(totalPriceThb * rate);
  const netAmount = round2_(sellingPrice - totalPriceMmk);
  const calcTotalCost = round2_(totalPriceMmk + additionalCost);
  const calcNetAmount = round2_(sellingPrice + additionalDiscount - calcTotalCost);

  return {
    date: date,
    productCode: String(input.productCode || '').trim(),
    productName: productName,
    productBrand: String(input.productBrand || '').trim(),
    unitPrice: unitPrice,
    quantity: quantity,
    totalPriceThb: totalPriceThb,
    rate: rate,
    totalPriceMmk: totalPriceMmk,
    unitSellingPrice: unitSellingPrice,
    sellingPrice: sellingPrice,
    netAmount: netAmount,
    additionalCost: additionalCost,
    additionalDiscount: additionalDiscount,
    calcTotalCost: calcTotalCost,
    calcNetAmount: calcNetAmount,
    remark: String(input.remark || '').trim(),
    customerName: customerName,
    customerPhone: customerPhone,
    customerAddress: customerAddress,
  };
}

function listItems_() {
  return readAll_(open_()).sort(function (a, b) {
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0; // newest first
  });
}

function getItem_(id) {
  const o = open_();
  const row = findRow_(o, id);
  if (row < 0) throw new Error('Item not found.');
  return rowToItem_(o.sh.getRange(row, 1, 1, o.layout.length).getValues()[0], o.layout);
}

function createItem_(input) {
  const o = open_();
  const item = build_(input);
  const now = new Date().toISOString();
  item.id = Utilities.getUuid();
  item.createdAt = now;
  item.updatedAt = now;
  o.sh.appendRow(itemToRow_(item, o.layout));
  return item;
}

function updateItem_(id, input) {
  const o = open_();
  const row = findRow_(o, id);
  if (row < 0) throw new Error('Item not found.');
  const current = o.sh.getRange(row, 1, 1, o.layout.length).getValues()[0];
  const existing = rowToItem_(current, o.layout);
  const item = build_(input);
  item.id = existing.id;
  item.createdAt = existing.createdAt;
  item.updatedAt = new Date().toISOString();
  o.sh.getRange(row, 1, 1, o.layout.length).setValues([itemToRow_(item, o.layout, current)]);
  return item;
}

function deleteItem_(id) {
  const o = open_();
  const row = findRow_(o, id);
  if (row < 0) throw new Error('Item not found.');
  o.sh.deleteRow(row);
  return { id: id };
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function dateParam_(v, label) {
  v = String(v === undefined || v === null ? '' : v).trim();
  if (!v) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(label + ' date is invalid (use YYYY-MM-DD).');
  return v;
}

function topBy_(items, key, blankLabel) {
  const map = new Map();
  items.forEach(function (i) {
    const raw = String(i[key] || '').trim();
    const k = raw.toLowerCase();
    if (!map.has(k)) map.set(k, { name: raw || blankLabel, quantity: 0 });
    map.get(k).quantity += i.quantity;
  });
  return Array.from(map.values())
    .sort(function (a, b) { return b.quantity - a.quantity; })
    .slice(0, 5)
    .map(function (r) { return { name: r.name, quantity: round2_(r.quantity) }; });
}

/** `from` / `to` (YYYY-MM-DD, both optional, both inclusive) filter on the item's Date field. */
function overview_(from, to) {
  from = dateParam_(from, 'From');
  to = dateParam_(to, 'To');
  if (from && to && from > to) throw new Error('From date must be on or before To date.');

  const items = readAll_(open_()).filter(function (i) {
    return (!from || i.date >= from) && (!to || i.date <= to);
  });
  const sum = function (key) {
    return round2_(items.reduce(function (a, i) { return a + (i[key] || 0); }, 0));
  };
  const totalPriceMmk = sum('totalPriceMmk');
  const totalSellingPrice = sum('sellingPrice');
  return {
    from: from,
    to: to,
    itemCount: items.length,
    totalQuantity: sum('quantity'),
    totalPriceThb: sum('totalPriceThb'),
    totalPriceMmk: totalPriceMmk,
    totalSellingPrice: totalSellingPrice,
    totalNetAmount: round2_(totalSellingPrice - totalPriceMmk),
    totalCalcNetAmount: sum('calcNetAmount'),
    topProductNames: topBy_(items, 'productName', '(Unnamed)'),
    topProductBrands: topBy_(items, 'productBrand', '(No brand)'),
  };
}