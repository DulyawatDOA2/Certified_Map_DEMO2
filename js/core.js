/* core.js — ตรรกะที่ไม่ผูกกับหน้าจอ (ทดสอบด้วย node ได้) */
(function (root) {
  'use strict';

  /* ---------- ชื่อคอลัมน์ที่รองรับ (ไทย/อังกฤษ ใช้ปนกันได้) ---------- */
  var FIELD_ALIASES = {
    id:         ['id', 'รหัส', 'รหัสอ้างอิง'],
    name:       ['name', 'ชื่อ', 'ชื่อร้าน', 'ชื่อร้านค้า', 'ชื่อแปลง', 'ชื่อสถานที่'],
    type:       ['type', 'category', 'ประเภท', 'หมวดหมู่'],
    cert:       ['cert_no', 'certno', 'certificate', 'เลขที่ใบรับรอง', 'เลขที่ใบรับรองมาตรฐาน'],
    certExpire: ['cert_expire', 'expire', 'expire_date', 'วันหมดอายุ', 'วันหมดอายุใบรับรอง'],
    status:     ['status', 'สถานะ'],
    province:   ['province', 'จังหวัด'],
    district:   ['district', 'amphoe', 'อำเภอ', 'เขต/อำเภอ'],
    subdistrict:['subdistrict', 'tambon', 'ตำบล', 'แขวง/ตำบล'],
    address:    ['address', 'ที่อยู่'],
    phone:      ['phone', 'tel', 'โทรศัพท์', 'เบอร์โทร', 'เบอร์โทรศัพท์'],
    hours:      ['hours', 'opening_hours', 'เวลาทำการ', 'เวลาเปิดทำการ'],
    website:    ['website', 'url', 'เว็บไซต์', 'ลิงก์'],
    lat:        ['lat', 'latitude', 'ละติจูด'],
    lng:        ['lng', 'lon', 'long', 'longitude', 'ลองจิจูด'],
    geometry:   ['geometry', 'geojson', 'รูปแปลง', 'ขอบเขตแปลง']
  };
  var LAYER_ALIASES = {
    id:        ['layer_id', 'id', 'รหัสชั้นข้อมูล'],
    title:     ['title', 'ชื่อชั้นข้อมูล', 'ชื่อ'],
    url:       ['csv_url', 'url', 'ลิงก์csv', 'ลิงก์ข้อมูล'],
    color:     ['color', 'สี'],
    icon:      ['icon', 'ไอคอน'],
    visible:   ['visible', 'แสดง', 'แสดงต่อประชาชน'],
    defaultOn: ['default_on', 'เปิดเริ่มต้น'],
    order:     ['order', 'ลำดับ'],
    desc:      ['description', 'คำอธิบาย']
  };
  function normKey(h) {
    return String(h == null ? '' : h).replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_\-\.]+/g, '');
  }
  function buildIndex(aliases) {
    var idx = {};
    Object.keys(aliases).forEach(function (f) {
      aliases[f].forEach(function (a) { idx[normKey(a)] = f; });
    });
    return idx;
  }
  var FIELD_BY_KEY = buildIndex(FIELD_ALIASES);
  var LAYER_BY_KEY = buildIndex(LAYER_ALIASES);

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    text = String(text || '').replace(/^\uFEFF/, '');
    var firstLine = text.split(/\r?\n/, 1)[0] || '';
    var delim = (firstLine.split('\t').length > firstLine.split(',').length) ? '\t' : ',';
    var rows = [], row = [], f = '', inq = false, i, c;
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (inq) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else inq = false; }
        else f += c;
      } else if (c === '"') inq = true;
      else if (c === delim) { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = ''; rows.push(row); row = [];
      } else f += c;
    }
    row.push(f); rows.push(row);
    while (rows.length && rows[rows.length - 1].every(function (x) { return !String(x).trim(); })) rows.pop();
    return rows;
  }
  function isBlank(r) { return r.every(function (x) { return !String(x).trim(); }); }

  /* ---------- ค่าต่าง ๆ ---------- */
  var FALSE_WORDS = ['false', '0', 'no', 'n', 'off', 'ไม่', 'ไม่แสดง', 'ปิด', 'ซ่อน'];
  function parseBool(v, def) {
    v = String(v == null ? '' : v).trim().toLowerCase();
    if (!v) return def;
    return FALSE_WORDS.indexOf(v) < 0;
  }
  var HIDDEN_STATUS = ['inactive', 'hide', 'hidden', 'false', 'no', 'ระงับ', 'ยกเลิก', 'ปิด', 'ไม่ใช้งาน', 'ซ่อน'];
  function parseDate(s) {
    s = String(s || '').trim(); if (!s) return null;
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/), y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else {
      m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
      if (!m) return null; d = +m[1]; mo = +m[2]; y = +m[3];
    }
    if (y > 2400) y -= 543;               // พ.ศ. -> ค.ศ.
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return new Date(Date.UTC(y, mo - 1, d));
  }
  function num(v) {
    v = String(v == null ? '' : v).trim().replace(/,/g, '');
    if (!v) return NaN;
    return parseFloat(v);
  }

  /* ---------- เรขาคณิต ---------- */
  function haversine(lat1, lng1, lat2, lng2) {
    var t = Math.PI / 180, R = 6371, dLa = (lat2 - lat1) * t, dLo = (lng2 - lng1) * t;
    var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
            Math.cos(lat1 * t) * Math.cos(lat2 * t) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function eachCoord(geom, fn) {
    (function walk(a) {
      if (typeof a[0] === 'number') fn(a[0], a[1]); else a.forEach(walk);
    })(geom.coordinates);
  }
  function bboxOf(geom) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    eachCoord(geom, function (x, y) {
      if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
    });
    return b;
  }
  function centerOf(geom) {
    var b = bboxOf(geom);
    return { lat: (b[1] + b[3]) / 2, lng: (b[0] + b[2]) / 2 };
  }
  function inRing(x, y, ring) {
    var inside = false, i, j;
    for (i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function inPolygon(x, y, rings) {
    if (!inRing(x, y, rings[0])) return false;
    for (var k = 1; k < rings.length; k++) if (inRing(x, y, rings[k])) return false;
    return true;
  }
  function inGeometry(x, y, geom) {
    if (geom.type === 'Polygon') return inPolygon(x, y, geom.coordinates);
    if (geom.type === 'MultiPolygon') return geom.coordinates.some(function (p) { return inPolygon(x, y, p); });
    return false;
  }
  function prepareFeatures(fc) {
    var feats = (fc && fc.features) || [];
    return feats.filter(function (f) { return f && f.geometry && /Polygon/.test(f.geometry.type); })
      .map(function (f) { return { props: f.properties || {}, geom: f.geometry, bbox: bboxOf(f.geometry) }; });
  }
  function findFeature(prepared, lng, lat) {
    for (var i = 0; i < prepared.length; i++) {
      var b = prepared[i].bbox;
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      if (inGeometry(lng, lat, prepared[i].geom)) return prepared[i];
    }
    return null;
  }

  /* ---------- ชื่อจังหวัด/อำเภอ ---------- */
  function normAdmin(s) {
    s = String(s == null ? '' : s).trim().replace(/\s+/g, '');
    s = s.replace(/^(จังหวัด|จ\.|กิ่งอำเภอ|อำเภอ|อ\.|เขต)/, '');
    if (s === 'กรุงเทพฯ' || s === 'กรุงเทพ' || s === 'กทม' || s === 'กทม.') return 'กรุงเทพมหานคร';
    return s;
  }

  /* ---------- แปลงตารางเป็นรายการ + ตรวจความถูกต้อง ---------- */
  function processTable(text, today) {
    today = today || new Date();
    var out = { rows: [], issues: [], hidden: 0, total: 0 };
    var table = parseCSV(text);
    if (table.length < 2) { out.issues.push({ line: 1, level: 'error', msg: 'ไม่พบข้อมูล (ต้องมีแถวหัวคอลัมน์ในแถวที่ 1 และมีข้อมูลตั้งแต่แถวที่ 2)' }); return out; }
    var headers = table[0];
    var cols = headers.map(function (h) { return FIELD_BY_KEY[normKey(h)] || null; });
    var has = function (f) { return cols.indexOf(f) >= 0; };
    if (!has('name')) out.issues.push({ line: 1, level: 'error', msg: 'ไม่พบคอลัมน์ชื่อ (name / ชื่อ / ชื่อร้าน / ชื่อแปลง)' });
    if (!((has('lat') && has('lng')) || has('geometry'))) out.issues.push({ line: 1, level: 'error', msg: 'ไม่พบคอลัมน์พิกัด (lat และ lng / ละติจูด และ ลองจิจูด) หรือ geometry' });
    if (out.issues.length) return out;
    var todayUTC = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());

    for (var i = 1; i < table.length; i++) {
      var r = table[i]; if (isBlank(r)) continue;
      out.total++;
      var line = i + 1, rec = {}, extra = {};
      cols.forEach(function (f, k) {
        var v = String(r[k] == null ? '' : r[k]).trim();
        if (f) { if (!rec[f]) rec[f] = v; }
        else if (v && String(headers[k]).trim()) extra[String(headers[k]).trim()] = v;
      });
      if (!rec.name) { out.issues.push({ line: line, level: 'error', msg: 'ไม่มีชื่อ — ข้ามแถวนี้' }); continue; }
      if (HIDDEN_STATUS.indexOf(String(rec.status || '').toLowerCase()) >= 0) { out.hidden++; continue; }

      var geom = null;
      if (rec.geometry) {
        try {
          var g = JSON.parse(rec.geometry);
          if (g && g.type === 'Feature') g = g.geometry;
          if (g && /^(Polygon|MultiPolygon|Point)$/.test(g.type)) geom = g;
          else out.issues.push({ line: line, level: 'warn', msg: 'รูปแปลงต้องเป็น GeoJSON ชนิด Polygon/MultiPolygon' });
        } catch (e) { out.issues.push({ line: line, level: 'warn', msg: 'อ่านรูปแปลง (geometry) ไม่ได้ — ตรวจว่าเป็น GeoJSON ที่ถูกต้องและไม่ถูกตัดท้าย' }); }
      }
      var lat = num(rec.lat), lng = num(rec.lng);
      if (isNaN(lat) || isNaN(lng)) {
        if (geom) { var c = geom.type === 'Point' ? { lat: geom.coordinates[1], lng: geom.coordinates[0] } : centerOf(geom); lat = c.lat; lng = c.lng; }
        else { out.issues.push({ line: line, level: 'error', msg: '"' + rec.name + '": ไม่มีพิกัด — ข้ามแถวนี้' }); continue; }
      }
      if (lat >= 96 && lat <= 107 && lng >= 4 && lng <= 22) {
        var t = lat; lat = lng; lng = t;
        out.issues.push({ line: line, level: 'warn', msg: '"' + rec.name + '": ละติจูด/ลองจิจูดสลับกัน — แก้ให้อัตโนมัติแล้ว ควรแก้ในชีท' });
      }
      if (lat < 4 || lat > 22 || lng < 96 || lng > 107) {
        out.issues.push({ line: line, level: 'error', msg: '"' + rec.name + '": พิกัดอยู่นอกประเทศไทย (' + rec.lat + ', ' + rec.lng + ') — ข้ามแถวนี้' }); continue;
      }
      var exp = parseDate(rec.certExpire);
      if (rec.certExpire && !exp) out.issues.push({ line: line, level: 'warn', msg: '"' + rec.name + '": อ่านวันหมดอายุไม่ได้ ("' + rec.certExpire + '") ใช้รูปแบบ ปปปป-ดด-วว' });
      var website = /^https?:\/\//i.test(rec.website || '') ? rec.website : '';
      out.rows.push({
        id: rec.id || '', name: rec.name, type: rec.type || '', cert: rec.cert || '',
        certExpire: exp, expired: !!(exp && exp.getTime() < todayUTC),
        province: rec.province || '', district: rec.district || '', subdistrict: rec.subdistrict || '',
        address: rec.address || '', phone: rec.phone || '', hours: rec.hours || '', website: website,
        lat: lat, lng: lng, geometry: geom && geom.type !== 'Point' ? geom : null, extra: extra
      });
    }
    return out;
  }

  /* ---------- ชั้นข้อมูลจากชีท _config ---------- */
  function layerDefsFromTable(text) {
    var table = parseCSV(text);
    if (table.length < 2) return [];
    var cols = table[0].map(function (h) { return LAYER_BY_KEY[normKey(h)] || null; });
    var defs = [];
    for (var i = 1; i < table.length; i++) {
      var r = table[i]; if (isBlank(r)) continue;
      var d = {};
      cols.forEach(function (f, k) { if (f && !d[f]) d[f] = String(r[k] == null ? '' : r[k]).trim(); });
      if (!d.url) continue;
      defs.push({
        id: d.id || ('layer' + i), title: d.title || d.id || ('ชั้นข้อมูล ' + i), url: d.url,
        color: /^#[0-9a-f]{3,8}$/i.test(d.color || '') ? d.color : '#0a6b52',
        icon: d.icon || '', visible: parseBool(d.visible, true), defaultOn: parseBool(d.defaultOn, true),
        order: isNaN(parseFloat(d.order)) ? i : parseFloat(d.order), desc: d.desc || ''
      });
    }
    return defs.filter(function (d) { return d.visible; }).sort(function (a, b) { return a.order - b.order; });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var Core = {
    FIELD_ALIASES: FIELD_ALIASES, LAYER_ALIASES: LAYER_ALIASES,
    normKey: normKey, parseCSV: parseCSV, parseBool: parseBool, parseDate: parseDate,
    haversine: haversine, bboxOf: bboxOf, centerOf: centerOf, inGeometry: inGeometry,
    prepareFeatures: prepareFeatures, findFeature: findFeature, normAdmin: normAdmin,
    processTable: processTable, layerDefsFromTable: layerDefsFromTable, esc: esc
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== 'undefined' ? window : this);
