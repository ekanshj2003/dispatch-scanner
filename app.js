/* Dispatch Scan Register – app logic (v2: login, steady layout, new camera engine).
   Talks to the Google Sheet script in google-sheet-script/Code.gs. */
(function () {
  'use strict';

  /* ================= basics ================= */
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
  let learned = store.get('learned', { awb: {}, ign: {} });
  let todayRows = [], viewRows = [], viewDay = today();
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
    $('codesTab').hidden = !isAdmin;
    document.querySelector('.tabs').classList.toggle('three', !isAdmin);
    go('scan');
    loadProducts(); loadToday().then(syncQueue);
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
      if (j.v !== 2) throw new Error('Paste the new Code.gs and deploy a new version.');
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
    ['scan', 'today', 'excel', 'codes'].forEach(v => { $('v-' + v).hidden = v !== view; });
    document.querySelectorAll('.tabs button').forEach(b => b.toggleAttribute('aria-current', b.dataset.view === view));
    if (view === 'scan') maybeAutoStartCam(); else stopCam();
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
  }
  document.querySelectorAll('.seg button').forEach(b => b.onclick = () => setPlatform(b.dataset.p));
  setPlatform(platform);

  function renderSteps() {
    $('s1').className = 'step ' + (step === 1 ? 'on' : 'done');
    $('s2').className = 'step ' + (step === 2 ? 'on' : '');
    const v1 = $('v1'); v1.className = 'val' + (pendingAwb ? '' : ' empty'); setText(v1, pendingAwb || 'Scan the courier label');
    $('pickTitle').textContent = step === 1 ? 'More than one barcode in the box. Tap the AWB:' : 'More than one barcode in the box. Tap the packet barcode:';
  }
  function reset(msg) {
    step = 1; pendingAwb = ''; labelCodes = new Set(); closePick(); renderSteps();
    if (msg) flash('idle', msg, 'Scan the AWB on the shipping label.');
  }
  $('resetBtn').onclick = () => reset('Reset.');

  /* ================= saving a scan ================= */
  const knownAwb = awb => todayRows.find(r => r.awb === awb) || queue.find(r => r.awb === awb);

  async function accept(code) {
    code = String(code || '').trim();
    if (!code || busy) return;
    busy = true;
    try {
      if (step === 1) {
        if (products[code]) { flash('bad', 'That is a packet barcode.', 'Scan the AWB on the shipping label first.'); beep(false); pulse(false); return; }
        const k = knownAwb(code);
        if (k) { flash('bad', 'Duplicate AWB ' + code, 'Already dispatched ' + (k.time || '') + ' · ' + k.platform + (k.by ? ' · ' + k.by : '')); beep(false); pulse(false); return; }
        if (/^FMP/i.test(code)) setPlatform('Flipkart');
        pendingAwb = code; step = 2;
        labelCodes = new Set(recentCodes()); labelCodes.add(code);
        renderSteps();
        flash('idle', 'AWB ' + code, 'Now scan the barcode on the packet.');
        beep(true); pulse(true);
      } else {
        if (code === pendingAwb) { flash('warn', 'That is the same AWB.', 'Scan the barcode on the packet now.'); beep(false); return; }
        const ts = Date.now();
        const rec = { awb: pendingAwb, packet: code, platform, ts, date: today(), time: fmtTime(ts), product: products[code] || '', by: user ? user.name : '' };
        step = 1; pendingAwb = ''; labelCodes = new Set(); renderSteps();
        pulse(true);
        flash('idle', 'Saving ' + rec.awb + '…', rec.product || code);
        try {
          const j = await api('POST', { action: 'add', rec });
          if (j.dup) {
            const e = j.existing || {};
            flash('bad', 'Duplicate AWB ' + rec.awb + ', not saved', 'Already in the Sheet: ' + (e.date || '') + ' ' + (e.time || '') + ' · ' + (e.by || ''));
            beep(false); pulse(false);
          } else {
            todayRows.unshift(j.row || rec);
            flash(rec.product ? 'ok' : 'warn', '✓ Saved · ' + platform + ' · ' + rec.awb, rec.product || 'New packet code ' + code + (user && user.role === 'admin' ? '. Name it in Codes.' : '. Ask admin to name it.'));
            beep(true); setConn('on');
          }
        } catch (err) {
          if (err.server) { flash('bad', 'Not saved.', err.message); beep(false); pulse(false); }
          else {
            queue.push(rec); store.set('queue', queue);
            flash('warn', '✓ Saved on this phone · ' + rec.awb, 'No internet. It uploads by itself when you are back online.');
            beep(true); setConn('q');
          }
        }
        render();
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
    if ($('app').hidden || current !== 'scan') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const now = performance.now();
    if (now - kbLast > 100) { kb = ''; kbFirst = now; }
    kbLast = now;
    if (e.key === 'Enter') {
      if (kb.length >= 4 && (now - kbFirst) < kb.length * 70 + 200) { e.preventDefault(); accept(kb); }
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

  /* ================= stability filter ================= */
  const seen = new Map();                 // code -> {hits, last, format}
  const recent = new Map();               // code -> time accepted (avoid double reads)
  let coolUntil = 0;
  const cooldown = ms => { coolUntil = performance.now() + ms; };
  const recentCodes = () => { const now = performance.now(); return [...seen.entries()].filter(([, v]) => now - v.last < 1500).map(([k]) => k); };

  function onFrame(codes) {
    const now = performance.now();
    codes.forEach(({ code, format }) => {
      if (!code) return;
      const s = seen.get(code);
      if (s && now - s.last < 800) { s.hits++; s.last = now; s.format = format; }
      else seen.set(code, { hits: 1, last: now, format });
    });
    for (const [k, v] of seen) if (now - v.last > 2500) seen.delete(k);
    if (busy || picking || now < coolUntil) return;
    const stable = [...seen.entries()]
      .filter(([k, v]) => v.hits >= 2 && now - v.last < 350 && !(recent.has(k) && now - recent.get(k) < 4000))
      .map(([code, v]) => ({ code, format: v.format }));
    if (!stable.length) return;
    const pick = choose(stable);
    if (pick) {
      recent.set(pick, now); cooldown(1100);
      $('stage').classList.add('locked'); setTimeout(() => $('stage').classList.remove('locked'), 600);
      accept(pick);
    }
  }

  /* ================= camera ================= */
  const WANT = ['code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar', 'qr_code', 'data_matrix'];
  let camOn = false, stream = null, detector = null, h5 = null, track = null, torch = false, zoomed = false, loopTimer = 0;

  async function nativeDetector() {
    if (!('BarcodeDetector' in window)) return null;
    try {
      const have = await window.BarcodeDetector.getSupportedFormats();
      const formats = WANT.filter(f => have.includes(f));
      return formats.includes('code_128') ? new window.BarcodeDetector({ formats }) : null;
    } catch (e) { return null; }
  }

  async function startCam() {
    if (camOn) return;
    $('camStart').disabled = true;
    try {
      detector = detector || await nativeDetector();
      if (detector) await startNative(); else await startFallback();
      camOn = true;
      $('stage').classList.remove('idle'); $('stageIdle').hidden = true; $('stageTools').hidden = false;
      store.set('camOK', true);
    } catch (err) {
      flash('bad', 'Camera did not start.', 'Allow camera for this site in Chrome settings, then tap Start camera.');
      await stopCam();
    } finally { $('camStart').disabled = false; }
  }

  async function startNative() {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
    const v = $('video'); v.hidden = false; v.srcObject = stream; await v.play();
    track = stream.getVideoTracks()[0];
    const caps = (track.getCapabilities && track.getCapabilities()) || {};
    try { if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) {}
    $('torchBtn').hidden = !caps.torch;
    $('zoomBtn').hidden = !(caps.zoom && caps.zoom.max >= 1.8);
    const loop = async () => {
      if (!camOn && !stream) return;
      if (v.readyState >= 2 && !document.hidden) {
        try { onFrame(inGuide(await detector.detect(v), v)); } catch (e) {}
      }
      loopTimer = setTimeout(loop, 80);
    };
    loop();
  }

  // Keep only barcodes whose centre sits inside the white box on screen.
  function inGuide(barcodes, v) {
    const W = v.clientWidth, H = v.clientHeight, vw = v.videoWidth, vh = v.videoHeight;
    if (!W || !vw) return [];
    const scale = Math.max(W / vw, H / vh), ox = (vw * scale - W) / 2, oy = (vh * scale - H) / 2;
    const gx0 = W * 0.06, gx1 = W * 0.94, gy0 = H * 0.27, gy1 = H * 0.73;   // box plus a small margin
    return barcodes.filter(b => {
      const bb = b.boundingBox; if (!bb) return true;
      const cx = (bb.x + bb.width / 2) * scale - ox, cy = (bb.y + bb.height / 2) * scale - oy;
      return cx >= gx0 && cx <= gx1 && cy >= gy0 && cy <= gy1;
    }).map(b => ({ code: String(b.rawValue || '').trim(), format: b.format }));
  }

  async function startFallback() {
    if (!window.Html5Qrcode) throw new Error('reader not loaded');
    const F = window.Html5QrcodeSupportedFormats;
    h5 = new Html5Qrcode('fallbackReader', {
      verbose: false,
      formatsToSupport: [F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.ITF, F.CODABAR, F.QR_CODE, F.DATA_MATRIX]
    });
    $('video').hidden = true;
    await h5.start({ facingMode: 'environment' }, {
      fps: 12,
      qrbox: (w, h) => ({ width: Math.floor(w * 0.84), height: Math.max(80, Math.floor(h * 0.38)) }),
      videoConstraints: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
    }, (text, res) => onFrame([{ code: String(text).trim(), format: res && res.result && res.result.format ? String(res.result.format.formatName || '').toLowerCase() : '' }]), () => {});
    try { track = h5.getRunningTrack && h5.getRunningTrack(); } catch (e) { track = null; }
    const caps = (track && track.getCapabilities && track.getCapabilities()) || {};
    $('torchBtn').hidden = !caps.torch;
    $('zoomBtn').hidden = !(caps.zoom && caps.zoom.max >= 1.8);
  }

  async function stopCam() {
    clearTimeout(loopTimer);
    camOn = false;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (h5) { try { await h5.stop(); } catch (e) {} try { h5.clear(); } catch (e) {} h5 = null; }
    track = null; torch = false; zoomed = false;
    $('torchBtn').setAttribute('aria-pressed', 'false'); $('zoomBtn').setAttribute('aria-pressed', 'false');
    const v = $('video'); v.srcObject = null;
    $('stage').classList.add('idle'); $('stageIdle').hidden = false; $('stageTools').hidden = true;
    closePick();
  }

  async function maybeAutoStartCam() {
    if (camOn || current !== 'scan' || $('app').hidden) return;
    let granted = false;
    try { granted = (await navigator.permissions.query({ name: 'camera' })).state === 'granted'; } catch (e) { granted = false; }
    if (granted && store.get('camOK', false)) startCam();
  }

  $('camStart').onclick = () => { beep(true); startCam(); };
  $('camStop').onclick = () => { store.set('camOK', false); stopCam(); };
  $('torchBtn').onclick = async () => {
    if (!track) return; torch = !torch;
    try { await track.applyConstraints({ advanced: [{ torch }] }); } catch (e) { torch = false; }
    $('torchBtn').setAttribute('aria-pressed', String(torch));
  };
  $('zoomBtn').onclick = async () => {
    if (!track) return; zoomed = !zoomed;
    const caps = track.getCapabilities();
    try { await track.applyConstraints({ advanced: [{ zoom: zoomed ? Math.min(2, caps.zoom.max) : Math.max(1, caps.zoom.min) }] }); } catch (e) { zoomed = false; }
    $('zoomBtn').setAttribute('aria-pressed', String(zoomed));
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (camOn) { stopCam(); resumeCam = true; } }
    else if (resumeCam) { resumeCam = false; if (current === 'scan') startCam(); }
  });
  let resumeCam = false;

  /* ================= rendering ================= */
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
    const t = tally(tw.concat(todayRows));
    setText($('mAll'), t.fk + t.ms); setText($('mFk'), t.fk); setText($('mMs'), t.ms);
    $('mQ').hidden = !queue.length; setText($('mQ'), queue.length + ' waiting to upload');

    // Today / chosen day
    const day = viewDay, isToday = day === today();
    const waiting = queue.filter(q => q.date === day).map(q => Object.assign({ waiting: true }, q));
    const all = waiting.concat(isToday ? todayRows : viewRows).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const v = tally(all);
    setText($('dayTitle'), isToday ? 'Today' : day);
    setText($('tAll'), v.fk + v.ms); setText($('tFk'), v.fk); setText($('tMs'), v.ms);
    const names = Object.keys(v.by).sort((a, b) => (v.by[b].f + v.by[b].m) - (v.by[a].f + v.by[a].m));
    setHTML($('byProd'), names.length
      ? names.map(n => `<tr><td>${esc(n)}</td><td class="n">${v.by[n].f}</td><td class="n">${v.by[n].m}</td><td class="n"><b>${v.by[n].f + v.by[n].m}</b></td></tr>`).join('')
      : `<tr><td colspan="4" class="empty">No packets${isToday ? ' yet today' : ' on this day'}.</td></tr>`);
    setText($('logCount'), all.length + ' packet' + (all.length === 1 ? '' : 's'));
    setHTML($('log'), all.length ? all.map(r => {
      const nm = products[r.packet] || r.product;
      return `<tr><td class="mono">${esc((r.time || fmtTime(r.ts)).slice(0, 5))}</td>
        <td><span class="pill ${esc(r.platform)}">${r.platform === 'Meesho' ? 'MS' : 'FK'}</span>${r.waiting ? '<span class="pill wait">Waiting</span>' : ''}<div class="awb">${esc(r.awb)}</div></td>
        <td>${nm ? esc(nm) : `<span class="unk">${esc(r.packet)}</span>${isAdmin ? ` <button class="linkbtn" data-name="${esc(r.packet)}">Name</button>` : ''}`}<span class="by">${esc(r.by)}</span></td>
        <td class="n">${!r.waiting && isAdmin ? `<button class="del" data-del="${esc(r.awb)}">Delete</button>` : ''}</td></tr>`;
    }).join('') : `<tr><td colspan="4" class="empty">Nothing scanned${isToday ? ' yet today. Go to Scan and scan the first AWB.' : ' on this day.'}</td></tr>`);

    const pk = Object.keys(products).sort((a, b) => products[a].localeCompare(products[b]));
    setHTML($('prods'), pk.length
      ? pk.map(c => `<tr><td class="mono">${esc(c)}</td><td>${esc(products[c])}</td><td class="n"><button class="del" data-pdel="${esc(c)}">Remove</button></td></tr>`).join('')
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
          await api('POST', { action: 'delete', awb: d.dataset.del });
          todayRows = todayRows.filter(r => r.awb !== d.dataset.del); viewRows = viewRows.filter(r => r.awb !== d.dataset.del);
        } else {
          await api('POST', { action: 'deleteProduct', code: pd.dataset.pdel });
          delete products[pd.dataset.pdel]; store.set('products', products);
        }
      } catch (err) { alertMsg(err.message); }
      render(); return;
    }
    if (nm) { go('codes'); $('pCode').value = nm.dataset.name; $('pName').focus(); }
  });
  const alertMsg = m => { if (current === 'scan') flash('bad', 'Could not do that.', m); else { $('expMsg').textContent = m; } };

  $('prodForm').addEventListener('submit', async e => {
    e.preventDefault();
    const code = $('pCode').value.trim(), name = $('pName').value.trim();
    if (!code || !name) return;
    const btn = e.submitter; if (btn) btn.disabled = true;
    try {
      await api('POST', { action: 'product', code, name });
      products[code] = name; store.set('products', products);
      [todayRows, viewRows].forEach(list => list.forEach(r => { if (r.packet === code && !r.product) r.product = name; }));
      $('pCode').value = ''; $('pName').value = ''; render();
    } catch (err) { $('pName').setCustomValidity(err.message); $('pName').reportValidity(); setTimeout(() => $('pName').setCustomValidity(''), 2000); }
    finally { if (btn) btn.disabled = false; }
  });

  /* ================= loading + sync ================= */
  async function loadToday() {
    if (!token) return;
    try {
      const j = await api('GET', { action: 'list', date: today() });
      todayRows = (j.rows || []).sort((a, b) => (b.ts || 0) - (a.ts || 0));
      if (viewDay === today()) viewRows = todayRows;
      setConn(queue.length ? 'q' : 'on');
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
      products = {}; (j.products || []).forEach(p => { products[p.code] = p.name; });
      store.set('products', products); render();
    } catch (err) {}
  }
  let syncing = false;
  async function syncQueue() {
    if (syncing || !queue.length || !token) return;
    syncing = true; const dups = [];
    try {
      while (queue.length) {
        const j = await api('POST', { action: 'add', rec: queue[0] });
        if (j.dup) dups.push(queue[0].awb);
        queue.shift(); store.set('queue', queue);
      }
      if (dups.length && current === 'scan') flash('bad', dups.length + ' duplicate AWB skipped while uploading', dups.join(', '));
      await loadToday();
    } catch (err) { setConn(err.server ? 'on' : 'q'); }
    finally { syncing = false; render(); }
  }
  window.addEventListener('online', syncQueue);
  setInterval(() => { if (!document.hidden && token && !$('app').hidden) { syncQueue(); if (!busy) loadToday(); } }, 25000);

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
      m.className = 'msg ok'; m.textContent = 'Downloaded ' + fn + ' (' + list.length + ' dispatches).';
    } catch (err) { m.className = 'msg bad'; m.textContent = 'Export failed: ' + err.message; }
    finally { $('exportBtn').disabled = false; }
  };

  /* ================= start ================= */
  $('day').value = today(); $('from').value = today(); $('to').value = today();
  renderSteps(); render();
  if (url && token && user) {
    showApp();
    api('GET', { action: 'me' }).then(j => { if (j.user) { user = j.user; store.set('user', user); $('userName').textContent = user.name; } }).catch(() => {});
  } else showLogin('');
})();
