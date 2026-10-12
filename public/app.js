(function () {
  'use strict';

  /* ================================================================ */
  /* Setup & helpers                                                   */
  /* ================================================================ */

  var CFG = window.APP_CONFIG || {};
  var TOKEN_KEY = 'pt_token';
  var RATE_KEY = 'pt_last_rate';
  var PHONE_RE = /^[0-9+()\-.,\/;\s]+$/;
  var app = document.getElementById('app');
  var state = {
    items: null,
    // Filters live in memory for the session, so coming back from a detail page keeps your date range.
    // Both pages start on the current month (1st to last day); "All time" clears the dates.
    filters: {
      overview: presetRange('month'),
      items: Object.assign(presetRange('month'), { q: '' }),
    },
  };
  var navId = 0;

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmt(v, minD, maxD) {
    return Number(v || 0).toLocaleString('en-US', {
      minimumFractionDigits: minD === undefined ? 0 : minD,
      maximumFractionDigits: maxD === undefined ? 2 : maxD,
    });
  }

  function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function netClass(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : ''; }

  /* ---------- dates (all dates are plain YYYY-MM-DD strings, compared as text) ---------- */

  function p2(x) { return String(x).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function today() { return ymd(new Date()); }

  // Display format for dates: DD-MM-YYYY. Stored/API values stay YYYY-MM-DD.
  function niceDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return s || '';
    return m[3] + '-' + m[2] + '-' + m[1];
  }

  // Overview keeps the original wording style, e.g. "01 Oct 2026".
  function longDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return s || '';
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function rangeLabel(f, fmt) {
    fmt = fmt || niceDate;
    if (!f.from && !f.to) return 'All dates';
    if (f.from && f.to) return fmt(f.from) + ' – ' + fmt(f.to);
    return f.from ? 'From ' + fmt(f.from) : 'Up to ' + fmt(f.to);
  }

  function presetRange(name) {
    var d = new Date();
    if (name === 'month') {
      return { from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), to: ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
    }
    if (name === '30d') {
      var s = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 29);
      return { from: ymd(s), to: today() };
    }
    return { from: '', to: '' };
  }

  var ICON_PATHS = {
    view: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
    back: '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>',
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON_PATHS[name] + '</svg>';
  }

  function toast(msg, isError) {
    var host = document.getElementById('toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function () { el.remove(); }, 3200);
  }

  /* ================================================================ */
  /* API                                                               */
  /* ================================================================ */

  function getToken() { return store.get(TOKEN_KEY); }

  function api(action, payload) {
    if (!CFG.API_URL) {
      return Promise.reject(new Error('API_URL is not set in config.js.'));
    }
    var body = Object.assign({ action: action, token: getToken() || undefined }, payload || {});
    return fetch(CFG.API_URL, {
      method: 'POST',
      // text/plain keeps this a "simple" request so the browser skips the CORS preflight Apps Script can't answer
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
    })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        if (json.ok) return json.data;
        if (json.error === 'UNAUTHORIZED') {
          store.del(TOKEN_KEY);
          state.items = null;
          location.hash = '#/login';
          throw new Error('Your session expired. Please sign in again.');
        }
        throw new Error(json.error || 'Request failed.');
      })
      .catch(function (err) {
        if (err instanceof TypeError) throw new Error('Could not reach the server. Check your connection and try again.');
        throw err;
      });
  }

  function getItems(force) {
    if (state.items && !force) return Promise.resolve(state.items);
    return api('list').then(function (items) { state.items = items; return items; });
  }

  /* ================================================================ */
  /* Shell                                                             */
  /* ================================================================ */

  function shell(active, inner) {
    app.innerHTML =
      '<header class="topbar"><div class="topbar-inner">' +
        '<a class="brand" href="#/overview" aria-label="Mori &amp; Co. – Overview">' +
          '<img class="brand-logo" src="logo-small.png" width="42" height="42" alt="">' +
          '<span class="brand-text"><b>MORI &amp; CO.</b><small>Everyday Essentials</small></span></a>' +
        '<nav>' +
          '<a href="#/overview" class="' + (active === 'overview' ? 'active' : '') + '">Overview</a>' +
          '<a href="#/items" class="' + (active === 'items' ? 'active' : '') + '">Items</a>' +
        '</nav>' +
        '<div class="topbar-actions">' +
          '<a class="btn btn-primary btn-sm" href="#/items/new">' + icon('plus') + '<span>New item</span></a>' +
          '<button class="btn btn-ghost btn-sm" id="logout-btn" type="button">' + icon('logout') + '<span>Sign out</span></button>' +
        '</div>' +
      '</div></header>' +
      '<main class="container" id="page">' + inner + '</main>';
    document.getElementById('logout-btn').onclick = logout;
  }

  function loadingHtml() { return '<div class="loading"><div class="spinner"></div>Loading…</div>'; }
  function errorHtml(msg) { return '<div class="alert" role="alert">' + esc(msg) + '</div>'; }

  function logout() {
    store.del(TOKEN_KEY);
    state.items = null;
    location.hash = '#/login';
  }

  /* ================================================================ */
  /* Date filter bar (shared by Overview and Items)                    */
  /* ================================================================ */

  function filterBarHtml(key, withSearch) {
    var f = state.filters[key];
    return '<div class="filterbar" id="filterbar">' +
      (withSearch
        ? '<label class="search">' + icon('search') +
            '<input id="search" type="search" placeholder="Search customer, product, brand…" aria-label="Search items" value="' + esc(f.q) + '"></label>'
        : '') +
      '<label class="field"><span class="label">From</span><input type="date" id="flt-from" value="' + esc(f.from) + '"></label>' +
      '<label class="field"><span class="label">To</span><input type="date" id="flt-to" value="' + esc(f.to) + '"></label>' +
      '<div class="presets" role="group" aria-label="Quick date ranges">' +
        '<button class="btn btn-sm" type="button" data-preset="month">This month</button>' +
        '<button class="btn btn-sm" type="button" data-preset="30d">Last 30 days</button>' +
        '<button class="btn btn-sm btn-ghost" type="button" data-preset="all">All time</button>' +
      '</div>' +
      '<div class="filter-msg" id="filter-msg" role="alert"></div>' +
    '</div>';
  }

  function bindFilters(key, onChange) {
    var bar = document.getElementById('filterbar');
    var from = document.getElementById('flt-from');
    var to = document.getElementById('flt-to');
    var msg = document.getElementById('filter-msg');

    function apply() {
      if (from.value && to.value && from.value > to.value) {
        msg.textContent = '“From” must be on or before “To”.';
        return;
      }
      msg.textContent = '';
      state.filters[key].from = from.value;
      state.filters[key].to = to.value;
      onChange();
    }
    // Typing a year can fire a change on every keystroke (0002, 0020, 0202, 2026), so wait for a short pause
    var timer = null;
    function scheduleApply() { clearTimeout(timer); timer = setTimeout(apply, 350); }
    from.addEventListener('input', scheduleApply);
    from.addEventListener('change', scheduleApply);
    to.addEventListener('input', scheduleApply);
    to.addEventListener('change', scheduleApply);
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-preset]');
      if (!b) return;
      clearTimeout(timer);
      var r = presetRange(b.getAttribute('data-preset'));
      from.value = r.from; to.value = r.to;
      apply();
    });
  }

  /* ================================================================ */
  /* Login                                                             */
  /* ================================================================ */

  function loginPage() {
    app.innerHTML =
      '<div class="login-wrap"><div class="login-stack">' +
        '<img class="login-logo" src="logo.png" width="190" height="190" alt="Mori &amp; Co. – Everyday Essentials">' +
        '<div class="card login-card">' +
          '<h1>Welcome</h1>' +
          '<form id="login-form" novalidate>' +
            '<div id="login-error"></div>' +
            '<label class="field"><span class="label">Username</span><input name="username" autocomplete="username" required autofocus></label>' +
            '<label class="field"><span class="label">Password</span><input name="password" type="password" autocomplete="current-password" required></label>' +
            '<button class="btn btn-primary" type="submit">Sign in</button>' +
          '</form>' +
        '</div>' +
        '<div class="login-foot">Inventory &amp; sales</div>' +
      '</div></div>';

    var form = document.getElementById('login-form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = form.querySelector('button');
      var errBox = document.getElementById('login-error');
      var username = form.username.value.trim();
      var password = form.password.value;
      if (!username || !password) { errBox.innerHTML = errorHtml('Enter your username and password.'); return; }
      btn.disabled = true; btn.textContent = 'Signing in…'; errBox.innerHTML = '';
      api('login', { username: username, password: password })
        .then(function (data) {
          store.set(TOKEN_KEY, data.token);
          location.hash = '#/overview';
        })
        .catch(function (err) {
          errBox.innerHTML = errorHtml(err.message);
          btn.disabled = false; btn.textContent = 'Sign in';
        });
    });
  }

  /* ================================================================ */
  /* Overview                                                          */
  /* ================================================================ */

  function overviewPage(my) {
    shell('overview',
      '<div class="page-head"><div><h1>Overview</h1><div class="sub" id="sub">Summary of all products in the sheet</div></div></div>' +
      filterBarHtml('overview', false) +
      '<div id="content">' + loadingHtml() + '</div>');

    var reqId = 0;
    function load() {
      var id = ++reqId;
      var f = state.filters.overview;
      var filtered = !!(f.from || f.to);
      document.getElementById('content').innerHTML = loadingHtml();
      api('overview', { from: f.from || undefined, to: f.to || undefined }).then(function (d) {
        if (my !== navId || id !== reqId) return; // page changed or a newer request is running
        document.getElementById('sub').textContent =
          rangeLabel(f, longDate) + ' · ' + d.itemCount + (d.itemCount === 1 ? ' item' : ' items');
        document.getElementById('content').innerHTML =
          '<div class="stats">' +
            statCard('Total Price (MMK)', fmt(d.totalPriceMmk), 'MMK') +
            statCard('Total Selling Price (MMK)', fmt(d.totalSellingPrice), 'MMK') +
            statCard('Total Net Amount (MMK)', fmt(d.totalNetAmount), 'MMK', netClass(d.totalNetAmount)) +
          '</div>' +
          '<div class="stats secondary">' +
            statCard('Items', fmt(d.itemCount, 0, 0)) +
            statCard('Total quantity', fmt(d.totalQuantity)) +
            statCard('Total Price (THB)', fmt(d.totalPriceThb, 2, 2), 'THB') +
            statCard('Calculated Net (MMK)', fmt(d.totalCalcNetAmount), 'MMK', netClass(d.totalCalcNetAmount)) +
          '</div>' +
          '<div class="two-col">' +
            rankPanel('Top 5 Product Names', d.topProductNames, filtered) +
            rankPanel('Top 5 Product Brands', d.topProductBrands, filtered) +
          '</div>';
      }).catch(function (err) {
        if (my !== navId || id !== reqId) return;
        document.getElementById('content').innerHTML = errorHtml(err.message);
      });
    }

    bindFilters('overview', load);
    load();
  }

  function statCard(label, value, unit, cls) {
    return '<div class="card stat"><div class="label">' + esc(label) + '</div>' +
      '<div class="value ' + (cls || '') + '">' + esc(value) + (unit ? '<span class="unit">' + esc(unit) + '</span>' : '') + '</div></div>';
  }

  function rankPanel(title, rows, filtered) {
    var body;
    if (!rows || !rows.length) {
      body = '<div class="muted">' + (filtered ? 'No items in this date range.' : 'No data yet.') + '</div>';
    } else {
      var max = rows[0].quantity || 1;
      body = '<ol class="rank">' + rows.map(function (r, i) {
        var pct = Math.max(4, Math.round((r.quantity / max) * 100));
        return '<li><span class="n">' + (i + 1) + '</span><span class="name" title="' + esc(r.name) + '">' + esc(r.name) + '</span>' +
          '<span class="qty">' + fmt(r.quantity) + ' pcs</span><div class="bar"><span style="width:' + pct + '%"></span></div></li>';
      }).join('') + '</ol>';
    }
    return '<section class="card panel"><h2>' + esc(title) + '</h2><div class="rank-sub">Ranked by quantity</div>' + body + '</section>';
  }

  /* ================================================================ */
  /* Items (table)                                                     */
  /* ================================================================ */

  function galleryPage(my) {
    shell('items',
      '<div class="page-head"><div><h1>Items</h1><div class="sub" id="count-line"></div></div>' +
        '<div class="head-actions"><a class="btn btn-primary" href="#/items/new">' + icon('plus') + 'New item</a></div></div>' +
      filterBarHtml('items', true) +
      '<div id="totals"></div>' +
      '<div id="content">' + loadingHtml() + '</div>');

    getItems(true).then(function () {
      if (my !== navId) return;
      var f = state.filters.items;
      document.getElementById('search').addEventListener('input', function (e) {
        f.q = e.target.value;
        renderTable();
      });
      bindFilters('items', renderTable);
      document.getElementById('content').addEventListener('click', onTableClick);
      renderTable();
    }).catch(function (err) {
      if (my !== navId) return;
      document.getElementById('content').innerHTML = errorHtml(err.message);
    });
  }

  function visibleItems() {
    var f = state.filters.items;
    var q = (f.q || '').trim().toLowerCase();
    return (state.items || []).filter(function (i) {
      if (f.from && i.date < f.from) return false;
      if (f.to && i.date > f.to) return false;
      if (!q) return true;
      return [i.customerName, i.customerPhone, i.customerAddress, i.productName, i.productCode, i.productBrand, i.remark, i.date, niceDate(i.date)]
        .join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderTable() {
    var content = document.getElementById('content');
    var f = state.filters.items;
    var all = state.items || [];
    var items = visibleItems();
    var narrowed = !!(f.from || f.to || (f.q || '').trim());

    var line = narrowed ? items.length + ' of ' + all.length + ' items' : all.length + (all.length === 1 ? ' item' : ' items');
    if (f.from || f.to) line += ' · ' + rangeLabel(f, longDate);
    document.getElementById('count-line').textContent = line + ' · newest first';

    // Totals of exactly the rows listed below (date range + search applied).
    var sum = function (key) {
      return Math.round(items.reduce(function (a, i) { return a + (Number(i[key]) || 0); }, 0) * 100) / 100;
    };
    var calcNet = sum('calcNetAmount');
    document.getElementById('totals').innerHTML = all.length
      ? '<div class="stats totals" aria-label="Totals of the items listed below">' +
          statCard('Total quantity', fmt(sum('quantity'))) +
          statCard('Total Price', fmt(sum('totalPriceMmk')), 'MMK') +
          statCard('Total Selling Price', fmt(sum('sellingPrice')), 'MMK') +
          statCard('Total Net Amount', fmt(sum('netAmount')), 'MMK', netClass(sum('netAmount'))) +
          statCard('Calculated Net Amount', fmt(calcNet), 'MMK', netClass(calcNet)) +
        '</div>'
      : '';

    if (!items.length) {
      content.innerHTML = all.length
        ? '<div class="empty">No items match your filters. Try “All time” to see everything.</div>'
        : '<div class="empty"><p>No items yet.</p><a class="btn btn-primary" href="#/items/new">' + icon('plus') + 'Add your first item</a></div>';
      return;
    }

    content.innerHTML =
      '<div class="card table-wrap"><table class="items-table">' +
        '<thead><tr>' +
          '<th>Date</th><th>Customer</th><th>Product</th>' +
          '<th class="num">Qty</th><th class="num">Total Price (MMK)</th><th class="num">Selling Price (MMK)</th><th class="num">Net Amount (MMK)</th>' +
          '<th class="col-actions"><span class="sr-only">Actions</span></th>' +
        '</tr></thead><tbody>' + items.map(rowHtml).join('') + '</tbody></table></div>';
  }

  function rowHtml(it) {
    var id = encodeURIComponent(it.id);
    var sub = [it.productBrand, it.productCode].filter(Boolean).join(' · ');
    return '<tr>' +
      '<td class="col-date" data-label="Date">' + esc(niceDate(it.date)) + '</td>' +
      '<td class="col-customer" data-label="Customer">' + (it.customerName ? esc(it.customerName) : '<span class="muted">—</span>') + '</td>' +
      '<td class="col-product" data-label="Product"><a class="cell-main" href="#/items/' + id + '">' + esc(it.productName) + '</a>' +
        (sub ? '<div class="cell-sub">' + esc(sub) + '</div>' : '') + '</td>' +
      '<td class="num col-qty" data-label="Qty">' + fmt(it.quantity) + '</td>' +
      '<td class="num col-total" data-label="Total Price (MMK)">' + fmt(it.totalPriceMmk) + '</td>' +
      '<td class="num col-sell" data-label="Selling Price (MMK)">' + fmt(it.sellingPrice) + '</td>' +
      '<td class="num col-net ' + netClass(it.netAmount) + '" data-label="Net Amount (MMK)">' + fmt(it.netAmount) + '</td>' +
      '<td class="col-actions">' +
        '<a class="icon-btn" href="#/items/' + id + '" title="View" aria-label="View ' + esc(it.productName) + '">' + icon('view') + '</a>' +
        '<a class="icon-btn" href="#/items/' + id + '/edit" title="Edit" aria-label="Edit ' + esc(it.productName) + '">' + icon('edit') + '</a>' +
        '<button class="icon-btn danger" type="button" data-del="' + esc(it.id) + '" title="Delete" aria-label="Delete ' + esc(it.productName) + '">' + icon('trash') + '</button>' +
      '</td></tr>';
  }

  function onTableClick(e) {
    var btn = e.target.closest('[data-del]');
    if (!btn) return;
    var it = (state.items || []).find(function (x) { return x.id === btn.getAttribute('data-del'); });
    if (it) deleteFlow(it, renderTable);
  }

  /* ---------- Delete with confirmation ---------- */

  function confirmDelete(it) {
    return new Promise(function (resolve) {
      var prev = document.activeElement;
      var wrap = document.createElement('div');
      wrap.className = 'modal-backdrop';
      wrap.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">' +
          '<h2 id="m-title">Delete this item?</h2>' +
          '<p><strong>' + esc(it.productName) + '</strong>' + (it.productCode ? ' (' + esc(it.productCode) + ')' : '') +
          (it.customerName ? ' for ' + esc(it.customerName) : '') +
          ' will be permanently removed from the sheet. This can’t be undone.</p>' +
          '<div class="modal-actions"><button class="btn" type="button" data-act="cancel">Cancel</button>' +
          '<button class="btn btn-danger" type="button" data-act="ok">Delete</button></div>' +
        '</div>';
      document.body.appendChild(wrap);
      var cancel = wrap.querySelector('[data-act="cancel"]');
      cancel.focus();

      function close(result) {
        document.removeEventListener('keydown', onKey);
        wrap.remove();
        if (prev && prev.focus) prev.focus();
        resolve(result);
      }
      function onKey(e) { if (e.key === 'Escape') close(false); }
      document.addEventListener('keydown', onKey);
      wrap.addEventListener('click', function (e) {
        if (e.target === wrap) close(false);
        var act = e.target.closest('[data-act]');
        if (act) close(act.getAttribute('data-act') === 'ok');
      });
    });
  }

  function deleteFlow(it, after) {
    return confirmDelete(it).then(function (ok) {
      if (!ok) return;
      return api('delete', { id: it.id }).then(function () {
        if (state.items) state.items = state.items.filter(function (x) { return x.id !== it.id; });
        toast('Item deleted');
        after();
      }).catch(function (err) { toast(err.message, true); });
    });
  }

  /* ================================================================ */
  /* Create / Edit form                                                */
  /* ================================================================ */

  function field(label, name, o) {
    o = o || {};
    var type = o.type || 'text';
    var attrs = ['id="f-' + name + '"', 'name="' + name + '"', 'type="' + type + '"', 'autocomplete="off"'];
    if (o.required) attrs.push('required');
    if (type === 'number') attrs.push('step="any"', 'min="0"', 'inputmode="decimal"');
    if (type === 'tel') attrs.push('inputmode="tel"', 'maxlength="40"');
    if (o.maxlength) attrs.push('maxlength="' + o.maxlength + '"');
    if (o.list) attrs.push('list="' + o.list + '"');
    if (o.placeholder) attrs.push('placeholder="' + esc(o.placeholder) + '"');
    if (o.value !== undefined && o.value !== null) attrs.push('value="' + esc(o.value) + '"');
    return '<label class="field' + (o.wide ? ' wide' : '') + '"><span class="label">' + esc(label) +
      (o.required ? ' <em>*</em>' : '') + '</span><input ' + attrs.join(' ') + '></label>';
  }

  function outField(label, key, wide) {
    return '<div class="field computed' + (wide ? ' wide' : '') + '"><span class="label">' + esc(label) + '</span><output data-out="' + key + '">0</output></div>';
  }

  function compute(v) {
    var totalThb = r2(v.unitPrice * v.quantity);
    var totalMmk = r2(totalThb * v.rate);
    var net = r2(v.sellingPrice - totalMmk);
    var cost = r2(totalMmk + v.additionalCost);
    var cnet = r2(v.sellingPrice + v.additionalDiscount - cost);
    return { totalThb: totalThb, totalMmk: totalMmk, net: net, cost: cost, cnet: cnet };
  }

  function formPage(my, id) {
    var isEdit = !!id;
    shell('items', '<div id="content">' + loadingHtml() + '</div>');

    var load = isEdit ? api('get', { id: id }) : Promise.resolve(null);
    load.then(function (it) {
      if (my !== navId) return;
      renderForm(it, isEdit);
    }).catch(function (err) {
      if (my !== navId) return;
      document.getElementById('content').innerHTML = errorHtml(err.message) +
        '<p><a class="btn" href="#/items">' + icon('back') + 'Back to items</a></p>';
    });
  }

  function renderForm(it, isEdit) {
    var v = it || {
      date: today(), productCode: '', productName: '', productBrand: '',
      customerName: '', customerPhone: '', customerAddress: '',
      unitPrice: '', quantity: 1, rate: store.get(RATE_KEY) || '',
      sellingPrice: '', additionalCost: '', additionalDiscount: '', remark: '',
    };

    document.getElementById('content').innerHTML =
      '<div class="page-head"><div><h1>' + (isEdit ? 'Edit item' : 'New item') + '</h1>' +
        '<div class="sub">' + (isEdit ? esc(it.productName) : 'Calculated fields update as you type') + '</div></div>' +
        '<div class="head-actions"><a class="btn" href="' + (isEdit ? '#/items/' + encodeURIComponent(it.id) : '#/items') + '">' + icon('back') + 'Cancel</a></div></div>' +
      '<form id="item-form" class="form" novalidate>' +
        '<div id="form-error"></div>' +
        '<section class="card section"><h2>Product</h2><div class="fields">' +
          field('Date', 'date', { type: 'date', required: true, value: v.date }) +
          field('Product Code', 'productCode', { value: v.productCode }) +
          field('Product Name', 'productName', { required: true, list: 'dl-names', value: v.productName }) +
          field('Product Brand', 'productBrand', { list: 'dl-brands', value: v.productBrand }) +
        '</div></section>' +
        '<section class="card section"><h2>Customer</h2><div class="fields">' +
          field('Customer Name', 'customerName', { list: 'dl-customers', maxlength: 150, value: v.customerName }) +
          field('Customer Phone', 'customerPhone', { type: 'tel', placeholder: 'e.g. 09 123 456 789', value: v.customerPhone }) +
          '<label class="field wide"><span class="label">Customer Address</span>' +
            '<textarea name="customerAddress" rows="2" maxlength="500" placeholder="Optional">' + esc(v.customerAddress) + '</textarea></label>' +
        '</div></section>' +
        '<section class="card section"><h2>Purchase</h2><div class="fields">' +
          field('Unit Price (THB)', 'unitPrice', { type: 'number', required: true, value: v.unitPrice, placeholder: '0' }) +
          field('Quantity', 'quantity', { type: 'number', required: true, value: v.quantity }) +
          outField('Total Price (THB)', 'totalThb') +
          field('Rate (THB → MMK)', 'rate', { type: 'number', required: true, value: v.rate, placeholder: 'e.g. 125' }) +
          outField('Total Price (MMK)', 'totalMmk', true) +
        '</div></section>' +
        '<section class="card section"><h2>Sale</h2><div class="fields">' +
          field('Selling Price (MMK)', 'sellingPrice', { type: 'number', value: v.sellingPrice, placeholder: '0' }) +
          outField('Net Amount (MMK)', 'net') +
        '</div></section>' +
        '<section class="card section"><h2>Adjustments</h2><div class="fields">' +
          field('Additional Cost (MMK)', 'additionalCost', { type: 'number', value: v.additionalCost, placeholder: '0' }) +
          field('Additional Discount (MMK)', 'additionalDiscount', { type: 'number', value: v.additionalDiscount, placeholder: '0' }) +
          outField('Calculated Total Cost (MMK)', 'cost') +
          outField('Calculated Net Amount (MMK)', 'cnet') +
        '</div></section>' +
        '<section class="card section"><h2>Remark</h2>' +
          '<label class="field"><span class="label">Notes</span><textarea name="remark" placeholder="Optional">' + esc(v.remark) + '</textarea></label></section>' +
        '<div class="form-actions"><a class="btn" href="' + (isEdit ? '#/items/' + encodeURIComponent(it.id) : '#/items') + '">Cancel</a>' +
          '<button class="btn btn-primary" type="submit">' + (isEdit ? 'Save changes' : 'Create item') + '</button></div>' +
      '</form>' +
      '<datalist id="dl-names"></datalist><datalist id="dl-brands"></datalist><datalist id="dl-customers"></datalist>';

    var form = document.getElementById('item-form');

    function read() {
      return {
        date: form.date.value,
        productCode: form.productCode.value.trim(),
        productName: form.productName.value.trim(),
        productBrand: form.productBrand.value.trim(),
        customerName: form.customerName.value.trim(),
        customerPhone: form.customerPhone.value.trim(),
        customerAddress: form.customerAddress.value.trim(),
        unitPrice: num(form.unitPrice.value),
        quantity: num(form.quantity.value),
        rate: num(form.rate.value),
        sellingPrice: num(form.sellingPrice.value),
        additionalCost: num(form.additionalCost.value),
        additionalDiscount: num(form.additionalDiscount.value),
        remark: form.remark.value.trim(),
      };
    }

    function refresh() {
      var c = compute(read());
      var set = function (k, val, signed) {
        var el = form.querySelector('[data-out="' + k + '"]');
        el.textContent = fmt(val, 0, 2);
        if (signed) el.className = netClass(val);
      };
      set('totalThb', c.totalThb); set('totalMmk', c.totalMmk);
      set('net', c.net, true); set('cost', c.cost); set('cnet', c.cnet, true);
    }
    form.addEventListener('input', refresh);
    refresh();

    // Autocomplete lists from existing items (non-blocking)
    getItems().then(function (items) {
      var uniq = function (key) {
        var seen = {}; var out = [];
        items.forEach(function (i) { var s = (i[key] || '').trim(); if (s && !seen[s.toLowerCase()]) { seen[s.toLowerCase()] = 1; out.push(s); } });
        return out.sort();
      };
      var opts = function (arr) { return arr.map(function (s) { return '<option value="' + esc(s) + '">'; }).join(''); };
      var n = document.getElementById('dl-names'), b = document.getElementById('dl-brands'), c = document.getElementById('dl-customers');
      if (n) n.innerHTML = opts(uniq('productName'));
      if (b) b.innerHTML = opts(uniq('productBrand'));
      if (c) c.innerHTML = opts(uniq('customerName'));
    }).catch(function () { /* autocomplete is optional */ });

    // Returning customer: when a known name is picked/typed, fill phone & address if they are still empty
    form.customerName.addEventListener('change', function () {
      var name = form.customerName.value.trim().toLowerCase();
      if (!name || !state.items) return;
      var match = state.items.find(function (i) {   // list is newest first -> most recent entry wins
        return (i.customerName || '').trim().toLowerCase() === name && (i.customerPhone || i.customerAddress);
      });
      if (!match) return;
      if (!form.customerPhone.value.trim() && match.customerPhone) form.customerPhone.value = match.customerPhone;
      if (!form.customerAddress.value.trim() && match.customerAddress) form.customerAddress.value = match.customerAddress;
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var errBox = document.getElementById('form-error');
      var data = read();
      var problem =
        !data.date ? 'Please choose a date.' :
        !data.productName ? 'Product name is required.' :
        (data.customerPhone && !PHONE_RE.test(data.customerPhone)) ? 'Customer phone can only contain digits, spaces and + ( ) - . , / ;' :
        data.unitPrice < 0 ? 'Unit price cannot be negative.' :
        data.quantity <= 0 ? 'Quantity must be greater than 0.' :
        data.rate <= 0 ? 'Rate must be greater than 0.' :
        data.sellingPrice < 0 ? 'Selling price cannot be negative.' :
        (data.additionalCost < 0 || data.additionalDiscount < 0) ? 'Additional cost/discount cannot be negative.' : '';
      if (problem) { errBox.innerHTML = errorHtml(problem); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }

      var btn = form.querySelector('button[type="submit"]');
      var label = btn.textContent;
      btn.disabled = true; btn.textContent = 'Saving…'; errBox.innerHTML = '';

      var req = isEdit ? api('update', { id: it.id, item: data }) : api('create', { item: data });
      req.then(function (saved) {
        store.set(RATE_KEY, String(data.rate));
        state.items = null; // force refresh next time
        toast(isEdit ? 'Changes saved' : 'Item created');
        location.hash = '#/items/' + encodeURIComponent(saved.id);
      }).catch(function (err) {
        errBox.innerHTML = errorHtml(err.message);
        btn.disabled = false; btn.textContent = label;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  /* ================================================================ */
  /* View details                                                      */
  /* ================================================================ */

  function viewPage(my, id) {
    shell('items', '<div id="content">' + loadingHtml() + '</div>');
    api('get', { id: id }).then(function (it) {
      if (my !== navId) return;
      var row = function (label, value, cls, wide) {
        return '<div' + (wide ? ' class="wide"' : '') + '><dt>' + esc(label) + '</dt><dd class="' + (cls || '') + '">' + value + '</dd></div>';
      };
      var net = function (n) { return '<span class="badge ' + netClass(n) + '">' + fmt(n, 0, 2) + '</span>'; };
      var dash = '<span class="muted">—</span>';
      var phone = it.customerPhone
        ? '<a href="tel:' + esc(it.customerPhone.replace(/[^\d+]/g, '')) + '">' + esc(it.customerPhone) + '</a>'
        : dash;
      document.getElementById('content').innerHTML =
        '<div class="page-head"><div><h1>' + esc(it.productName) + '</h1>' +
          '<div class="sub">' + esc(it.productBrand || 'No brand') + ' · ' + esc(it.productCode || 'No code') + '</div></div>' +
          '<div class="head-actions">' +
            '<a class="btn" href="#/items">' + icon('back') + 'Back</a>' +
            '<a class="btn" href="#/items/' + encodeURIComponent(it.id) + '/edit">' + icon('edit') + 'Edit</a>' +
            '<button class="btn btn-danger" id="del-btn" type="button">' + icon('trash') + 'Delete</button>' +
          '</div></div>' +
        '<div class="stack">' +
          '<section class="card detail"><h2>Product</h2><dl>' +
            row('Date', esc(niceDate(it.date))) + row('Product Code', esc(it.productCode || '—')) +
            row('Product Name', esc(it.productName)) + row('Product Brand', esc(it.productBrand || '—')) +
          '</dl></section>' +
          '<section class="card detail"><h2>Customer</h2><dl>' +
            row('Customer Name', it.customerName ? esc(it.customerName) : dash) + row('Customer Phone', phone) +
            row('Customer Address', it.customerAddress ? esc(it.customerAddress).replace(/\n/g, '<br>') : dash, '', true) +
          '</dl></section>' +
          '<section class="card detail"><h2>Purchase</h2><dl>' +
            row('Unit Price (THB)', fmt(it.unitPrice, 2, 2)) + row('Quantity', fmt(it.quantity)) +
            row('Total Price (THB)', fmt(it.totalPriceThb, 2, 2)) + row('Rate', fmt(it.rate, 0, 4)) +
            row('Total Price (MMK)', fmt(it.totalPriceMmk, 0, 2)) +
          '</dl></section>' +
          '<section class="card detail"><h2>Sale</h2><dl>' +
            row('Selling Price (MMK)', fmt(it.sellingPrice, 0, 2)) + row('Net Amount (MMK)', net(it.netAmount)) +
          '</dl></section>' +
          '<section class="card detail"><h2>Adjustments</h2><dl>' +
            row('Additional Cost (MMK)', fmt(it.additionalCost, 0, 2)) + row('Additional Discount (MMK)', fmt(it.additionalDiscount, 0, 2)) +
            row('Calculated Total Cost (MMK)', fmt(it.calcTotalCost, 0, 2)) + row('Calculated Net Amount (MMK)', net(it.calcNetAmount)) +
          '</dl></section>' +
          '<section class="card detail"><h2>Remark</h2><dl>' +
            row('Notes', it.remark ? esc(it.remark).replace(/\n/g, '<br>') : dash, '', true) +
            row('Created', esc(formatStamp(it.createdAt))) + row('Last updated', esc(formatStamp(it.updatedAt))) +
          '</dl></section>' +
        '</div>';
      document.getElementById('del-btn').onclick = function () {
        deleteFlow(it, function () { location.hash = '#/items'; });
      };
    }).catch(function (err) {
      if (my !== navId) return;
      document.getElementById('content').innerHTML = errorHtml(err.message) +
        '<p><a class="btn" href="#/items">' + icon('back') + 'Back to items</a></p>';
    });
  }

  function formatStamp(s) {
    var d = new Date(s);
    if (isNaN(d)) return s || '—';
    return p2(d.getDate()) + '-' + p2(d.getMonth() + 1) + '-' + d.getFullYear() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  /* ================================================================ */
  /* Router                                                            */
  /* ================================================================ */

  var routes = [
    { re: /^#\/login$/, pub: true, fn: function () { loginPage(); } },
    { re: /^#\/overview$/, fn: function (my) { overviewPage(my); } },
    { re: /^#\/items$/, fn: function (my) { galleryPage(my); } },
    { re: /^#\/items\/new$/, fn: function (my) { formPage(my, null); } },
    { re: /^#\/items\/([^/]+)\/edit$/, fn: function (my, m) { formPage(my, decodeURIComponent(m[1])); } },
    { re: /^#\/items\/([^/]+)$/, fn: function (my, m) { viewPage(my, decodeURIComponent(m[1])); } },
  ];

  function route() {
    var my = ++navId;
    var hash = location.hash || '';
    var authed = !!getToken();

    if (!hash || hash === '#' || hash === '#/') { location.hash = authed ? '#/overview' : '#/login'; return; }

    for (var i = 0; i < routes.length; i++) {
      var m = hash.match(routes[i].re);
      if (!m) continue;
      if (!routes[i].pub && !authed) { location.hash = '#/login'; return; }
      if (routes[i].pub && authed) { location.hash = '#/overview'; return; }
      window.scrollTo(0, 0);
      routes[i].fn(my, m);
      return;
    }
    location.hash = authed ? '#/overview' : '#/login';
  }

  window.addEventListener('hashchange', route);
  route();
})();
