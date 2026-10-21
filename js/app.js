/* app.js — หน้าจอและแผนที่ */
(function () {
  'use strict';
  var C = window.Core, esc = C.esc;
  var $ = function (id) { return document.getElementById(id); };

  var S = {
    cfg: null, defs: [], layers: {}, on: {}, defSrc: null,
    me: null, sel: null, q: '', prov: '', dist: '', type: '', radius: 0, pick: false,
    view: [], markers: {}, first: true, stamp: null,
    bfc: {}, bp: {}, bLayer: {}, bmiss: {}, provNames: {}, distNames: {},
    params: new URLSearchParams(location.search)
  };
  var map, cluster, polys, meMark = null, meRange = null, hi = null, timer = null, pickHandler = null;

  /* ---------- ดึงไฟล์ (มีสำรองจากเครื่องผู้ใช้ถ้าเครือข่ายขัดข้อง) ---------- */
  async function fetchText(url) {
    var key = 'csm:' + url;
    try {
      var r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var t = await r.text();
      if (/^\s*</.test(t)) throw new Error('ไม่ใช่ไฟล์ CSV (ชีทอาจยังไม่ได้เผยแพร่ หรือลิงก์ไม่ถูกต้อง)');
      try { localStorage.setItem(key, t); } catch (e) {}
      return { text: t, stale: false };
    } catch (e) {
      var c = null; try { c = localStorage.getItem(key); } catch (_) {}
      if (c != null) return { text: c, stale: true };
      throw e;
    }
  }

  /* ---------- ชั้นข้อมูล ---------- */
  async function loadDefs() {
    var c = S.cfg;
    if (c.configSheetUrl) {
      try {
        var r = await fetchText(c.configSheetUrl);
        var d = C.layerDefsFromTable(r.text);
        if (d.length) return { defs: d, src: 'sheet', stale: r.stale };
        S.cfgErr = 'ชีท _config ไม่มีชั้นข้อมูลที่ visible=TRUE';
      } catch (e) { S.cfgErr = 'อ่านชีท _config ไม่ได้: ' + e.message; }
    }
    var defs = (c.localLayers || []).map(function (l, i) {
      return { id: l.id || ('l' + i), title: l.title || l.id, url: l.url, color: l.color || '#0a6b52', icon: l.icon || '', defaultOn: l.defaultOn !== false, order: i, desc: l.desc || '' };
    });
    return { defs: defs, src: 'local' };
  }

  async function refresh() {
    $('stamp').textContent = 'กำลังอัปเดตข้อมูล…';
    var ld = await loadDefs(), defs = ld.defs;
    var res = await Promise.all(defs.map(function (d) {
      return fetchText(d.url).then(function (r) { return { d: d, r: r }; }, function (e) { return { d: d, e: e }; });
    }));
    var next = {}, changed = S.first;
    res.forEach(function (o) {
      var d = o.d, old = S.layers[d.id];
      if (o.e) {
        next[d.id] = old ? Object.assign({}, old, { def: d, error: o.e.message })
                         : { def: d, rows: [], issues: [], hidden: 0, total: 0, error: o.e.message };
        if (!old) changed = true;
        return;
      }
      if (old && old.sig === o.r.text && !old.error) { next[d.id] = Object.assign({}, old, { def: d, stale: o.r.stale }); return; }
      var p = C.processTable(o.r.text, new Date());
      p.def = d; p.sig = o.r.text; p.stale = o.r.stale; p.error = null;
      next[d.id] = p; changed = true;
    });
    if (Object.keys(S.layers).join() !== Object.keys(next).join()) changed = true;
    defs.forEach(function (d) { if (S.on[d.id] === undefined) S.on[d.id] = d.defaultOn; });
    S.defs = defs; S.layers = next; S.defSrc = ld; S.stamp = new Date();
    if (changed) { enrich(); renderLayerList(); rebuildAdminOptions(); rebuildTypes(); applyFilters(); }
    S.first = false;
    paintStamp(); renderCheck();
  }

  /* ---------- ขอบเขตจังหวัด/อำเภอ ---------- */
  function bnd() { return S.cfg.boundaries || {}; }
  function featName(lvl, props) { return props[lvl === 'province' ? bnd().provinceNameProp : bnd().districtNameProp] || ''; }
  function featProv(props) { return props[bnd().districtProvinceProp] || ''; }

  async function loadBoundaries() {
    var b = bnd();
    await Promise.all(['province', 'district'].map(async function (lvl) {
      if (!b[lvl]) { S.bmiss[lvl] = true; return; }
      try {
        var r = await fetch(b[lvl]); if (!r.ok) throw new Error('HTTP ' + r.status);
        var fc = await r.json();
        S.bfc[lvl] = fc; S.bp[lvl] = C.prepareFeatures(fc);
        S.bLayer[lvl] = L.geoJSON(fc, {
          pane: 'boundaries', interactive: false,
          style: lvl === 'province' ? { color: '#35535c', weight: 1.4, fill: false, dashArray: '5 3' } : { color: '#6d8086', weight: .8, fill: false }
        });
      } catch (e) { S.bmiss[lvl] = true; }
    }));
    updateBndUI(); enrich(); rebuildAdminOptions(); applyFilters(); renderCheck();
  }
  function updateBndUI() {
    var any = false;
    [['province', 'chkProv', 'provinceDefaultOn'], ['district', 'chkDist', 'districtDefaultOn']].forEach(function (a) {
      var el = $(a[1]);
      if (S.bmiss[a[0]]) { el.disabled = true; el.checked = false; el.parentNode.classList.add('bad'); any = true; }
      else if (!el.dataset.init) { el.dataset.init = 1; el.checked = !!bnd()[a[2]]; toggleBnd(a[0], el.checked); }
    });
    var n = $('bndNote');
    n.hidden = !any;
    if (any) n.textContent = 'ยังไม่พบไฟล์ขอบเขต จึงใช้รายชื่อจังหวัด/อำเภอจากข้อมูลในชีทแทน (วิธีเพิ่มไฟล์ดูใน README)';
  }
  function toggleBnd(lvl, on) {
    var l = S.bLayer[lvl]; if (!l) return;
    if (on) l.addTo(map); else map.removeLayer(l);
  }

  /* เติมจังหวัด/อำเภอให้แถวที่ว่าง โดยหาจากพิกัดว่าอยู่ในขอบเขตไหน */
  function enrich() {
    var auto = bnd().autoAssign !== false;
    Object.keys(S.layers).forEach(function (id) {
      S.layers[id].rows.forEach(function (r) {
        if (auto && S.bp.province && !r.province) { var f = C.findFeature(S.bp.province, r.lng, r.lat); if (f) r.province = featName('province', f.props); }
        if (auto && S.bp.district && !r.district) { var g = C.findFeature(S.bp.district, r.lng, r.lat); if (g) { r.district = featName('district', g.props); if (!r.province) r.province = featProv(g.props); } }
        r._p = C.normAdmin(r.province); r._d = C.normAdmin(r.district); r._s = null;
      });
    });
  }
  function collator(a, b) { return String(a).localeCompare(String(b), 'th'); }
  function fillSelect(sel, map, label, keep) {
    var keys = Object.keys(map).sort(function (a, b) { return collator(map[a], map[b]); });
    sel.innerHTML = '<option value="">' + label + '</option>' + keys.map(function (k) { return '<option value="' + esc(k) + '">' + esc(map[k]) + '</option>'; }).join('');
    if (keep && map[keep]) sel.value = keep; else sel.value = '';
  }
  function rebuildAdminOptions() {
    var pn = {};
    Object.keys(S.layers).forEach(function (id) { S.layers[id].rows.forEach(function (r) { if (r._p && !pn[r._p]) pn[r._p] = r.province; }); });
    (S.bp.province || []).forEach(function (f) { var n = featName('province', f.props); if (n) pn[C.normAdmin(n)] = n; });
    S.provNames = pn; fillSelect($('selProv'), pn, 'ทุกจังหวัด', S.prov);
    if (S.prov && !pn[S.prov]) S.prov = '';
    rebuildDistrictOptions();
  }
  function rebuildDistrictOptions() {
    var dn = {};
    if (S.prov) {
      Object.keys(S.layers).forEach(function (id) { S.layers[id].rows.forEach(function (r) { if (r._p === S.prov && r._d && !dn[r._d]) dn[r._d] = r.district; }); });
      (S.bp.district || []).forEach(function (f) {
        if (C.normAdmin(featProv(f.props)) === S.prov) { var n = featName('district', f.props); if (n) dn[C.normAdmin(n)] = n; }
      });
    }
    S.distNames = dn;
    $('selDist').disabled = !S.prov;
    fillSelect($('selDist'), dn, 'ทุกอำเภอ', S.dist);
    if (S.dist && !dn[S.dist]) S.dist = '';
  }
  function rebuildTypes() {
    var t = {};
    S.defs.forEach(function (d) { if (S.on[d.id] && S.layers[d.id]) S.layers[d.id].rows.forEach(function (r) { if (r.type) t[r.type] = r.type; }); });
    fillSelect($('selType'), t, 'ทุกประเภท', S.type); if (S.type && !t[S.type]) S.type = '';
  }
  function findBoundary(lvl, prov, dist) {
    var arr = S.bp[lvl] || [];
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i].props;
      if (lvl === 'province' && C.normAdmin(featName('province', p)) === prov) return arr[i];
      if (lvl === 'district' && C.normAdmin(featName('district', p)) === dist && (!prov || C.normAdmin(featProv(p)) === prov)) return arr[i];
    }
    return null;
  }
  function highlight() {
    if (hi) { map.removeLayer(hi); hi = null; }
    var f = S.dist ? findBoundary('district', S.prov, S.dist) : (S.prov ? findBoundary('province', S.prov) : null);
    if (!f) return null;
    hi = L.geoJSON({ type: 'Feature', geometry: f.geom, properties: {} }, { pane: 'boundaries', interactive: false, style: { color: '#0a6b52', weight: 3, fillColor: '#0a6b52', fillOpacity: .08 } }).addTo(map);
    return hi.getBounds();
  }
  function fitSelection() {
    var b = highlight();
    if (b && b.isValid()) { map.fitBounds(b, { padding: [24, 24] }); return; }
    if ((S.prov || S.dist) && S.view.length) fitPoints(S.view.map(function (o) { return [o.r.lat, o.r.lng]; }));
    else if (!S.prov && !S.dist) map.setView(S.cfg.mapCenter, S.cfg.mapZoom);
  }
  function fitPoints(pts) {
    if (!pts.length) return;
    if (pts.length === 1) { map.setView(pts[0], 14); return; }
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 15 });
  }

  /* ---------- ตัวกรอง/รายการ ---------- */
  function computeView() {
    var q = S.q.trim().toLowerCase(), out = [];
    S.defs.forEach(function (d) {
      if (!S.on[d.id]) return;
      var Ly = S.layers[d.id]; if (!Ly) return;
      Ly.rows.forEach(function (r, i) {
        if (S.prov && r._p !== S.prov) return;
        if (S.dist && r._d !== S.dist) return;
        if (S.type && r.type !== S.type) return;
        if (q) {
          if (!r._s) r._s = [r.name, r.address, r.province, r.district, r.subdistrict, r.cert, r.type].join(' ').toLowerCase();
          if (r._s.indexOf(q) < 0) return;
        }
        var dist = S.me ? C.haversine(S.me.lat, S.me.lng, r.lat, r.lng) : null;
        if (S.me && S.radius && dist > S.radius) return;
        out.push({ r: r, d: dist, L: d, k: d.id + ':' + (r.id || i) });
      });
    });
    out.sort(S.me ? function (a, b) { return a.d - b.d; } : function (a, b) { return collator(a.r.name, b.r.name); });
    return out;
  }
  function applyFilters() { S.view = computeView(); buildMap(); renderList(); renderNearest(); }

  function fmtD(d) { return d < 1 ? Math.round(d * 1000) + ' ม.' : (d < 10 ? d.toFixed(1) : Math.round(d).toLocaleString('th-TH')) + ' กม.'; }
  function navG(r) { return 'https://www.google.com/maps/dir/?api=1&destination=' + r.lat + ',' + r.lng + (S.me ? '&origin=' + S.me.lat + ',' + S.me.lng : '') + '&travelmode=driving'; }
  function navA(r) { return 'https://maps.apple.com/?daddr=' + r.lat + ',' + r.lng + (S.me ? '&saddr=' + S.me.lat + ',' + S.me.lng : '') + '&dirflg=d'; }
  function thDate(d) { return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); }
  function addrOf(r) {
    var bkk = r._p === 'กรุงเทพมหานคร';
    var pre = function (p, v) { return v ? (v.indexOf(p) === 0 ? v : p + v) : ''; };
    return [r.address, pre(bkk ? 'แขวง' : 'ต.', r.subdistrict), pre(bkk ? 'เขต' : 'อ.', r.district), bkk ? r.province : pre('จ.', r.province)].filter(Boolean).join(' ');
  }
  function popupHtml(o) {
    var r = o.r, h = '<h2>' + esc(r.name) + '</h2><p><span class="tag">' + esc(o.L.title) + '</span>' +
      (r.type ? '<span class="tag">' + esc(r.type) + '</span>' : '') + (r.expired ? '<span class="tag exp">ใบรับรองหมดอายุ</span>' : '') + '</p>';
    if (S.me) h += '<p><b>' + fmtD(C.haversine(S.me.lat, S.me.lng, r.lat, r.lng)) + '</b> <span style="color:var(--muted)">(เส้นตรง)</span></p>';
    var a = addrOf(r); if (a) h += '<p>' + esc(a) + '</p>';
    if (r.hours) h += '<p>เวลาทำการ ' + esc(r.hours) + '</p>';
    if (r.cert) h += '<p style="color:var(--muted)">เลขที่ใบรับรอง ' + esc(r.cert) + (r.certExpire ? ' · หมดอายุ ' + esc(thDate(r.certExpire)) : '') + '</p>';
    var ex = Object.keys(r.extra || {});
    if (ex.length) h += '<dl>' + ex.map(function (k) { return '<dt>' + esc(k) + ':</dt><dd>' + esc(r.extra[k]) + '</dd>'; }).join('') + '</dl>';
    h += '<div class="acts"><a class="btn primary" target="_blank" rel="noopener" href="' + navG(r) + '">นำทาง (Google Maps)</a><a class="btn" target="_blank" rel="noopener" href="' + navA(r) + '">Apple Maps</a>';
    if (r.phone) h += '<a class="btn" href="tel:' + esc(r.phone.replace(/[^0-9+]/g, '')) + '">โทร</a>';
    if (r.website) h += '<a class="btn" target="_blank" rel="noopener" href="' + esc(r.website) + '">เว็บไซต์</a>';
    return h + '</div>';
  }

  /* ---------- แผนที่ ---------- */
  var iconCache = {};
  function pinIcon(o, mode) {
    var key = o.L.color + '|' + o.L.icon + '|' + mode;
    if (!iconCache[key]) iconCache[key] = L.divIcon({
      className: 'pinw', iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28],
      html: '<span class="pin ' + mode + '" style="--c:' + esc(o.L.color) + '"><i>' + esc(o.L.icon || '●') + '</i></span>'
    });
    return iconCache[key];
  }
  function modeOf(o, idx) { return o.k === S.sel ? 'sel' : (S.me && idx === 0 ? 'near' : ''); }

  function buildMap() {
    cluster.clearLayers(); polys.clearLayers(); S.markers = {};
    var ms = [];
    S.view.slice(0, 5000).forEach(function (o, i) {
      var m = L.marker([o.r.lat, o.r.lng], { icon: pinIcon(o, modeOf(o, i)), title: o.r.name, keyboard: true });
      m.bindPopup(function () { return popupHtml(o); }, { maxWidth: 300 });
      m.on('click', function () { setSel(o.k); });
      S.markers[o.k] = { m: m, o: o, i: i }; ms.push(m);
      if (o.r.geometry) {
        L.geoJSON({ type: 'Feature', geometry: o.r.geometry, properties: {} }, { style: { color: o.L.color, weight: 2, fillColor: o.L.color, fillOpacity: .28 } })
          .bindPopup(function () { return popupHtml(o); }, { maxWidth: 300 }).addTo(polys);
      }
    });
    cluster.addLayers(ms);
  }
  function setSel(k) {
    var prev = S.markers[S.sel], cur = S.markers[k];
    S.sel = k;
    if (prev) prev.m.setIcon(pinIcon(prev.o, modeOf(prev.o, prev.i)));
    if (cur) cur.m.setIcon(pinIcon(cur.o, 'sel'));
    var rows = $('list').querySelectorAll('.item');
    rows.forEach(function (li) { li.classList.toggle('on', li.getAttribute('data-k') === k); });
    var li = $('list').querySelector('.item.on'); if (li) li.scrollIntoView({ block: 'nearest' });
  }
  function selectFromList(k) {
    var e = S.markers[k]; setSel(k);
    if (!e) return;
    if (e.o.r.geometry) map.fitBounds(L.geoJSON(e.o.r.geometry).getBounds(), { maxZoom: 16, padding: [40, 40] });
    cluster.zoomToShowLayer(e.m, function () { e.m.openPopup(); });
  }
  function renderList() {
    var a = S.view;
    $('count').textContent = a.length ? 'พบ ' + a.length.toLocaleString('th-TH') + ' รายการ' + (S.me ? ' · เรียงจากใกล้ไปไกล (ระยะเส้นตรง)' : '') : '';
    if (!a.length) {
      $('list').innerHTML = '<li class="empty">' + (S.defs.length ? 'ไม่พบรายการตามเงื่อนไขที่เลือก ลองล้างคำค้นหา เปลี่ยนจังหวัด หรือขยายระยะ' : 'ยังไม่มีข้อมูล') + '</li>';
      return;
    }
    $('list').innerHTML = a.slice(0, 200).map(function (o) {
      return '<li class="item' + (o.k === S.sel ? ' on' : '') + '" data-k="' + esc(o.k) + '" tabindex="0">' +
        '<span class="ic" style="background:' + esc(o.L.color) + '"></span><span class="nm">' + esc(o.r.name) + '</span><span class="dist">' + (o.d != null ? fmtD(o.d) : '') + '</span>' +
        '<span class="sm">' + (o.r.type ? '<span class="tag">' + esc(o.r.type) + '</span>' : '') + (o.r.expired ? '<span class="tag exp">หมดอายุ</span>' : '') + esc(addrOf(o.r)) + '</span></li>';
    }).join('') + (a.length > 200 ? '<li class="empty">แสดง 200 รายการแรก ใช้ช่องค้นหาหรือตัวกรองเพื่อจำกัดผล</li>' : '');
  }
  function renderNearest() {
    var n = $('nearest');
    if (!S.me || !S.view.length) { n.hidden = true; return; }
    var o = S.view[0]; n.hidden = false;
    n.innerHTML = '<b>ที่ใกล้ที่สุด</b><div class="nm">' + esc(o.r.name) + '</div><div class="meta">' + esc(o.L.title) + ' · ' + fmtD(o.d) + '</div>' +
      '<a class="btn primary" target="_blank" rel="noopener" href="' + navG(o.r) + '">นำทางไปที่นี่</a>';
  }
  function renderLayerList() {
    $('layerList').innerHTML = S.defs.map(function (d) {
      var Ly = S.layers[d.id] || { rows: [] };
      return '<label title="' + esc(d.desc || '') + '"><input type="checkbox" data-id="' + esc(d.id) + '"' + (S.on[d.id] ? ' checked' : '') + '><span class="dot" style="background:' + esc(d.color) + '"></span>' +
        esc((d.icon ? d.icon + ' ' : '') + d.title) + '<small' + (Ly.error ? ' class="bad"' : '') + '>' + (Ly.error ? 'โหลดไม่สำเร็จ' : Ly.rows.length.toLocaleString('th-TH') + ' รายการ') + '</small></label>';
    }).join('') || '<p class="note">ยังไม่มีชั้นข้อมูล</p>';
  }
  function paintStamp() {
    var t = S.stamp ? S.stamp.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '';
    var bad = Object.keys(S.layers).filter(function (id) { return S.layers[id].error || S.layers[id].stale; });
    $('stamp').textContent = 'อัปเดตข้อมูลล่าสุด ' + t + ' น. · รีเฟรชทุก ' + S.cfg.refreshMinutes + ' นาที' + (bad.length ? ' · ⚠ บางชั้นใช้ข้อมูลเดิม' : '');
  }

  /* ---------- ตำแหน่งของผู้ใช้ ---------- */
  function msg(t, err) { var m = $('msg'); m.textContent = t || ''; m.className = 'msg' + (err ? ' err' : ''); }
  function drawMe() {
    if (meMark) map.removeLayer(meMark); if (meRange) map.removeLayer(meRange);
    meMark = meRange = null;
    if (!S.me) return;
    meMark = L.circleMarker([S.me.lat, S.me.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2457D6', fillOpacity: 1 }).addTo(map).bindTooltip('ตำแหน่งของคุณ', { permanent: false });
    if (S.radius) meRange = L.circle([S.me.lat, S.me.lng], { radius: S.radius * 1000, color: '#2457D6', weight: 1.5, dashArray: '5 4', fillOpacity: .05 }).addTo(map);
  }
  function setMe(lat, lng) {
    S.me = { lat: lat, lng: lng }; drawMe(); applyFilters(); msg('');
    var pts = [[lat, lng]];
    if (S.view.length) pts.push([S.view[0].r.lat, S.view[0].r.lng]);
    else msg('ไม่พบรายการในระยะที่เลือก ลองขยายระยะค้นหา', true);
    if (meRange && !S.view.length) map.fitBounds(meRange.getBounds()); else fitPoints(pts);
  }
  function endPick() { if (pickHandler) { map.off('click', pickHandler); pickHandler = null; } S.pick = false; $('map').classList.remove('pick'); $('hint').hidden = true; $('btnPick').setAttribute('aria-pressed', 'false'); }
  function startPick() {
    S.pick = true; $('map').classList.add('pick'); $('hint').textContent = 'แตะบนแผนที่เพื่อปักตำแหน่งของคุณ'; $('hint').hidden = false;
    $('btnPick').setAttribute('aria-pressed', 'true');
    pickHandler = function (e) { if (S.pick) { setMe(e.latlng.lat, e.latlng.lng); endPick(); } };
    map.once('click', pickHandler);
  }
  function locate() {
    if (!navigator.geolocation) { msg('เบราว์เซอร์นี้อ่านตำแหน่งไม่ได้ กรุณากด “ปักตำแหน่งเอง”', true); return; }
    msg('กำลังค้นหาตำแหน่งของคุณ…');
    navigator.geolocation.getCurrentPosition(function (p) { setMe(p.coords.latitude, p.coords.longitude); },
      function () { msg('อ่านตำแหน่งไม่ได้ (อาจยังไม่ได้อนุญาตการเข้าถึงตำแหน่ง) กรุณากด “ปักตำแหน่งเอง” แล้วแตะบนแผนที่', true); },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }

  /* ---------- รายงานตรวจข้อมูล (?check=1) ---------- */
  function renderCheck() {
    if (!S.params.get('check')) return;
    var box = $('check'); box.hidden = false; box.open = true;
    var h = '<p>แหล่งชั้นข้อมูล: <b>' + (S.defSrc && S.defSrc.src === 'sheet' ? 'ชีท _config' : 'config.json (localLayers)') + '</b>' + (S.cfgErr ? ' <span class="err">— ' + esc(S.cfgErr) + '</span>' : '') + '</p>';
    h += '<p>ขอบเขต: จังหวัด ' + (S.bmiss.province ? '<span class="err">ไม่พบไฟล์</span>' : 'พร้อมใช้') + ' · อำเภอ ' + (S.bmiss.district ? '<span class="err">ไม่พบไฟล์</span>' : 'พร้อมใช้') + '</p>';
    S.defs.forEach(function (d) {
      var Ly = S.layers[d.id];
      h += '<h4>' + esc(d.title) + '</h4><p>แถวทั้งหมด ' + Ly.total + ' · แสดงได้ ' + Ly.rows.length + ' · ซ่อนตามสถานะ ' + Ly.hidden + ' · ปัญหา ' + Ly.issues.length +
        (Ly.error ? ' · <span class="err">โหลดไม่สำเร็จ: ' + esc(Ly.error) + '</span>' : '') + (Ly.stale ? ' · ใช้ข้อมูลสำรองในเครื่อง' : '') + '</p>';
      if (Ly.issues.length) h += '<table><tr><th>แถว</th><th>ปัญหา</th></tr>' + Ly.issues.slice(0, 40).map(function (i) { return '<tr><td>' + i.line + '</td><td class="' + (i.level === 'error' ? 'err' : '') + '">' + esc(i.msg) + '</td></tr>'; }).join('') + '</table>' + (Ly.issues.length > 40 ? '<p>…และอีก ' + (Ly.issues.length - 40) + ' รายการ</p>' : '');
    });
    $('checkBody').innerHTML = h;
  }

  /* ---------- เริ่มต้น ---------- */
  function initMap() {
    var cfg = S.cfg;
    map = L.map('map', { center: cfg.mapCenter, zoom: cfg.mapZoom, minZoom: 5, maxBounds: cfg.maxBounds, maxBoundsViscosity: .8, preferCanvas: true });
    map.createPane('boundaries').style.zIndex = 350;
    var base = {}, def = null;
    (cfg.basemaps || []).forEach(function (b) {
      if (/\{key\}/.test(b.url) && !b.key) return;
      var l = L.tileLayer(b.url.replace('{key}', b.key || ''), { attribution: b.attribution, maxZoom: b.maxZoom || 18, subdomains: b.subdomains || 'abc' });
      base[b.name] = l; if (b['default'] || !def) { if (b['default'] || !def) def = l; }
    });
    if (def) def.addTo(map);
    L.control.layers(base, null, { position: 'topright' }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45, chunkedLoading: true });
    polys = L.featureGroup();
    map.addLayer(polys); map.addLayer(cluster);
    if (window.ResizeObserver) new ResizeObserver(function () { map.invalidateSize(); }).observe($('map').parentNode);
  }

  function wire() {
    var deb; $('q').addEventListener('input', function () { var v = this.value; clearTimeout(deb); deb = setTimeout(function () { S.q = v; applyFilters(); }, 200); });
    $('selProv').addEventListener('change', function () { S.prov = this.value; S.dist = ''; rebuildDistrictOptions(); applyFilters(); fitSelection(); });
    $('selDist').addEventListener('change', function () { S.dist = this.value; applyFilters(); fitSelection(); });
    $('selType').addEventListener('change', function () { S.type = this.value; applyFilters(); });
    $('radius').addEventListener('change', function () { S.radius = +this.value; drawMe(); applyFilters(); if (S.me) { if (meRange) map.fitBounds(meRange.getBounds()); else if (S.view.length) fitPoints([[S.me.lat, S.me.lng], [S.view[0].r.lat, S.view[0].r.lng]]); } });
    $('btnLocate').addEventListener('click', locate);
    $('btnPick').addEventListener('click', function () { if (S.pick) endPick(); else startPick(); });
    $('btnRefresh').addEventListener('click', function () { refresh(); });
    $('layerList').addEventListener('change', function (e) {
      var id = e.target.getAttribute('data-id'); if (!id) return;
      S.on[id] = e.target.checked; rebuildTypes(); applyFilters();
    });
    $('chkProv').addEventListener('change', function () { toggleBnd('province', this.checked); });
    $('chkDist').addEventListener('change', function () { toggleBnd('district', this.checked); });
    $('list').addEventListener('click', function (e) { var li = e.target.closest('.item'); if (li) selectFromList(li.getAttribute('data-k')); });
    $('list').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { var li = e.target.closest('.item'); if (li) { e.preventDefault(); selectFromList(li.getAttribute('data-k')); } } });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && S.stamp && Date.now() - S.stamp.getTime() > S.cfg.refreshMinutes * 60000) refresh();
    });
  }

  async function init() {
    try {
      var r = await fetch('config.json', { cache: 'no-store' });
      S.cfg = await r.json();
    } catch (e) {
      document.body.innerHTML = '<p style="padding:24px;font-family:sans-serif">โหลด config.json ไม่ได้ — ถ้าเปิดไฟล์โดยดับเบิลคลิก ให้รันผ่านเว็บเซิร์ฟเวอร์ เช่น <code>python3 -m http.server</code> (ดู README)</p>';
      return;
    }
    S.cfg.refreshMinutes = Math.max(1, +S.cfg.refreshMinutes || 5);
    $('ttl').textContent = S.cfg.title || ''; document.title = S.cfg.title || document.title;
    $('sub').textContent = S.cfg.org || '';
    if (S.cfg.notice) { $('notice').textContent = S.cfg.notice; $('notice').hidden = false; }
    initMap(); wire();
    await refresh();
    loadBoundaries();
    timer = setInterval(refresh, S.cfg.refreshMinutes * 60000);
    if (S.view.length) fitPoints(S.view.map(function (o) { return [o.r.lat, o.r.lng]; }));
  }
  init();
})();
