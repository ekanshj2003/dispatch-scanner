/* Dispatch Scan Register – app logic (v9: cancel removes the parcel from dispatch).
   Talks to the Google Sheet script in google-sheet-script/Code.gs. */
(function () {
  'use strict';

  /* ================= basics ================= */
  // Flipkart / Meesho order connection is switched off for now. Set to true to bring it back.
  const PORTALS = false;
  const $ = id => document.getElementById(id);
  const today = () => new Date().toLocaleDateString('en-CA');
  const dayOffset = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('en-CA'); };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = ts => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const store = {
    get(k, d) { try { const v = localStorage.getItem('dsr2.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('dsr2.' + k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem('dsr2.' + k); } catch (e) {} }
  };
  // Only touch the DOM when the content really changed, so lists don't flicker on refresh.
  const setHTML = (el, html) => { if (el._h !== html) { el._h = html; el.innerHTML = html; } };
  const setText = (el, t) => { t = String(t); if (el.textContent !== t) el.textContent = t; };

  let url = store.get('url', '');
  let token = store.get('token', '');
  let user = store.get('user', null);                 // {name, role}
  let platform = store.get('platform', 'Flipkart');
  let queue = store.get('queue', []);                 // scans waiting for internet
  let products = store.get('products', {});           // packet code -> name
  let skus = store.get('skus', {});                   // packet code -> SKU
  let byAwb = {}, ordersLoaded = false, syncInfo = null;   // AWB -> {p, oid, items:[{sku, qty, title}]}
  let learned = store.get('learned', { awb: {}, ign: {} });
  let todayRows = [], viewRows = [], viewDay = today();
  let pendingOrder = null, pendingAgain = false;     // pendingAgain: this AWB was cancelled earlier and goes out again
  // Every AWB / packet code ever saved (code -> date). Kept on the phone so a repeat is blocked instantly.
  let used = store.get('used', { a: {}, p: {}, ts: 0 });
  used.c = used.c || {}; used.cr = used.cr || {}; used.ets = used.ets || 0;   // cr = cancel reason per AWB     // c = cancelled AWBs, ets = last change seen
  let cfg2 = store.get('settings', { meeshoCouriers: ['Valmo', 'Delhivery', 'Shadowfax', 'Xpressbees', 'Ecom Express', 'DTDC'], flipkartCouriers: ['Ekart', 'Delhivery', 'Shadowfax', 'Xpressbees'], uniquePacket: true });
  let courier = store.get('courier', '');
  let step = 1, pendingAwb = '', labelCodes = new Set(), busy = false, online = null;

  /* ================= server ================= */
  async function api(method, params, opts) {
    if (!url) throw Object.assign(new Error('This device is not connected to the Google Sheet.'), { server: true });
    const body = Object.assign({ token }, params);
    let res;
    if (method === 'GET') {
      const u = new URL(url);
      Object.entries(body).forEach(([k, v]) => u.searchParams.set(k, v));
      res = await fetch(u.toString());
    } else {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
    }
    if (!res.ok) throw new Error('Sheet replied ' + res.status);
    const j = await res.json();
    if (j.auth && !(opts && opts.noLogout)) { logout(j.error); throw Object.assign(new Error(j.error), { server: true }); }
    if (!j.ok && !j.dup) throw Object.assign(new Error(j.error || 'Sheet error'), { server: true });
    return j;
  }
  function setConn(state) {
    online = state === 'on';
    $('conn').firstElementChild.className = 'dot ' + state;
    $('conn').title = state === 'on' ? 'Connected to Google Sheet' : state === 'q' ? 'Scans waiting to upload' : 'Offline';
  }

  /* ================= login ================= */
  function showLogin(msg) {
    stopCam();
    $('app').hidden = true; $('loginView').hidden = false;
    $('lMsg').className = 'msg' + (msg ? ' bad' : ''); $('lMsg').textContent = msg || '';
    $('dUrl').value = url;
    $('devDot').className = 'dot ' + (url ? 'on' : 'off');
    $('devState').textContent = url ? 'Device connected to Google Sheet' : 'Connect this device first';
    $('devBox').open = !url;
    if (user && user.name) $('lName').value = user.name;
    setTimeout(() => (url ? ($('lName').value ? $('lPin') : $('lName')) : $('dUrl')).focus(), 50);
  }
  function showApp() {
    $('loginView').hidden = true; $('app').hidden = false;
    $('userName').textContent = user.name;
    $('userRole').textContent = user.role === 'admin' ? 'Admin' : 'Packer';
    const isAdmin = user.role === 'admin';
    $('codesTab').hidden = !(PORTALS && isAdmin);
    document.querySelector('.tabs').classList.toggle('three', !(PORTALS && isAdmin));
    $('syncLine').hidden = !PORTALS; if (!PORTALS) $('syncBtn').hidden = true;
    go('scan');
    buildOrders(store.get('orders', [])); ordersLoaded = false;
    renderCouriers(); fillMfCouriers();
    loadSettings(); loadUsed(); loadCancelled(); if (PORTALS) { loadProducts(); loadOrders(); } loadToday().then(syncQueue);
    getDetector().catch(() => {});
    maybeAutoStartCam();
  }
  function logout(msg) {
    token = ''; store.del('token');
    showLogin(msg || '');
  }

  $('devForm').addEventListener('submit', async e => {
    e.preventDefault();
    const u = $('dUrl').value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\/.+\/exec$/.test(u)) { $('dMsg').className = 'msg bad'; $('dMsg').textContent = 'The link should start with https://script.google.com and end with /exec.'; return; }
    $('dMsg').className = 'msg'; $('dMsg').textContent = 'Testing…';
    try {
      const r = await fetch(u + '?action=ping'); const j = await r.json();
      if (!j.ok || j.app !== 'dispatch-scanner') throw new Error('That link is not the dispatch script.');
      if (!(j.v >= 7)) throw new Error('Paste the new Code.gs and deploy a new version.');
      url = u; store.set('url', url);
      $('dMsg').className = 'msg ok'; $('dMsg').textContent = 'Connected. Now log in.';
      $('devDot').className = 'dot on'; $('devState').textContent = 'Device connected to Google Sheet';
      setTimeout(() => { $('devBox').open = false; $('lName').focus(); }, 700);
    } catch (err) { $('dMsg').className = 'msg bad'; $('dMsg').textContent = 'Could not connect. ' + (err.message || ''); }
  });

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!url) { $('lMsg').className = 'msg bad'; $('lMsg').textContent = 'Connect this device to the Google Sheet first (below).'; $('devBox').open = true; return; }
    $('lBtn').disabled = true; $('lMsg').className = 'msg'; $('lMsg').textContent = 'Checking…';
    try {
      const j = await api('POST', { action: 'login', name: $('lName').value, pin: $('lPin').value }, { noLogout: true });
      token = j.token; user = j.user; store.set('token', token); store.set('user', user);
      $('lPin').value = ''; $('lMsg').textContent = '';
      showApp();
    } catch (err) {
      $('lMsg').className = 'msg bad';
      $('lMsg').textContent = err.server ? err.message : 'No internet. Connect and try again.';
    } finally { $('lBtn').disabled = false; }
  });

  $('userBtn').onclick = e => { e.stopPropagation(); $('userMenu').hidden = !$('userMenu').hidden; };
  document.addEventListener('click', e => { if (!e.target.closest('#userMenu')) $('userMenu').hidden = true; });
  $('logoutBtn').onclick = () => { $('userMenu').hidden = true; logout(''); };

  /* ================= tabs ================= */
  let current = 'scan';
  function go(view) {
    current = view;
    ['scan', 'today', 'cancel', 'manifest', 'excel', 'codes'].forEach(v => { $('v-' + v).hidden = v !== view; });
    placeStage(view);
    if (view === 'cancel') { renderReasons(); loadCancelled(); }
    if (view === 'manifest') { $('mfPlatform').value = platform; fillMfCouriers(true); loadManifests(); }
    document.querySelectorAll('.tabs button').forEach(b => b.toggleAttribute('aria-current', b.dataset.view === view));
    if (view === 'scan' || view === 'cancel') maybeAutoStartCam(); else stopCam();
    if (view === 'today') loadCancelled();
    if (view === 'today') { if (viewDay === today()) { viewRows = todayRows; render(); } else loadView(); }
    if (view === 'codes') render();
  }
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => go(b.dataset.view));

  /* ================= feedback ================= */
  let actx = null;
  function beep(ok) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = ok ? 1320 : 240; o.type = ok ? 'sine' : 'square'; g.gain.value = 0.08;
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + (ok ? 0.09 : 0.35));
    } catch (e) {}
    try { navigator.vibrate && navigator.vibrate(ok ? 50 : [90, 60, 90]); } catch (e) {}
  }
  function flash(kind, title, sub) {
    const f = $('flash'); f.className = 'flash ' + kind;
    f.innerHTML = '<b>' + esc(title) + '</b><span>' + esc(sub || '') + '</span>';
  }
  function pulse(ok) {
    const h = $('hit'); h.className = 'hit show' + (ok ? '' : ' bad');
    requestAnimationFrame(() => requestAnimationFrame(() => { h.className = 'hit' + (ok ? '' : ' bad'); }));
  }

  /* ================= platform + steps ================= */
  function setPlatform(p) {
    platform = p === 'Meesho' ? 'Meesho' : 'Flipkart'; store.set('platform', platform);
    document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.p === platform)));
    renderCouriers();
  }
  function renderCouriers() {
    const meesho = platform === 'Meesho';
    $('courierChips').hidden = !meesho; $('courierAuto').hidden = meesho;
    if (!PORTALS) $('courierAuto').textContent = 'Not needed for Flipkart';
    if (!meesho) { $('courierRow').classList.remove('need'); return; }
    const list = cfg2.meeshoCouriers || [];
    if (courier && !list.includes(courier)) courier = '';
    setHTML($('courierChips'), list.map(c => `<button type="button" data-courier="${esc(c)}" aria-pressed="${c === courier}">${esc(c)}</button>`).join(''));
  }
  $('courierChips').onclick = e => {
    const b = e.target.closest('[data-courier]'); if (!b) return;
    courier = b.dataset.courier; store.set('courier', courier);
    $('courierRow').classList.remove('need');
    $('courierChips').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  };
  document.querySelectorAll('.seg button').forEach(b => b.onclick = () => setPlatform(b.dataset.p));
  setPlatform(platform);

  function renderSteps() {
    $('s1').className = 'step ' + (step === 1 ? 'on' : 'done');
    $('s2').className = 'step ' + (step === 2 ? 'on' : '');
    const v1 = $('v1'); v1.className = 'val' + (pendingAwb ? '' : ' empty'); setText(v1, pendingAwb || 'Scan the courier label');
    const v2 = $('v2'); v2.className = 'val empty'; setText(v2, step === 2 && pendingOrder ? 'Needs: ' + orderLabel(pendingOrder) : 'Then scan the packet');
    $('pickTitle').textContent = step === 1 ? 'More than one barcode in the box. Tap the AWB:' : 'More than one barcode in the box. Tap the packet barcode:';
  }
  function reset(msg) {
    step = 1; pendingAwb = ''; pendingOrder = null; pendingAgain = false; labelCodes = new Set(); closePick(); renderSteps();
    if (msg) flash('idle', msg, 'Scan the AWB on the shipping label.');
  }
  $('resetBtn').onclick = () => reset('Reset.');

  /* ================= orders from Flipkart / Meesho ================= */
  function buildOrders(list) {
    const m = {};
    (list || []).forEach(o => {
      [o.awb, o.awb2].filter(Boolean).forEach(k => {
        const key = String(k).trim().toUpperCase();
        const e = m[key] || (m[key] = { p: o.p, oid: o.oid, items: [] });
        if (!e.items.some(i => i.sku === o.sku)) e.items.push({ sku: o.sku, qty: o.qty || 1, title: o.title || '' });
        else e.items.find(i => i.sku === o.sku).qty = Math.max(e.items.find(i => i.sku === o.sku).qty, o.qty || 1);
      });
    });
    byAwb = m; ordersLoaded = true;
  }
  const findOrder = awb => byAwb[String(awb || '').trim().toUpperCase()] || null;
  const nameForSku = sku => { for (const c in skus) if (skus[c] === sku && products[c] && products[c] !== sku) return products[c]; return ''; };
  const itemLabel = i => (nameForSku(i.sku) || i.title || i.sku) + (i.qty > 1 ? ' × ' + i.qty : '');
  const orderLabel = o => o.items.map(itemLabel).join(' + ');

  async function loadOrders() {
    if (!token) return;
    try {
      const j = await api('GET', { action: 'orders' });
      buildOrders(j.orders); syncInfo = j.sync || null; store.set('orders', j.orders || []);
      renderSync();
    } catch (err) {}
  }
  function renderSync() {
    const el = $('syncLine'); if (!el) return;
    const n = Object.keys(byAwb).length;
    if (!syncInfo || !syncInfo.flipkart) { el.textContent = 'Flipkart not connected'; }
    else if (syncInfo.last && !syncInfo.last.ok) { el.textContent = 'Flipkart sync problem: ' + syncInfo.last.error; }
    else { el.textContent = 'Orders loaded: ' + n + (syncInfo.last ? ' · synced ' + syncInfo.last.at.slice(11) : ''); }
    $('syncBtn').hidden = !(PORTALS && user && user.role === 'admin' && syncInfo && syncInfo.flipkart);
  }

  /* ================= dispatching a cancelled AWB again ================= */
  function startAgain(code, why) {
    if (platform === 'Meesho' && !courier) { flash('warn', 'Pick the delivery partner first', 'Then scan the AWB again.'); $('courierRow').classList.add('need'); return; }
    pendingAwb = code; pendingOrder = null; pendingAgain = true; step = 2;
    labelCodes = new Set(recentCodes()); labelCodes.add(code);
    renderSteps();
    flash('warn', '↻ Dispatching again · AWB ' + code, why + ' ' + fmtDay(used.c[code]) + '. Now scan the packet barcode.');
  }
  function askAgain(code, why) {
    if (picking) return;
    picking = true;
    $('pickTitle').textContent = 'AWB ' + code + ' was cancelled ' + fmtDay(used.c[code]) + ' (' + why + '). Dispatch it again?';
    $('pickList').innerHTML = '<button type="button" data-yes="1" style="font-family:inherit">Yes, dispatch again<small>Saved as a new dispatch today</small></button>' +
      '<button type="button" data-none="1" style="font-family:inherit"><small>No, keep it cancelled</small></button>';
    $('pickList').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      closePick(); renderSteps();
      if (b.dataset.yes) { startAgain(code, why); beep(true); }
      else flash('idle', 'AWB ' + code + ' stays cancelled.', 'Scan the next AWB.');
    };
    $('pick').hidden = false;
    flash('warn', 'AWB ' + code + ' was cancelled', 'Tap Yes on the camera box to dispatch it again.');
    beep(false);
  }

  /* ================= saving a scan ================= */
  const fmtDay = d => d === today() ? 'today' : d ? 'on ' + d.split('-').reverse().join('-') : 'before';
  const usedAwbDay = c => used.a[c] || (queue.find(r => r.awb === c) || {}).date || (todayRows.find(r => r.awb === c) || {}).date || '';
  const usedPktDay = c => used.p[c] || (queue.find(r => r.packet === c) || {}).date || (todayRows.find(r => r.packet === c && r.status !== 'Cancelled') || {}).date || '';
  // Apply a delete / cancel / undo to the phone's list of used codes.
  function applyEvent(ev) {
    if (!ev || !ev.awb) return;
    const k = ev.awb, af = ev.after || {};
    if ((ev.type === 'deleted' || ev.type === 'cancelled') && ev.packet) delete used.p[ev.packet];
    if (ev.type === 'uncancelled' && ev.packet) used.p[ev.packet] = ev.date || ev.at;
    const state = af.s || (ev.type === 'deleted' ? 'none' : ev.type === 'cancelled' ? 'cancelled' : 'active');
    if (state === 'none') { delete used.a[k]; delete used.c[k]; delete used.cr[k]; }
    else if (state === 'active') { used.a[k] = af.d || used.a[k] || ev.date || ev.at; if (af.p) used.p[af.p] = af.d || ev.at; delete used.c[k]; delete used.cr[k]; }
    else { used.a[k] = used.a[k] || af.d || ev.date || ev.at; used.c[k] = af.at || ev.at || today(); used.cr[k] = af.r || ev.reason || ''; }
  }
  const knownAwb = c => !!usedAwbDay(c);
  function markUsed(rec) {
    used.a[rec.awb] = rec.date; used.p[rec.packet] = rec.date; delete used.c[rec.awb]; delete used.cr[rec.awb];
    store.set('used', used);
  }

  async function accept(code) {
    code = String(code || '').trim();
    if (!code || busy) return;
    if (current === 'cancel') return cancelCode(code);
    busy = true;
    try {
      if (step === 1) {
        const aDay = usedAwbDay(code), pDay = usedPktDay(code);
        if (aDay && used.c[code]) {
          const why = used.cr[code] || 'Cancelled';
          if (/pick/i.test(why)) { startAgain(code, why); beep(true); pulse(true); return; }       // not picked up: just scan again
          askAgain(code, why); return;                                                          // other reasons: ask first
        }
        if (aDay) { flash('bad', '✗ AWB ' + code + ' already scanned', 'It was dispatched ' + fmtDay(aDay) + '. An AWB can be scanned only once.'); beep(false); pulse(false); return; }
        if (pDay || products[code]) { flash('bad', '✗ That is a packet barcode', (pDay ? 'Already used ' + fmtDay(pDay) + '. ' : '') + 'Scan the AWB on the shipping label first.'); beep(false); pulse(false); return; }
        const ord = findOrder(code);
        if (ord) setPlatform(ord.p); else if (/^FMP/i.test(code)) setPlatform('Flipkart');
        if (platform === 'Meesho' && !courier) { flash('warn', 'Pick the delivery partner first', 'Tap Valmo, Delhivery, Shadowfax… at the top, then scan the AWB again.'); $('courierRow').classList.add('need'); beep(false); return; }
        pendingAwb = code; pendingOrder = ord; step = 2;
        labelCodes = new Set(recentCodes()); labelCodes.add(code);
        renderSteps();
        if (ord) flash('idle', 'Pack: ' + orderLabel(ord), 'Order ' + ord.oid + '. Now scan the packet barcode.');
        else if (ordersLoaded && syncInfo && syncInfo.flipkart && platform === 'Flipkart') flash('warn', 'AWB ' + code + ' is not in your Flipkart orders', 'Not synced yet, cancelled, or wrong label. Scan the packet to save anyway.');
        else flash('idle', 'AWB ' + code, 'Now scan the barcode on the packet.');
        beep(true); pulse(true);
      } else {
        if (code === pendingAwb) { flash('warn', 'That is the same AWB.', 'Scan the barcode on the packet now.'); beep(false); return; }
        const aDay2 = usedAwbDay(code);
        if (aDay2) { flash('bad', '✗ That is an AWB, not a packet', 'AWB ' + code + ' was used ' + fmtDay(aDay2) + '. Scan the barcode on the packet.'); beep(false); pulse(false); return; }
        const pDay2 = cfg2.uniquePacket ? usedPktDay(code) : '';
        if (pDay2) { flash('bad', '✗ Packet barcode already used', code + ' was scanned ' + fmtDay(pDay2) + '. Each packet barcode can be used only once.'); beep(false); pulse(false); return; }
        const ord = pendingOrder, pSku = skus[code] || '';
        const want = ord ? ord.items.map(i => i.sku).filter(Boolean) : [];
        if (ord && pSku && want.length && !want.includes(pSku)) {        // wrong product: do not save, stay on this parcel
          flash('bad', '✗ Wrong product! Not saved.', 'This is ' + (products[code] || pSku) + '. Order needs ' + orderLabel(ord) + '.');
          beep(false); pulse(false);
          return;
        }
        const check = !ord ? (ordersLoaded && syncInfo && syncInfo.flipkart ? 'NO ORDER' : '') : !pSku ? 'NO CODE' : 'OK';
        const ts = Date.now();
        const rec = { awb: pendingAwb, packet: code, platform, ts, date: today(), time: fmtTime(ts), product: products[code] || (ord && ord.items.length === 1 ? itemLabel(ord.items[0]) : ''), by: user ? user.name : '',
          redispatch: pendingAgain || undefined, orderId: ord ? ord.oid : '', orderSku: want.join(', '), check, courier: platform === 'Meesho' ? courier : (ord && ord.c) || '' };
        const wasAgain = pendingAgain;
        step = 1; pendingAwb = ''; pendingOrder = null; pendingAgain = false; labelCodes = new Set(); renderSteps();
        // Save on the phone first and upload in the background, so the next parcel can be scanned at once.
        queue.push(rec); store.set('queue', queue); markUsed(rec);
        if (check === 'OK') flash('ok', '✓ Correct · Saved · ' + rec.awb, rec.product || orderLabel(ord));
        else if (check === 'NO CODE') flash('warn', '✓ Saved · ' + rec.awb + ' · not checked', 'Packet ' + code + ' is not linked to a SKU yet.');
        else if (!PORTALS) flash('ok', (wasAgain ? '✓ Dispatched again · ' : '✓ Saved · ') + platform + (rec.courier ? ' · ' + rec.courier : '') + ' · ' + rec.awb, 'Packet ' + code);
        else flash(rec.product ? 'ok' : 'warn', '✓ Saved · ' + platform + ' · ' + rec.awb, rec.product || 'New packet code ' + code + (user && user.role === 'admin' ? '. Name it in Codes.' : '. Ask admin to name it.'));
        beep(true); pulse(true);
        render();
        syncQueue();
        // Admin + one-product order + unknown packet barcode: offer to link it, so next time it is checked.
        if (check === 'NO CODE' && want.length === 1 && user && user.role === 'admin' && !cfg2.uniquePacket) offerLink(code, ord.items[0]);
      }
    } finally { busy = false; }
  }

  $('manualForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('manual').value; $('manual').value = '';
    $('manual').blur();
    accept(v);
  });

  // Barcode gun / Bluetooth scanner: it "types" very fast and presses Enter.
  // Catch that anywhere on the Scan screen, so no box needs focus and the phone keyboard never opens.
  let kb = '', kbFirst = 0, kbLast = 0;
  document.addEventListener('keydown', e => {
    if ($('app').hidden || !['scan', 'cancel', 'today'].includes(current)) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    const now = performance.now();
    if (now - kbLast > 100) { kb = ''; kbFirst = now; }
    kbLast = now;
    if (e.key === 'Enter') {
      if (kb.length >= 4 && (now - kbFirst) < kb.length * 70 + 200) {
        e.preventDefault();
        if (current === 'today') { $('q').value = kb; runSearch(); } else accept(kb);
      }
      kb = ''; return;
    }
    if (e.key.length === 1) kb += e.key;
  });

  /* ================= which barcode is the right one? ================= */
  // A label has several barcodes (AWB, order ID, invoice, QR). We only look inside the white box,
  // wait until a code is read twice in a row, skip codes we know are wrong, and ask when unsure.
  const sig = code => { const m = code.match(/^[A-Za-z]+/); return (m ? m[0].toUpperCase() : '#') + ':' + code.length; };
  const isOrderId = c => /^OD\d{8,}$/i.test(c);
  const awbLike = c => c.length >= 8 && c.length <= 32 && /^[A-Za-z0-9-]+$/.test(c) && !products[c] && !isOrderId(c);

  function choose(cands) {
    if (step === 1) {
      let list = cands.filter(c => awbLike(c.code));
      const notIgnored = list.filter(c => !learned.ign[sig(c.code)]);
      if (notIgnored.length) list = notIgnored;
      const preferred = list.filter(c => learned.awb[sig(c.code)]);
      if (preferred.length === 1) return preferred[0].code;
      if (list.length === 1) return list[0].code;
      if (list.length > 1) openPick(preferred.length > 1 ? preferred : list);
      return null;
    }
    const prod = cands.find(c => products[c.code]);
    if (prod) return prod.code;
    const list = cands.filter(c => c.code !== pendingAwb && !labelCodes.has(c.code) && !isOrderId(c.code) && !learned.awb[sig(c.code)] && !knownAwb(c.code));
    if (list.length === 1) return list[0].code;
    if (list.length > 1) openPick(list);
    return null;
  }

  let picking = false;
  function openPick(list) {
    if (picking) return;
    picking = true;
    const all = list.map(c => c.code);
    $('pickList').innerHTML = list.map(c => `<button type="button" data-code="${esc(c.code)}">${esc(c.code)}<small>${esc((c.format || '').replace(/_/g, ' '))}</small></button>`).join('') +
      '<button type="button" data-none="1"><small>None of these – keep scanning</small></button>';
    $('pickList').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.none) { closePick(); return; }
      const chosen = b.dataset.code;
      if (step === 1) {                               // remember the pattern so next time it picks by itself
        const s = sig(chosen); learned.awb[s] = (learned.awb[s] || 0) + 1; delete learned.ign[s];
        all.filter(c => c !== chosen).forEach(c => { const o = sig(c); if (!learned.awb[o]) learned.ign[o] = (learned.ign[o] || 0) + 1; });
        store.set('learned', learned);
      }
      closePick(); cooldown(1200); accept(chosen);
    };
    $('pick').hidden = false; beep(true);
  }
  function closePick() { picking = false; $('pick').hidden = true; }

  function offerLink(code, item) {
    if (picking) return;
    picking = true;
    const label = nameForSku(item.sku) || item.title || item.sku;
    $('pickTitle').textContent = 'New packet barcode ' + code + '. Is it ' + label + ' (SKU ' + item.sku + ')?';
    $('pickList').innerHTML = '<button type="button" data-yes="1" style="font-family:inherit">Yes, link it<small>Next time this packet is checked against the order</small></button>' +
      '<button type="button" data-none="1"><small>No / not sure – skip</small></button>';
    $('pickList').onclick = async e => {
      const b = e.target.closest('button'); if (!b) return;
      closePick(); renderSteps();
      if (!b.dataset.yes) return;
      const name = products[code] || nameForSku(item.sku) || item.title || item.sku;
      try {
        await api('POST', { action: 'product', code, name, sku: item.sku });
        products[code] = name; skus[code] = item.sku; store.set('products', products); store.set('skus', skus);
        flash('ok', 'Linked ' + code, name + ' · SKU ' + item.sku); render();
      } catch (err) { flash('bad', 'Could not link.', err.message); }
    };
    $('pick').hidden = false;
  }

  /* ================= stability filter ================= */
  const seen = new Map();                 // code -> {hits, last, format}
  const recent = new Map();               // code -> time accepted (avoid double reads)
  let coolUntil = 0;
  const cooldown = ms => { coolUntil = performance.now() + ms; };
  const recentCodes = () => { const now = performance.now(); return [...seen.entries()].filter(([, v]) => now - v.last < 1500).map(([k]) => k); };

  // Formats with a built-in check digit can be trusted on one clear read. Others need two matching reads.
  const SAFE = new Set(['code_128', 'code_93', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'data_matrix']);

  function onFrame(codes) {
    const now = performance.now();
    if (!codes.length) return;
    // While the AWB label is still in the box, every barcode next to it belongs to the label, not the packet.
    if (step === 2 && codes.some(c => c.code === pendingAwb)) { codes.forEach(c => labelCodes.add(c.code)); return; }
    codes.forEach(({ code, format }) => {
      if (!code) return;
      const s = seen.get(code);
      if (s && now - s.last < 800) { s.hits++; s.last = now; s.format = format; }
      else seen.set(code, { hits: 1, last: now, format });
    });
    for (const [k, v] of seen) if (now - v.last > 2500) seen.delete(k);
    if (busy || picking || now < coolUntil) return;
    const ready = codes
      .filter(({ code, format }) => {
        const v = seen.get(code);
        return v && (v.hits >= 2 || SAFE.has(format)) && !(recent.has(code) && now - recent.get(code) < 4000);
      });
    if (!ready.length) return;
    const pick = current === 'cancel'
      ? ((ready.find(c => usedAwbDay(c.code)) || (ready.length === 1 ? ready[0] : null)) || {}).code
      : choose(ready);
    if (pick) {
      recent.set(pick, now); cooldown(450);
      $('stage').classList.add('locked'); setTimeout(() => $('stage').classList.remove('locked'), 400);
      accept(pick);
    }
  }

  /* ================= camera ================= */
  // One engine for every phone: the phone's own barcode reader when it has one (most Android Chrome),
  // otherwise the fast ZXing reader (WebAssembly). Only the white box is read, never the whole picture.
  const NATIVE_WANT = ['code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar', 'qr_code', 'data_matrix'];
  const ZX_WANT = ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'itf', 'qr_code', 'data_matrix'];
  const ZX_URL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.0.8/dist/iife/ponyfill.js';
  let camOn = false, stream = null, detector = null, detectorKind = '', track = null, torch = false, zoomed = false, loopTimer = 0, rvfc = 0;
  const crop = document.createElement('canvas');
  const cctx = crop.getContext('2d', { willReadFrequently: true });

  function loadScript(src) {
    return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  }
  let detectorPromise = null;
  function getDetector() {
    if (detectorPromise) return detectorPromise;
    detectorPromise = (async () => {
      if ('BarcodeDetector' in window) {
        try {
          const have = await window.BarcodeDetector.getSupportedFormats();
          const formats = NATIVE_WANT.filter(f => have.includes(f));
          if (formats.includes('code_128')) { detectorKind = 'native'; return new window.BarcodeDetector({ formats }); }
        } catch (e) {}
      }
      await loadScript(ZX_URL);
      const d = new window.BarcodeDetectionAPI.BarcodeDetector({ formats: ZX_WANT });
      const warm = document.createElement('canvas'); warm.width = warm.height = 8;
      try { await d.detect(warm); } catch (e) {}               // loads the reader now, not on the first scan
      detectorKind = 'zxing';
      return d;
    })();
    detectorPromise.catch(() => { detectorPromise = null; });
    return detectorPromise;
  }

  const VIDEO = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  const gum = video => navigator.mediaDevices.getUserMedia({ audio: false, video: Object.assign({}, VIDEO, video) });
  const capsOf = s => { const t = s.getVideoTracks()[0]; return (t && t.getCapabilities && t.getCapabilities()) || {}; };
  const stopStream = s => { try { s.getTracks().forEach(t => t.stop()); } catch (e) {} };

  // Phones with 2–4 back lenses often hand the browser the ultra-wide lens, which cannot focus up close.
  // The main lens is the one with the flash, so we look for a back camera that has a flash and remember it.
  async function openCamera() {
    const saved = store.get('camId', '');
    if (saved) {
      try { return await gum({ deviceId: { exact: saved } }); } catch (e) { store.del('camId'); }
    }
    let s = await gum({ facingMode: { ideal: 'environment' } });
    const firstId = s.getVideoTracks()[0].getSettings().deviceId || '';
    if (capsOf(s).torch) { store.set('camId', firstId); return s; }
    let devs = [];
    try { devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput' && d.deviceId && d.deviceId !== firstId); } catch (e) {}
    const back = devs.filter(d => /back|rear|environment/i.test(d.label));
    const tryList = (back.length ? back : devs).filter(d => !/front|user|selfie/i.test(d.label));
    if (!tryList.length) { store.set('camId', firstId); return s; }
    stopStream(s);                                            // most phones allow only one camera open at a time
    for (const d of tryList) {
      try {
        const t = await gum({ deviceId: { exact: d.deviceId } });
        if (capsOf(t).torch) { store.set('camId', d.deviceId); return t; }
        stopStream(t);
      } catch (e) {}
    }
    s = await gum(firstId ? { deviceId: { exact: firstId } } : { facingMode: { ideal: 'environment' } });
    store.set('camId', firstId);
    return s;
  }

  async function setTorch(on) {
    if (!track) return false;
    try { await track.applyConstraints({ advanced: [{ torch: !!on }] }); torch = !!on; }
    catch (e) { torch = false; }
    $('torchBtn').setAttribute('aria-pressed', String(torch));
    return torch;
  }

  async function startCam() {
    if (camOn) return;
    $('camStart').disabled = true;
    try {
      const [d, s] = await Promise.all([getDetector(), openCamera()]);
      detector = d; stream = s;
      const v = $('video'); v.hidden = false; v.srcObject = stream; await v.play();
      track = stream.getVideoTracks()[0];
      const caps = (track.getCapabilities && track.getCapabilities()) || {};
      try { if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) {}
      $('torchBtn').textContent = 'Flash';
      $('torchBtn').hidden = !caps.torch;
      $('zoomBtn').hidden = !(caps.zoom && caps.zoom.max >= 1.8);
      camOn = true;
      $('stage').classList.remove('idle'); $('stageIdle').hidden = true; $('stageTools').hidden = false;
      store.set('camOK', true);
      scanLoop();
      if (caps.torch && store.get('flashOn', true)) {          // flash on by default while scanning
        if (!(await setTorch(true))) setTimeout(() => { if (camOn) setTorch(true); }, 400);  // some phones need a moment
      }
    } catch (err) {
      const why = err && err.name === 'NotAllowedError' ? 'Allow camera for this site in Chrome settings, then tap Start camera.'
        : !detector && !('BarcodeDetector' in window) ? 'The barcode reader did not load. Check the internet and try again.'
        : 'Close other apps using the camera, then tap Start camera.';
      flash('bad', 'Camera did not start.', why);
      await stopCam();
    } finally { $('camStart').disabled = false; }
  }

  // Copy just the white box (plus a little margin) out of the video, at most 1280 px wide.
  function grabBox(v) {
    const W = v.clientWidth, H = v.clientHeight, vw = v.videoWidth, vh = v.videoHeight;
    if (!W || !H || !vw || !vh) return null;
    const scale = Math.max(W / vw, H / vh), ox = (vw * scale - W) / 2, oy = (vh * scale - H) / 2;
    const sx = (ox + W * 0.04) / scale, sy = (oy + H * 0.25) / scale, sw = (W * 0.92) / scale, sh = (H * 0.50) / scale;
    const maxW = detectorKind === 'native' ? 1280 : 960;
    const k = Math.min(1, maxW / sw);
    const tw = Math.max(1, Math.round(sw * k)), th = Math.max(1, Math.round(sh * k));
    if (crop.width !== tw || crop.height !== th) { crop.width = tw; crop.height = th; }
    cctx.drawImage(v, sx, sy, sw, sh, 0, 0, tw, th);
    return crop;
  }

  let speedEl = null, nChecks = 0, speedTimer = 0;
  function showSpeed() {
    if (!speedEl) {
      speedEl = document.createElement('div');
      speedEl.style.cssText = 'position:absolute;left:10px;bottom:10px;z-index:3;font:600 11px/1.2 system-ui,sans-serif;color:#fff;background:rgb(0 0 0 / .5);padding:4px 8px;border-radius:99px;pointer-events:none';
      $('stage').appendChild(speedEl);
    }
    clearInterval(speedTimer); nChecks = 0;
    speedTimer = setInterval(() => {
      if (!camOn) { speedEl.hidden = true; return; }
      const s = track && track.getSettings ? track.getSettings() : {};
      speedEl.hidden = false;
      speedEl.textContent = (detectorKind === 'native' ? 'Phone reader' : 'Web reader') + ' · ' + nChecks + '/s · ' + (s.width || '?') + '×' + (s.height || '?') + (torch ? ' · flash' : '');
      nChecks = 0;
    }, 1000);
  }

  function scanLoop() {
    const v = $('video');
    let running = false;
    showSpeed();
    const tick = async () => {
      if (!camOn) return;
      if (!running && !document.hidden && v.readyState >= 2) {
        running = true;
        try {
          const img = grabBox(v);
          if (img) {
            const found = await detector.detect(img); nChecks++;
            onFrame(found.map(b => ({ code: String(b.rawValue || '').trim(), format: b.format })).filter(c => c.code));
          }
        } catch (e) {}
        running = false;
      }
      next();
    };
    const next = () => {
      if (!camOn) return;
      if (v.requestVideoFrameCallback) rvfc = v.requestVideoFrameCallback(tick);   // run once per new camera frame
      else loopTimer = setTimeout(tick, 30);
    };
    next();
  }

  async function stopCam() {
    clearTimeout(loopTimer); clearInterval(speedTimer); if (speedEl) speedEl.hidden = true;
    const v = $('video');
    try { if (rvfc && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(rvfc); } catch (e) {}
    camOn = false;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    track = null; torch = false; zoomed = false;
    $('torchBtn').setAttribute('aria-pressed', 'false'); $('zoomBtn').setAttribute('aria-pressed', 'false');
    v.srcObject = null;
    $('stage').classList.add('idle'); $('stageIdle').hidden = false; $('stageTools').hidden = true;
    closePick();
  }

  async function maybeAutoStartCam() {
    if (camOn || (current !== 'scan' && current !== 'cancel') || $('app').hidden) return;
    let granted = false;
    try { granted = (await navigator.permissions.query({ name: 'camera' })).state === 'granted'; } catch (e) { granted = false; }
    if (granted && store.get('camOK', false)) startCam();
  }

  $('camStart').onclick = () => { beep(true); startCam(); };
  $('camStop').onclick = () => { store.set('camOK', false); stopCam(); };
  $('torchBtn').onclick = async () => {
    const want = !torch;
    store.set('flashOn', want);
    await setTorch(want);
  };
  $('zoomBtn').onclick = async () => {
    if (!track) return; zoomed = !zoomed;
    const caps = track.getCapabilities();
    try { await track.applyConstraints({ advanced: [{ zoom: zoomed ? Math.min(2, caps.zoom.max) : Math.max(1, caps.zoom.min), torch }] }); } catch (e) { zoomed = false; }
    $('zoomBtn').setAttribute('aria-pressed', String(zoomed));
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (camOn) { stopCam(); resumeCam = true; } }
    else if (resumeCam) { resumeCam = false; if (current === 'scan' || current === 'cancel') startCam(); }
  });
  let resumeCam = false;

  /* ================= rendering ================= */
  function rowHTML(r, isAdmin, opts) {
    opts = opts || {};
    const cx = r.status === 'Cancelled';
    const when = opts.showDate ? (r.date || '').split('-').reverse().slice(0, 2).join('/') + ' ' + (r.time || '').slice(0, 5) : (r.time || fmtTime(r.ts)).slice(0, 5);
    const pills = `<span class="pill ${esc(r.platform)}">${r.platform === 'Meesho' ? 'MS' : 'FK'}</span>` +
      (r.waiting ? (online === false ? '<span class="pill wait">Waiting</span>' : '<span class="pill wait">Sending</span>') : '') +
      (cx ? '<span class="pill cx">Cancelled</span>' : '') + (!cx && r.check === 'DISPATCHED AGAIN' ? '<span class="pill wait">Again</span>' : '');
    const info = `<span class="awb">${esc(r.packet)}</span>${r.courier ? `<span class="by">${esc(r.courier)}</span>` : ''}<span class="by">${esc(r.by)}</span>` +
      (cx ? `<span class="by" style="color:var(--bad)">${esc(r.cancelReason || 'Cancelled')} · ${esc((r.cancelledAt || '').slice(5).split(' ')[0].split('-').reverse().join('/'))} ${esc((r.cancelledAt || '').slice(11))} · ${esc(r.cancelledBy || '')}</span>` : '');
    const acts = [];
    if (!r.waiting && opts.cancelBtn && !cx) acts.push(`<button class="del" data-cx="${esc(r.awb)}">Cancel</button>`);
    if (!r.waiting && cx && isAdmin && opts.undoBtn !== false) acts.push(`<button class="del" data-undo="${esc(r.awb)}" data-ts="${esc(r.ts)}">Undo</button>`);
    if (!r.waiting && !cx && isAdmin && opts.delBtn !== false) acts.push(`<button class="del" data-del="${esc(r.awb)}" data-ts="${esc(r.ts)}">Delete</button>`);
    return `<tr class="${cx ? 'cancelled' : ''}"><td class="mono">${esc(when)}</td><td>${pills}<div class="awb">${esc(r.awb)}</div></td><td>${info}</td><td class="n"><div class="acts">${acts.join('')}</div></td></tr>`;
  }

  function tally(list) {
    let fk = 0, ms = 0; const by = {};
    list.forEach(r => {
      if (r.platform === 'Meesho') ms++; else fk++;
      const name = products[r.packet] || r.product || ('Unnamed · ' + r.packet);
      by[name] = by[name] || { f: 0, m: 0 }; by[name][r.platform === 'Meesho' ? 'm' : 'f']++;
    });
    return { fk, ms, by };
  }
  function render() {
    const isAdmin = user && user.role === 'admin';
    // mini counter on Scan screen (always today)
    const tw = queue.filter(q => q.date === today());
    const t = tally(tw.concat(todayRows).filter(r => r.status !== 'Cancelled'));
    setText($('mAll'), t.fk + t.ms); setText($('mFk'), t.fk); setText($('mMs'), t.ms);
    $('mQ').hidden = !queue.length || online !== false; setText($('mQ'), queue.length + ' waiting to upload');

    // Today / chosen day
    const day = viewDay, isToday = day === today();
    const waiting = queue.filter(q => q.date === day).map(q => Object.assign({ waiting: true }, q));
    const all = waiting.concat(isToday ? todayRows : viewRows).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const live = all.filter(r => r.status !== 'Cancelled'), nCan = all.length - live.length;
    const v = tally(live);
    const nCx = isToday ? cancelledRows.length + nCan : nCan;
    $('tCan').hidden = !nCx; setText($('tCan'), nCx + ' parcel' + (nCx === 1 ? '' : 's') + ' cancelled today – removed from dispatch (see Cancel tab)');
    setText($('dayTitle'), isToday ? 'Today' : day);
    setText($('tAll'), v.fk + v.ms); setText($('tFk'), v.fk); setText($('tMs'), v.ms);
    const names = Object.keys(v.by).sort((a, b) => (v.by[b].f + v.by[b].m) - (v.by[a].f + v.by[a].m));
    const bc = {};
    live.forEach(r => { const k = (r.platform === 'Meesho' ? 'Meesho' : 'Flipkart') + (r.courier ? ' · ' + r.courier : ''); bc[k] = (bc[k] || 0) + 1; });
    const cks = Object.keys(bc).sort();
    setHTML($('byCourier'), cks.length ? cks.map(k => `<tr><td>${esc(k)}</td><td class="n"><b>${bc[k]}</b></td></tr>`).join('')
      : '<tr><td colspan="2" class="empty">No parcels yet.</td></tr>');
    $('byProd').closest('.card').hidden = !PORTALS;
    setHTML($('byProd'), names.length
      ? names.map(n => `<tr><td>${esc(n)}</td><td class="n">${v.by[n].f}</td><td class="n">${v.by[n].m}</td><td class="n"><b>${v.by[n].f + v.by[n].m}</b></td></tr>`).join('')
      : `<tr><td colspan="4" class="empty">No packets${isToday ? ' yet today' : ' on this day'}.</td></tr>`);
    setText($('logCount'), all.length + ' packet' + (all.length === 1 ? '' : 's'));
    setHTML($('log'), all.length ? all.map(r => rowHTML(r, isAdmin)).join('') : `<tr><td colspan="4" class="empty">Nothing scanned${isToday ? ' yet today. Go to Scan and scan the first AWB.' : ' on this day.'}</td></tr>`);

    const pk = Object.keys(products).sort((a, b) => products[a].localeCompare(products[b]));
    setHTML($('prods'), pk.length
      ? pk.map(c => `<tr><td class="mono">${esc(c)}</td><td>${esc(products[c])}${skus[c] ? `<span class="by">SKU ${esc(skus[c])}</span>` : '<span class="by unk">No SKU – not checked</span>'}</td><td class="n"><button class="del" data-pdel="${esc(c)}">Remove</button></td></tr>`).join('')
      : `<tr><td class="empty">No packet codes yet. Type or scan a packet barcode above and give it a name.</td></tr>`);
  }

  document.addEventListener('click', async e => {
    const d = e.target.closest('[data-del]'), pd = e.target.closest('[data-pdel]'), nm = e.target.closest('[data-name]');
    const b = d || pd;
    if (b) {
      if (!b.classList.contains('arm')) {
        b.classList.add('arm'); b.textContent = 'Sure?';
        setTimeout(() => { if (b.isConnected) { b.classList.remove('arm'); b.textContent = d ? 'Delete' : 'Remove'; } }, 3000);
        return;
      }
      b.disabled = true;
      try {
        if (d) {
          const dts = Number(d.dataset.ts) || 0, same = r => r.awb === d.dataset.del && (!dts || Number(r.ts) === dts);
          const j = await api('POST', { action: 'delete', awb: d.dataset.del, ts: dts });
          const gone = [todayRows, viewRows, searchRows].flat().find(same);
          applyEvent(j.event || { type: 'deleted', awb: d.dataset.del, packet: gone ? gone.packet : '' }); store.set('used', used);
          todayRows = todayRows.filter(r => !same(r)); viewRows = viewRows.filter(r => !same(r));
          searchRows = searchRows.filter(r => !same(r)); cancelledRows = cancelledRows.filter(r => !same(r)); renderSearch(); renderCancelled();
          const left = j.event && j.event.after && j.event.after.s;
          flash('ok', 'Deleted ' + d.dataset.del, left === 'cancelled' ? 'Its earlier cancelled entry is kept. Scan it again to dispatch.' : 'This AWB and its packet barcode can be scanned again.');
        } else {
          await api('POST', { action: 'deleteProduct', code: pd.dataset.pdel });
          delete products[pd.dataset.pdel]; delete skus[pd.dataset.pdel]; store.set('products', products); store.set('skus', skus);
        }
      } catch (err) { alertMsg(err.message); }
      render(); return;
    }
    if (nm) { go('codes'); $('pCode').value = nm.dataset.name; const pkt = [todayRows, viewRows].flat().find(r => r.packet === nm.dataset.name && r.orderSku && !r.orderSku.includes(',')); if (pkt) $('pSku').value = pkt.orderSku; $('pName').focus(); }
  });
  const alertMsg = m => { if (current === 'scan') flash('bad', 'Could not do that.', m); else { $('expMsg').textContent = m; } };

  $('prodForm').addEventListener('submit', async e => {
    e.preventDefault();
    const code = $('pCode').value.trim(), name = $('pName').value.trim(), sku = $('pSku').value.trim();
    if (!code || (!name && !sku)) { $('pName').setCustomValidity('Enter a product name or SKU.'); $('pName').reportValidity(); setTimeout(() => $('pName').setCustomValidity(''), 2000); return; }
    const btn = e.submitter; if (btn) btn.disabled = true;
    try {
      await api('POST', { action: 'product', code, name, sku });
      products[code] = name || products[code] || sku; if (sku) skus[code] = sku;
      store.set('products', products); store.set('skus', skus);
      if (name) [todayRows, viewRows].forEach(list => list.forEach(r => { if (r.packet === code && !r.product) r.product = name; }));
      $('pCode').value = ''; $('pName').value = ''; $('pSku').value = ''; render();
    } catch (err) { $('pName').setCustomValidity(err.message); $('pName').reportValidity(); setTimeout(() => $('pName').setCustomValidity(''), 2000); }
    finally { if (btn) btn.disabled = false; }
  });

  /* ================= loading + sync ================= */
  async function loadSettings() {
    try { const j = await api('GET', { action: 'settings' }); if (j.settings) { cfg2 = j.settings; store.set('settings', cfg2); renderCouriers(); fillMfCouriers(); } } catch (err) {}
  }
  let usedLoading = false;
  async function loadUsed() {
    if (usedLoading || !token) return; usedLoading = true;
    try {
      let j = await api('GET', { action: 'used', since: used.ts || 0, esince: used.ets || 0 });
      if (j.v && used.sv !== j.v) { used.ts = 0; used.ets = 0; used.sv = j.v; j = await api('GET', { action: 'used', since: 0, esince: 0 }); }
      if (j.full) { used.a = {}; used.p = {}; used.c = {}; queue.forEach(r => { used.a[r.awb] = r.date; used.p[r.packet] = r.date; }); }
      Object.assign(used.a, j.awbs || {}); Object.assign(used.p, j.packets || {}); Object.assign(used.c, j.cancelled || {}); Object.assign(used.cr, j.reasons || {});
      (j.live || []).forEach(k => { delete used.c[k]; delete used.cr[k]; });
      (j.events || []).sort((x, y) => x.t - y.t).forEach(applyEvent);
      used.ts = j.latest || used.ts; used.ets = j.elatest || used.ets; store.set('used', used);
    } catch (err) {} finally { usedLoading = false; }
  }

  async function loadToday() {
    if (!token) return;
    try {
      const j = await api('GET', { action: 'list', date: today() });
      todayRows = (j.rows || []).sort((a, b) => (b.ts || 0) - (a.ts || 0));
      if (viewDay === today()) viewRows = todayRows;
      setConn('on');
    } catch (err) { if (!err.server) setConn('off'); }
    render();
  }
  async function loadView() {
    try { const j = await api('GET', { action: 'list', date: viewDay }); viewRows = j.rows || []; } catch (err) { viewRows = []; }
    render();
  }
  async function loadProducts() {
    if (!token) return;
    try {
      const j = await api('GET', { action: 'products' });
      products = {}; skus = {};
      (j.products || []).forEach(p => { products[p.code] = p.name || p.sku; if (p.sku) skus[p.code] = p.sku; });
      store.set('products', products); store.set('skus', skus); render();
    } catch (err) {}
  }
  let syncing = false;
  async function syncQueue() {
    if (syncing || !queue.length || !token) return;
    syncing = true;
    try {
      while (queue.length) {
        const rec = queue[0];
        let j;
        try { j = await api('POST', { action: 'add', rec }); }
        catch (err) {
          if (!err.server) { setConn('off'); break; }           // no internet: keep it, try later
          queue.shift(); store.set('queue', queue);              // the Sheet refused it: tell the packer
          flash('bad', 'Not saved · ' + rec.awb, err.message); beep(false);
          continue;
        }
        queue.shift(); store.set('queue', queue);
        if (j.dup) {
          const e = j.existing || {};
          const what = j.kind === 'awb' && e.status === 'Cancelled' ? 'AWB ' + rec.awb + ' was cancelled earlier' : j.kind === 'packet' ? 'Packet ' + rec.packet + ' already used' : j.kind === 'packet-as-awb' ? 'Packet ' + rec.packet + ' is an old AWB' : j.kind === 'awb-as-packet' ? 'AWB ' + rec.awb + ' is an old packet code' : 'AWB ' + rec.awb + ' already scanned';
          flash('bad', '✗ ' + what + ' – not saved', 'Found in the Sheet: ' + (e.date || '') + ' ' + (e.time || '') + ' · ' + (e.by || '') + '. Check this parcel.');
          beep(false); pulse(false);
        } else {
          todayRows = todayRows.filter(r => !(r.awb === rec.awb && Number(r.ts) === Number(rec.ts)));
          todayRows.unshift(j.row || rec);
          setConn('on');
        }
        render();
      }
    } finally { syncing = false; render(); }
  }
  window.addEventListener('online', syncQueue);
  setInterval(() => { if (!document.hidden && token && !$('app').hidden) { syncQueue(); loadUsed(); if (!busy) loadToday(); } }, 25000);
  setInterval(() => { if (PORTALS && !document.hidden && token && !$('app').hidden) loadOrders(); }, 120000);
  $('syncBtn').onclick = async e => {
    e.stopPropagation(); const b = $('syncBtn'); b.disabled = true; $('syncLine').textContent = 'Syncing with Flipkart…';
    try { const j = await api('POST', { action: 'syncNow' }); if (j.orders) buildOrders(j.orders); syncInfo = j.sync || syncInfo; store.set('orders', j.orders || []); renderSync(); }
    catch (err) { $('syncLine').textContent = 'Sync failed: ' + err.message; }
    finally { b.disabled = false; }
  };

  $('day').addEventListener('change', () => { viewDay = $('day').value || today(); viewRows = []; render(); if (viewDay === today()) { viewRows = todayRows; render(); } else loadView(); });

  /* ================= Excel ================= */
  document.querySelectorAll('[data-range]').forEach(b => b.onclick = () => {
    const r = b.dataset.range;
    if (r === 'm') { const d = new Date(); $('from').value = new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('en-CA'); $('to').value = today(); }
    else if (r === '1') { $('from').value = $('to').value = dayOffset(1); }
    else { $('from').value = dayOffset(Number(r) ? Number(r) - 1 : 0); $('to').value = today(); }
  });
  $('exportBtn').onclick = async () => {
    const from = $('from').value, to = $('to').value, m = $('expMsg');
    if (!from || !to || from > to) { m.className = 'msg bad'; m.textContent = 'Pick a From date on or before the To date.'; return; }
    if (!window.XLSX) { m.className = 'msg bad'; m.textContent = 'Excel tool did not load. Check internet and reload.'; return; }
    m.className = 'msg'; m.textContent = 'Preparing…'; $('exportBtn').disabled = true;
    try {
      const j = await api('GET', { action: 'range', from, to });
      const list = (j.rows || []).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (!list.length) { m.textContent = 'No dispatches between ' + from + ' and ' + to + '.'; return; }
      const nameOf = r => products[r.packet] || r.product || '';
      const s1 = list.map((r, i) => PORTALS
        ? ({ 'S.No': i + 1, 'Date': r.date, 'Time': r.time, 'Platform': r.platform, 'AWB Number': r.awb, 'Packet Barcode': r.packet, 'Product': nameOf(r), 'Scanned By': r.by, 'Order ID': r.orderId || '', 'Order SKU': r.orderSku || '', 'Check': r.check || '', 'Delivery Partner': r.courier || '' })
        : ({ 'S.No': i + 1, 'Date': r.date, 'Time': r.time, 'Platform': r.platform, 'Delivery Partner': r.courier || '', 'AWB Number': r.awb, 'Packet Barcode': r.packet, 'Scanned By': r.by,
             'Status': r.status === 'Cancelled' ? 'Cancelled' : r.check === 'DISPATCHED AGAIN' ? 'Dispatched again' : 'Dispatched', 'Cancelled At': r.cancelledAt || '', 'Cancelled By': r.cancelledBy || '', 'Cancel Reason': r.cancelReason || '' }));
      const agg = {};
      list.forEach(r => { const k = [r.date, r.platform, nameOf(r) || ('Unnamed ' + r.packet)].join('|'); agg[k] = (agg[k] || 0) + 1; });
      const s2 = Object.keys(agg).sort().map(k => { const [d, p, n] = k.split('|'); return { 'Date': d, 'Platform': p, 'Product': n, 'Packets': agg[k] }; });
      s2.push({ 'Date': 'TOTAL', 'Platform': '', 'Product': '', 'Packets': list.length });
      const wb = XLSX.utils.book_new();
      const w1 = XLSX.utils.json_to_sheet(s1);
      w1['!cols'] = PORTALS ? [{ wch: 6 }, { wch: 11 }, { wch: 10 }, { wch: 10 }, { wch: 22 }, { wch: 20 }, { wch: 26 }, { wch: 16 }, { wch: 22 }, { wch: 18 }, { wch: 11 }, { wch: 16 }]
        : [{ wch: 6 }, { wch: 11 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 24 }, { wch: 24 }, { wch: 16 }, { wch: 11 }, { wch: 17 }, { wch: 14 }, { wch: 22 }];
      XLSX.utils.book_append_sheet(wb, w1, 'Dispatch');
      if (PORTALS) { const w2 = XLSX.utils.json_to_sheet(s2); w2['!cols'] = [{ wch: 11 }, { wch: 10 }, { wch: 28 }, { wch: 9 }]; XLSX.utils.book_append_sheet(wb, w2, 'Summary'); }
      const cagg = {}; list.filter(r => r.status !== 'Cancelled').forEach(r => { const k = [r.date, r.platform, r.courier || '—'].join('|'); cagg[k] = (cagg[k] || 0) + 1; });
      const s3 = Object.keys(cagg).sort().map(k => { const [d, p, c] = k.split('|'); return { 'Date': d, 'Platform': p, 'Delivery Partner': c, 'Parcels': cagg[k] }; });
      const nLive = list.filter(r => r.status !== 'Cancelled').length;
      s3.push({ 'Date': 'TOTAL', 'Platform': '', 'Delivery Partner': '', 'Parcels': nLive });
      let cxl = [];
      try { cxl = (await api('GET', { action: 'cancelledRange', from, to })).rows || []; } catch (e) {}
      if (cxl.length) s3.push({ 'Date': 'Cancelled (removed)', 'Platform': '', 'Delivery Partner': '', 'Parcels': cxl.length });
      const w3 = XLSX.utils.json_to_sheet(s3); w3['!cols'] = [{ wch: 11 }, { wch: 10 }, { wch: 18 }, { wch: 9 }];
      XLSX.utils.book_append_sheet(wb, w3, PORTALS ? 'By Delivery Partner' : 'Summary');
      if (cxl.length) {
        const w4 = XLSX.utils.json_to_sheet(cxl.map((r, i) => ({ 'S.No': i + 1, 'Scanned On': r.date, 'Platform': r.platform, 'Delivery Partner': r.courier || '', 'AWB Number': r.awb, 'Packet Barcode': r.packet, 'Cancelled At': r.cancelledAt, 'Cancelled By': r.cancelledBy, 'Reason': r.cancelReason })));
        w4['!cols'] = [{ wch: 6 }, { wch: 11 }, { wch: 10 }, { wch: 16 }, { wch: 24 }, { wch: 24 }, { wch: 17 }, { wch: 14 }, { wch: 22 }];
        XLSX.utils.book_append_sheet(wb, w4, 'Cancelled');
      }
      const fn = 'Dispatch_' + from + (from === to ? '' : '_to_' + to) + '.xlsx';
      XLSX.writeFile(wb, fn);
      m.className = 'msg ok'; m.textContent = 'Downloaded ' + fn + ' (' + nLive + ' dispatched' + (cxl.length ? ', ' + cxl.length + ' cancelled' : '') + ').';
    } catch (err) { m.className = 'msg bad'; m.textContent = 'Export failed: ' + err.message; }
    finally { $('exportBtn').disabled = false; }
  };

  /* ================= camera box moves between Scan and Cancel ================= */
  const stageHome = { parent: $('stage').parentNode, next: $('stage').nextSibling };
  function placeStage(view) {
    const st = $('stage');
    if (view === 'cancel' && st.parentNode !== $('cancelSlot')) { closePick(); $('cancelSlot').appendChild(st); }
    else if (view === 'scan' && st.parentNode !== stageHome.parent) stageHome.parent.insertBefore(st, stageHome.next);
  }

  /* ================= cancelled at pickup ================= */
  const REASONS = ['Order cancelled', 'Courier did not pick up', 'Damaged', 'Other'];
  let reason = store.get('cancelReason', REASONS[0]);
  function renderReasons() {
    if (!REASONS.includes(reason)) reason = REASONS[0];
    setHTML($('reasonChips'), REASONS.map(r => `<button type="button" data-reason="${esc(r)}" aria-pressed="${r === reason}">${esc(r)}</button>`).join(''));
  }
  $('reasonChips').onclick = e => {
    const b = e.target.closest('[data-reason]'); if (!b) return;
    reason = b.dataset.reason; store.set('cancelReason', reason);
    $('reasonChips').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  };
  function cflash(kind, title, sub) { const f = $('cflash'); f.className = 'flash ' + kind; f.innerHTML = '<b>' + esc(title) + '</b><span>' + esc(sub || '') + '</span>'; }
  let cancelledRows = [];
  function updateRow(row) {
    [todayRows, viewRows, searchRows, cancelledRows].forEach(list => { const i = list.findIndex(r => r.awb === row.awb && (!row.ts || Number(r.ts) === Number(row.ts))); if (i >= 0) list[i] = Object.assign({}, list[i], row); });
  }
  async function cancelCode(code, why) {
    if (busy) return;
    busy = true;
    try {
      // a packet barcode scanned by mistake: find its AWB if we know it
      const viaPkt = [todayRows, viewRows].flat().find(r => r.packet === code && r.status !== 'Cancelled');
      const awb = usedAwbDay(code) ? code : viaPkt ? viaPkt.awb : code;
      if (queue.some(r => r.awb === awb)) { cflash('warn', 'Still uploading ' + awb, 'Wait a few seconds, then scan again.'); beep(false); syncQueue(); return; }
      if (used.c[awb]) { cflash('warn', 'AWB ' + awb + ' is already cancelled', 'Cancelled ' + fmtDay(used.c[awb]) + '. To send it again, scan it on the Scan tab.'); beep(false); return; }
      cflash('idle', 'Cancelling ' + awb + '…', why || reason);
      let j;
      try { j = await api('POST', { action: 'cancel', awb, reason: why || reason }); }
      catch (err) {
        if (err.server) { cflash('bad', '✗ ' + err.message, used.p[code] && !viaPkt ? 'That looks like a packet barcode. Scan the AWB.' : 'Check the AWB and try again.'); }
        else cflash('bad', '✗ No internet. Not cancelled.', 'Connect and scan the AWB again.');
        beep(false); pulse(false); return;
      }
      applyEvent(j.event); store.set('used', used);
      const same = r => r.awb === j.row.awb && Number(r.ts) === Number(j.row.ts);
      todayRows = todayRows.filter(r => !same(r)); viewRows = viewRows.filter(r => !same(r));
      searchRows = searchRows.filter(r => !same(r)); if (!$('searchBox').hidden) searchRows.unshift(j.row);
      if (!cancelledRows.some(same)) cancelledRows.unshift(j.row);
      cflash('ok', '✓ Cancelled · removed from dispatch · ' + awb, (why || reason) + '. The AWB and packet ' + j.row.packet + ' can be scanned again.');
      beep(true); pulse(true);
      render(); renderCancelled(); renderSearch();
    } finally { busy = false; }
  }
  $('cManualForm').addEventListener('submit', e => { e.preventDefault(); const v = $('cManual').value.trim(); $('cManual').value = ''; $('cManual').blur(); if (v) cancelCode(v); });
  async function loadCancelled() {
    try { const j = await api('GET', { action: 'cancelled', date: today() }); cancelledRows = (j.rows || []).sort((x, y) => (y.cancelledAt > x.cancelledAt ? 1 : -1)); }
    catch (err) {}
    renderCancelled(); render();
  }
  function renderCancelled() {
    const isAdmin = user && user.role === 'admin';
    setText($('cCount'), cancelledRows.length + ' parcel' + (cancelledRows.length === 1 ? '' : 's'));
    setHTML($('cList'), cancelledRows.length ? cancelledRows.map(r => rowHTML(r, isAdmin, { showDate: true, delBtn: false })).join('')
      : '<tr><td class="empty">No parcels cancelled today.</td></tr>');
  }
  async function undoCancel(awb, ts) {
    try {
      const j = await api('POST', { action: 'uncancel', awb, ts: Number(ts) || 0 });
      applyEvent(j.event); store.set('used', used);
      const back = r => r.awb === awb && (!ts || Number(r.ts) === Number(ts));
      cancelledRows = cancelledRows.filter(r => !back(r));
      searchRows = searchRows.map(r => back(r) && r.status === 'Cancelled' ? j.row : r);
      if (j.row.date === today() && !todayRows.some(r => r.awb === awb && Number(r.ts) === Number(j.row.ts))) todayRows.unshift(j.row);
      const msg = ['✓ Cancel undone · ' + awb, 'Back in the dispatch list.'];
      current === 'cancel' ? cflash('ok', ...msg) : flash('ok', ...msg);
      render(); renderCancelled(); renderSearch();
    } catch (err) { current === 'cancel' ? cflash('bad', '✗ ' + err.message) : flash('bad', '✗ Could not undo', err.message); }
  }

  /* ================= search ================= */
  let searchRows = [], searchTimer = 0, searchSeq = 0;
  async function runSearch() {
    const q = $('q').value.trim();
    $('qClear').hidden = !q;
    $('searchBox').hidden = q.length < 1; $('dayBox').hidden = q.length >= 1;
    if (q.length < 3) { searchRows = []; setText($('sCount'), q ? 'Type at least 3 characters' : ''); setHTML($('sList'), ''); return; }
    const seq = ++searchSeq;
    setText($('sCount'), 'Searching…');
    const Q = q.toUpperCase();
    const local = queue.filter(r => r.awb.toUpperCase().includes(Q) || r.packet.toUpperCase().includes(Q)).map(r => Object.assign({ waiting: true }, r));
    try {
      const j = await api('GET', { action: 'search', q });
      if (seq !== searchSeq) return;
      searchRows = local.concat(j.rows || []);
    } catch (err) {
      if (seq !== searchSeq) return;
      searchRows = local; setText($('sCount'), err.server ? err.message : 'No internet – showing this phone only');
    }
    renderSearch();
  }
  function renderSearch() {
    if ($('searchBox').hidden) return;
    const isAdmin = user && user.role === 'admin';
    if ($('sCount').textContent === 'Searching…' || /^\d+ found/.test($('sCount').textContent) || !$('sCount').textContent) setText($('sCount'), searchRows.length + ' found' + (searchRows.length >= 50 ? ' (first 50)' : ''));
    setHTML($('sList'), searchRows.length ? searchRows.map(r => rowHTML(r, isAdmin, { showDate: true, cancelBtn: true })).join('')
      : '<tr><td class="empty">No AWB or packet barcode matches.</td></tr>');
  }
  $('q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 350); });
  $('searchForm').addEventListener('submit', e => { e.preventDefault(); clearTimeout(searchTimer); runSearch(); $('q').blur(); });
  $('qClear').onclick = () => { $('q').value = ''; runSearch(); };

  // Cancel / Undo buttons in lists
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-cx]'), u = e.target.closest('[data-undo]');
    const b = c || u; if (!b) return;
    if (!b.classList.contains('arm')) {
      b.classList.add('arm'); b.textContent = 'Sure?';
      setTimeout(() => { if (b.isConnected) { b.classList.remove('arm'); b.textContent = c ? 'Cancel' : 'Undo'; } }, 3000);
      return;
    }
    b.disabled = true;
    if (c) cancelCode(c.dataset.cx).finally(() => { setText($('sCount'), $('cflash').querySelector('b').textContent); });
    else undoCancel(u.dataset.undo, u.dataset.ts).finally(() => { if (current === 'today') setText($('sCount'), 'Cancel undone · ' + u.dataset.undo); });
  });

  /* ================= signed manifest ================= */
  let mfFiles = [];
  function fillMfCouriers(preferScan) {
    const p = $('mfPlatform').value, list = (p === 'Meesho' ? cfg2.meeshoCouriers : cfg2.flipkartCouriers) || [];
    const keep = (preferScan === true && p === 'Meesho' && courier) ? courier : ($('mfCourier').value || (p === 'Meesho' ? courier : ''));
    $('mfCourier').innerHTML = list.map(c => `<option${c === keep ? ' selected' : ''}>${esc(c)}</option>`).join('') + '<option value="Other">Other</option>';
    mfCount();
  }
  function mfCount() {
    const p = $('mfPlatform').value, c = $('mfCourier').value;
    const rows = queue.filter(r => r.date === today()).concat(todayRows).filter(r => r.platform === p && r.status !== 'Cancelled');
    const n = rows.filter(r => !r.courier || r.courier.toLowerCase().indexOf(c.toLowerCase()) === 0).length;
    $('mfCount').textContent = 'Scanned today for ' + p + ' · ' + c + ': ' + n + ' parcel' + (n === 1 ? '' : 's') + '. Match this with the count on the manifest.';
  }
  $('mfPlatform').onchange = () => fillMfCouriers(true);
  $('mfCourier').onchange = mfCount;
  $('mfFiles').onchange = e => {
    mfFiles = mfFiles.concat([...e.target.files]).slice(0, 20); e.target.value = '';
    renderMfList(); $('mfMsg').textContent = '';
  };
  function renderMfList(states) {
    $('mfList').innerHTML = mfFiles.map((f, i) => `<li class="${states && states[i] || ''}"><span>Page ${i + 1} · ${esc(f.name || 'photo')}</span><span>${states && states[i] === 'ok' ? '✓ Saved' : states && states[i] === 'bad' ? 'Failed' : (f.size / 1048576).toFixed(1) + ' MB'}</span></li>`).join('');
    $('mfBtn').disabled = !mfFiles.length;
    $('mfBtn').textContent = mfFiles.length ? 'Upload ' + mfFiles.length + ' page' + (mfFiles.length === 1 ? '' : 's') + ' to Drive' : 'Upload to Drive';
  }
  // Phone photos are 3–8 MB. Shrink to about 2000 px, which keeps signatures readable and uploads fast.
  async function prepFile(f) {
    if (f.type === 'application/pdf') return { type: 'application/pdf', blob: f };
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      const blob = await new Promise(ok => cv.toBlob(ok, 'image/jpeg', 0.85));
      if (blob) return { type: 'image/jpeg', blob };
    } catch (e) {}
    return { type: /^image\/(jpeg|png|webp|heic|heif)$/.test(f.type) ? f.type : 'image/jpeg', blob: f };
  }
  const toB64 = blob => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = no; r.readAsDataURL(blob); });
  $('mfForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!mfFiles.length) return;
    const btn = $('mfBtn'), msg = $('mfMsg'), states = mfFiles.map(() => '');
    btn.disabled = true; msg.className = 'msg';
    let done = 0;
    for (let i = 0; i < mfFiles.length; i++) {
      msg.textContent = 'Uploading page ' + (i + 1) + ' of ' + mfFiles.length + '…';
      try {
        const f = await prepFile(mfFiles[i]);
        const data = await toB64(f.blob);
        await api('POST', { action: 'manifest', platform: $('mfPlatform').value, courier: $('mfCourier').value, page: i + 1, type: f.type, data });
        states[i] = 'ok'; done++;
      } catch (err) { states[i] = 'bad'; msg.textContent = 'Page ' + (i + 1) + ' failed: ' + err.message; }
      renderMfList(states);
    }
    if (done === mfFiles.length) {
      msg.className = 'msg ok'; msg.textContent = '✓ Saved ' + done + ' page' + (done === 1 ? '' : 's') + ' in Google Drive › ' + today();
      mfFiles = []; setTimeout(() => renderMfList(), 1500);
    } else {
      msg.className = 'msg bad'; msg.textContent += ' Tap Upload again to retry the failed pages.';
      mfFiles = mfFiles.filter((_, i) => states[i] !== 'ok'); setTimeout(() => renderMfList(), 1500);
    }
    btn.disabled = !mfFiles.length;
    loadManifests();
  });
  async function loadManifests() {
    setText($('mfDay'), today().split('-').reverse().join('-'));
    try {
      const j = await api('GET', { action: 'manifests', date: today() });
      const list = (j.manifests || []).sort((a, b) => a.time < b.time ? 1 : -1);
      setHTML($('mfDone'), list.length ? list.map(m => `<tr><td class="mono">${esc(m.time.slice(0, 5))}</td><td>${esc(m.platform)} · ${esc(m.courier)}<span class="by">Page ${m.page} · ${esc(m.by)} · ${m.parcels} parcels scanned</span></td><td class="n"><a class="linkbtn" href="${esc(m.url)}" target="_blank" rel="noopener">Open</a></td></tr>`).join('')
        : '<tr><td class="empty">No manifest uploaded today yet.</td></tr>');
    } catch (err) { setHTML($('mfDone'), `<tr><td class="empty">${esc(err.message)}</td></tr>`); }
  }

  /* ================= install on the phone ================= */
  // Chrome shows its own "Install app" offer only now and then; this button lets the packer install any time.
  let installEvt = null;
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  function showInstall() {
    const show = !standalone();
    ['installBtn', 'installBtn2'].forEach(id => { const b = $(id); if (b) b.hidden = !show; });
  }
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; showInstall(); });
  window.addEventListener('appinstalled', () => { installEvt = null; ['installBtn', 'installBtn2'].forEach(id => { const b = $(id); if (b) b.hidden = true; }); });
  async function doInstall() {
    $('userMenu').hidden = true;
    if (installEvt) {
      installEvt.prompt();
      try { await installEvt.userChoice; } catch (e) {}
      installEvt = null;
      return;
    }
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const how = isIOS ? 'In Safari tap Share (square with arrow), then "Add to Home Screen".'
      : 'In Chrome tap the ⋮ menu (top right), then "Install app" or "Add to Home screen".';
    if (!$('app').hidden) flash('idle', 'Install from the browser menu', how);
    else { $('lMsg').className = 'msg'; $('lMsg').textContent = how; }
  }
  $('installBtn').onclick = doInstall;
  $('installBtn2').onclick = doInstall;
  showInstall();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  /* ================= start ================= */
  $('day').value = today(); $('from').value = today(); $('to').value = today();
  renderSteps(); render();
  if (url && token && user) {
    showApp();
    api('GET', { action: 'me' }).then(j => { if (j.user) { user = j.user; store.set('user', user); $('userName').textContent = user.name; } }).catch(() => {});
  } else showLogin('');
})();
