/* Dispatch Scan Register – app logic. Talks to the Google Sheet script (see google-sheet-script/Code.gs). */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const today = () => new Date().toLocaleDateString('en-CA');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = ts => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const store = {
    get(k, d) { try { const v = localStorage.getItem('dsr.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('dsr.' + k, JSON.stringify(v)); } catch (e) {} }
  };

  let cfg = store.get('cfg', { url: '', key: '', by: '' });
  let platform = store.get('platform', 'Flipkart');
  let queue = store.get('queue', []);           // scans not yet uploaded
  let rows = [];                                // server rows for the shown day
  let products = {};                            // code -> name
  let step = 1, pendingAwb = '', busy = false, online = false;

  /* ---------- server ---------- */
  async function api(method, params) {
    if (!cfg.url) throw new Error('Google Sheet not connected. Open Settings.');
    let res;
    if (method === 'GET') {
      const u = new URL(cfg.url);
      Object.entries(Object.assign({ key: cfg.key }, params)).forEach(([k, v]) => u.searchParams.set(k, v));
      res = await fetch(u.toString(), { method: 'GET' });
    } else {
      res = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ key: cfg.key }, params)) });
    }
    if (!res.ok) throw new Error('Sheet replied ' + res.status);
    const j = await res.json();
    if (!j.ok && !j.dup) { const e = new Error(j.error || 'Sheet error'); e.server = true; throw e; }
    return j;
  }
  function setConn(state, text) {
    online = state === 'on';
    $('conn').innerHTML = '<span class="dot ' + state + '"></span>' + esc(text);
  }
  function showQueueState() {
    if (!cfg.url) return setConn('off', 'Not connected');
    if (queue.length) setConn('q', queue.length + ' waiting to upload');
    else if (online) setConn('on', 'Connected to Sheet');
  }

  /* ---------- feedback ---------- */
  let actx = null;
  function beep(ok) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = ok ? 1320 : 240; o.type = ok ? 'sine' : 'square'; g.gain.value = 0.08;
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + (ok ? 0.09 : 0.35));
    } catch (e) {}
    try { navigator.vibrate && navigator.vibrate(ok ? 60 : [80, 60, 80]); } catch (e) {}
  }
  function flash(kind, msg, small) { const f = $('flash'); f.className = 'flash ' + kind; f.innerHTML = esc(msg) + (small ? ' <small>' + esc(small) + '</small>' : ''); }

  /* ---------- platform + steps ---------- */
  function setPlatform(p) {
    platform = p; store.set('platform', p);
    document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.p === p)));
  }
  document.querySelectorAll('.seg button').forEach(b => b.onclick = () => { setPlatform(b.dataset.p); focusScan(); });
  setPlatform(platform === 'Meesho' ? 'Meesho' : 'Flipkart');

  function renderSteps() {
    $('s1').className = 'step ' + (step === 1 ? 'on' : 'done');
    $('s2').className = 'step ' + (step === 2 ? 'on' : '');
    $('v1').className = 'val' + (pendingAwb ? '' : ' empty'); $('v1').textContent = pendingAwb || 'Scan the courier label';
    $('scan').placeholder = step === 1 ? 'Scan AWB…' : 'Scan packet barcode…';
  }
  function focusScan() { if (!camOn) $('scan').focus(); }
  function reset() { step = 1; pendingAwb = ''; renderSteps(); $('scan').value = ''; focusScan(); }
  $('cancel').onclick = () => { reset(); flash('idle', 'Reset. Scan the next AWB.'); };

  /* ---------- scan handling ---------- */
  function knownAwb(awb) {
    return rows.find(r => r.awb === awb) || queue.find(r => r.awb === awb);
  }
  async function handle(code) {
    code = String(code || '').trim();
    if (!code || busy) return;
    busy = true;
    try {
      if (step === 1) {
        if (products[code]) { flash('bad', 'That is a packet barcode.', 'Scan the AWB label first.'); beep(false); return; }
        const k = knownAwb(code);
        if (k) { flash('bad', 'Duplicate AWB ' + code, 'Already dispatched ' + (k.date || '') + ' ' + (k.time || '') + ' (' + k.platform + ').'); beep(false); return; }
        if (/^FMP/i.test(code)) setPlatform('Flipkart');
        pendingAwb = code; step = 2; renderSteps();
        flash('idle', 'AWB captured. Now scan the packet barcode.'); beep(true);
      } else {
        if (code === pendingAwb) { flash('warn', 'Same AWB scanned again.', 'Scan the packet barcode now.'); beep(false); return; }
        const ts = Date.now();
        const rec = { awb: pendingAwb, packet: code, platform, by: cfg.by || '', ts, date: today(), time: fmtTime(ts), product: products[code] || '' };
        step = 1; pendingAwb = ''; renderSteps();
        if ($('day').value !== today()) { $('day').value = today(); rows = []; }
        flash('idle', 'Saving ' + rec.awb + '…');
        try {
          const j = await api('POST', { action: 'add', rec });
          if (j.dup) {
            const e = j.existing || {};
            flash('bad', 'Duplicate AWB ' + rec.awb + ' – not saved', 'Already in the Sheet: ' + (e.date || '') + ' ' + (e.time || '') + ' (' + (e.platform || '') + ').');
            beep(false);
          } else {
            rows.unshift(j.row || rec);
            flash(rec.product ? 'ok' : 'warn', 'Saved ' + platform + ' · ' + rec.awb, rec.product || 'New packet code ' + code + '. Name it under Packet codes.');
            beep(true); setConn('on', 'Connected to Sheet'); showQueueState();
          }
        } catch (err) {
          if (err.server) { flash('bad', 'Not saved.', err.message); beep(false); }
          else {
            queue.push(rec); store.set('queue', queue);
            flash('warn', 'Saved on this device · ' + rec.awb, 'No internet. It uploads automatically when you are back online.');
            beep(true); setConn('off', 'Offline'); showQueueState();
          }
        }
        render();
      }
    } finally {
      busy = false; $('scan').value = ''; focusScan();
    }
  }
  $('scan').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); handle($('scan').value); }
    else if (e.key === 'Escape') reset();
  });

  /* ---------- camera ---------- */
  let cam = null, camOn = false, lastCode = '', lastAt = 0;
  async function startCam() {
    if (!window.Html5Qrcode) { flash('bad', 'Camera reader did not load.', 'Check the internet and reload the page.'); return; }
    $('camBox').hidden = false;
    const F = window.Html5QrcodeSupportedFormats;
    cam = cam || new Html5Qrcode('reader', {
      verbose: false,
      formatsToSupport: [F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.ITF, F.CODABAR, F.QR_CODE, F.DATA_MATRIX],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true }
    });
    try {
      await cam.start({ facingMode: 'environment' }, {
        fps: 12,
        qrbox: (w, h) => ({ width: Math.floor(Math.min(w * 0.92, 420)), height: Math.floor(Math.min(h * 0.45, 170)) })
      }, onCamCode, () => {});
      camOn = true; $('camBtn').textContent = 'Stop camera';
      flash('idle', step === 1 ? 'Point the camera at the AWB barcode.' : 'Point the camera at the packet barcode.');
    } catch (err) {
      $('camBox').hidden = true;
      flash('bad', 'Camera did not start.', 'Allow camera access for this site in your browser settings, then try again.');
    }
  }
  async function stopCam() {
    try { if (cam && camOn) await cam.stop(); } catch (e) {}
    camOn = false; $('camBox').hidden = true; $('camBtn').textContent = 'Use camera'; focusScan();
  }
  function onCamCode(text) {
    const now = Date.now();
    if (text === lastCode && now - lastAt < 2500) return;   // ignore the same label held in view
    lastCode = text; lastAt = now;
    handle(text);
  }
  $('camBtn').onclick = () => camOn ? stopCam() : startCam();

  /* ---------- rendering ---------- */
  function render() {
    const day = $('day').value, isToday = day === today();
    const waiting = queue.filter(q => q.date === day);
    const all = waiting.map(q => Object.assign({ waiting: true }, q)).concat(rows).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    $('tallyTitle').textContent = isToday ? "Today's dispatch" : 'Dispatch on ' + day;
    $('logTitle').textContent = 'Dispatch log · ' + day;
    let fk = 0, ms = 0; const by = {};
    all.forEach(r => {
      if (r.platform === 'Meesho') ms++; else fk++;
      const name = products[r.packet] || r.product || ('Unnamed · ' + r.packet);
      by[name] = by[name] || { f: 0, m: 0 }; by[name][r.platform === 'Meesho' ? 'm' : 'f']++;
    });
    $('tAll').textContent = fk + ms; $('tFk').textContent = fk; $('tMs').textContent = ms;
    const names = Object.keys(by).sort((a, b) => (by[b].f + by[b].m) - (by[a].f + by[a].m));
    $('byProd').innerHTML = names.length
      ? names.map(n => `<tr><td>${esc(n)}</td><td class="n">${by[n].f}</td><td class="n">${by[n].m}</td><td class="n"><b>${by[n].f + by[n].m}</b></td></tr>`).join('')
      : `<tr><td colspan="4" class="empty">No packets dispatched${isToday ? ' yet today' : ' on this day'}.</td></tr>`;
    $('logCount').textContent = all.length + ' packet' + (all.length === 1 ? '' : 's');
    $('log').innerHTML = all.length ? all.map(r => {
      const nm = products[r.packet] || r.product;
      return `<tr><td class="mono">${esc(r.time || fmtTime(r.ts))}</td>
        <td><span class="pill ${esc(r.platform)}">${esc(r.platform)}</span>${r.waiting ? ' <span class="pill wait">Waiting</span>' : ''}</td>
        <td class="mono">${esc(r.awb)}</td><td class="mono">${esc(r.packet)}</td>
        <td>${nm ? esc(nm) : `<span class="unk">Unnamed</span> <button class="linkbtn" data-name="${esc(r.packet)}">Name it</button>`}</td>
        <td>${esc(r.by)}</td>
        <td class="n">${r.waiting ? '' : `<button class="del" data-del="${esc(r.awb)}">Delete</button>`}</td></tr>`;
    }).join('')
      : `<tr><td colspan="7" class="empty">${cfg.url ? 'Nothing scanned for this day. Scan an AWB above to add the first dispatch.' : 'Connect your Google Sheet in Settings, then scan the first AWB.'}</td></tr>`;
    const pk = Object.keys(products).sort((a, b) => products[a].localeCompare(products[b]));
    $('prods').innerHTML = pk.length
      ? pk.map(c => `<tr><td class="mono">${esc(c)}</td><td>${esc(products[c])}</td><td class="n"><button class="del" data-pdel="${esc(c)}">Remove</button></td></tr>`).join('')
      : `<tr><td class="empty">No packet codes yet. Scan a packet's barcode into the first box and type its product name.</td></tr>`;
    $('setupNote').hidden = !!cfg.url;
  }

  document.addEventListener('click', async e => {
    const d = e.target.closest('[data-del]'), pd = e.target.closest('[data-pdel]'), nm = e.target.closest('[data-name]');
    const b = d || pd;
    if (b) {
      if (!b.classList.contains('arm')) {
        b.classList.add('arm'); b.textContent = 'Confirm';
        setTimeout(() => { if (b.isConnected) { b.classList.remove('arm'); b.textContent = d ? 'Delete' : 'Remove'; } }, 3000);
        return;
      }
      b.disabled = true;
      try {
        if (d) { await api('POST', { action: 'delete', awb: d.dataset.del }); rows = rows.filter(r => r.awb !== d.dataset.del); flash('ok', 'Deleted ' + d.dataset.del); }
        else { await api('POST', { action: 'deleteProduct', code: pd.dataset.pdel }); delete products[pd.dataset.pdel]; store.set('products', products); }
      } catch (err) { flash('bad', 'Could not delete.', err.message); }
      render(); return;
    }
    if (nm) { $('pCode').value = nm.dataset.name; $('pName').focus(); $('pName').scrollIntoView({ block: 'center' }); }
  });

  $('prodForm').addEventListener('submit', async e => {
    e.preventDefault();
    const code = $('pCode').value.trim(), name = $('pName').value.trim();
    if (!code || !name) { flash('warn', 'Enter both the packet barcode and the product name.'); return; }
    try {
      await api('POST', { action: 'product', code, name });
      products[code] = name; store.set('products', products);
      rows.forEach(r => { if (r.packet === code && !r.product) r.product = name; });
      $('pCode').value = ''; $('pName').value = '';
      flash('ok', 'Saved packet code ' + code, name); render();
    } catch (err) { flash('bad', 'Could not save packet code.', err.message); }
  });

  /* ---------- loading + sync ---------- */
  async function loadDay() {
    if (!cfg.url) { render(); return; }
    const day = $('day').value || today();
    try {
      const j = await api('GET', { action: 'list', date: day });
      if (day === $('day').value) rows = (j.rows || []).sort((a, b) => (b.ts || 0) - (a.ts || 0));
      setConn('on', 'Connected to Sheet'); showQueueState();
    } catch (err) { setConn('off', err.server ? err.message : 'Offline'); }
    render();
  }
  async function loadProducts() {
    if (!cfg.url) return;
    try {
      const j = await api('GET', { action: 'products' });
      products = {}; (j.products || []).forEach(p => products[p.code] = p.name);
      store.set('products', products); render();
    } catch (err) {}
  }
  let syncing = false;
  async function syncQueue() {
    if (syncing || !queue.length || !cfg.url) return;
    syncing = true;
    const dups = [];
    try {
      while (queue.length) {
        const rec = queue[0];
        const j = await api('POST', { action: 'add', rec });
        if (j.dup) dups.push(rec.awb);
        queue.shift(); store.set('queue', queue);
      }
      if (dups.length) flash('bad', 'While uploading, ' + dups.length + ' duplicate AWB(s) were skipped:', dups.join(', '));
      await loadDay();
    } catch (err) {
      if (err.server) { flash('bad', 'Upload stopped.', err.message); }
    } finally { syncing = false; showQueueState(); }
  }

  $('day').addEventListener('change', () => { rows = []; render(); loadDay(); });
  $('refresh').onclick = () => { loadProducts(); loadDay(); syncQueue(); };
  window.addEventListener('online', syncQueue);
  setInterval(() => { if (document.visibilityState === 'visible') { syncQueue(); if (!busy) loadDay(); } }, 20000);

  /* ---------- export ---------- */
  $('export').onclick = async () => {
    const from = $('from').value, to = $('to').value;
    if (!from || !to || from > to) { $('expMsg').textContent = 'Pick a From date on or before the To date.'; return; }
    if (!window.XLSX) { $('expMsg').textContent = 'Excel library did not load. Check the internet and reload.'; return; }
    $('expMsg').textContent = 'Preparing…';
    try {
      const j = await api('GET', { action: 'range', from, to });
      const list = (j.rows || []).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (!list.length) { $('expMsg').textContent = 'No dispatches between ' + from + ' and ' + to + '.'; return; }
      const nameOf = r => products[r.packet] || r.product || '';
      const s1 = list.map((r, i) => ({ 'S.No': i + 1, 'Date': r.date, 'Time': r.time, 'Platform': r.platform, 'AWB Number': r.awb, 'Packet Barcode': r.packet, 'Product': nameOf(r), 'Scanned By': r.by }));
      const agg = {};
      list.forEach(r => { const k = [r.date, r.platform, nameOf(r) || ('Unnamed ' + r.packet)].join('|'); agg[k] = (agg[k] || 0) + 1; });
      const s2 = Object.keys(agg).sort().map(k => { const [d, p, n] = k.split('|'); return { 'Date': d, 'Platform': p, 'Product': n, 'Packets': agg[k] }; });
      s2.push({ 'Date': 'TOTAL', 'Platform': '', 'Product': '', 'Packets': list.length });
      const wb = XLSX.utils.book_new();
      const w1 = XLSX.utils.json_to_sheet(s1); w1['!cols'] = [{ wch: 6 }, { wch: 11 }, { wch: 10 }, { wch: 10 }, { wch: 22 }, { wch: 20 }, { wch: 26 }, { wch: 16 }];
      const w2 = XLSX.utils.json_to_sheet(s2); w2['!cols'] = [{ wch: 11 }, { wch: 10 }, { wch: 28 }, { wch: 9 }];
      XLSX.utils.book_append_sheet(wb, w1, 'Dispatch'); XLSX.utils.book_append_sheet(wb, w2, 'Summary');
      const fn = 'Dispatch_' + from + (from === to ? '' : '_to_' + to) + '.xlsx';
      XLSX.writeFile(wb, fn);
      $('expMsg').textContent = 'Downloaded ' + fn + ' (' + list.length + ' dispatches).';
    } catch (err) { $('expMsg').textContent = 'Export failed: ' + err.message; }
  };

  /* ---------- settings ---------- */
  $('sUrl').value = cfg.url; $('sKey').value = cfg.key; $('sBy').value = cfg.by;
  $('setForm').addEventListener('submit', async e => {
    e.preventDefault();
    cfg = { url: $('sUrl').value.trim(), key: $('sKey').value.trim(), by: $('sBy').value.trim() };
    store.set('cfg', cfg);
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(cfg.url)) { $('setMsg').textContent = 'The URL should start with https://script.google.com and end with /exec.'; return; }
    $('setMsg').textContent = 'Testing…';
    try { await api('GET', { action: 'ping' }); $('setMsg').textContent = 'Connected.'; setConn('on', 'Connected to Sheet'); loadProducts(); loadDay(); syncQueue(); }
    catch (err) { $('setMsg').textContent = 'Could not connect: ' + err.message; setConn('off', 'Not connected'); }
    render();
  });

  /* ---------- start ---------- */
  products = store.get('products', {});
  $('day').value = today(); $('from').value = today(); $('to').value = today();
  renderSteps(); render(); focusScan();
  if (cfg.url) { loadProducts(); loadDay().then(syncQueue); } else showQueueState();
})();
