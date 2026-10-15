  (function () {
'use strict';

// ---------- Settings ----------
var MAX_ACCURACY_M = 30;     // ignore GPS fixes less accurate than this
var MIN_STEP_M = 4;          // ignore tiny movements (GPS jitter)
var MAX_SPEED_MS = 70;       // ignore impossible jumps (~250 km/h)
var STORE_KEY = 'routelab.route.v2';

// ---------- State ----------
var points = [];             // {lat, lng, t, acc, alt}
var distanceM = 0;
var movingMs = 0;            // time spent recording (excludes pauses)
var lastTick = 0;
var status = 'idle';         // idle | recording | paused | stopped
var watchId = null;
var wakeLock = null;
var useMiles = false;
var currentSpeedMs = 0;
var lastAcc = null;
var tickTimer = null;

try { useMiles = localStorage.getItem('routelab.miles') === '1'; } catch (e) {}

// ---------- Elements ----------
var $ = function (id) { return document.getElementById(id); };
var el = {
  distance:$('distance'), distUnit:$('distUnit'), time:$('time'), speed:$('speed'), avg:$('avg'),
  speedLabel:$('speedLabel'), avgLabel:$('avgLabel'), acc:$('acc'), msg:$('msg'),
  dot:$('dot'), stateText:$('stateText'),
  start:$('startBtn'), pause:$('pauseBtn'), stop:$('stopBtn'),
  center:$('centerBtn'), unit:$('unitBtn'), gpx:$('gpxBtn'), clear:$('clearBtn')
};

// ---------- Map ----------
var map = L.map('map', { zoomControl:false }).setView([25.033, 121.565], 15);
L.control.zoom({ position:'topright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

var line = L.polyline([], { color:'#e4572e', weight:6, opacity:.95, lineJoin:'round' }).addTo(map);
var startMarker = null;
var me = L.circleMarker([0, 0], { radius:8, color:'#fff', weight:3, fillColor:'#0b7285', fillOpacity:1 });
var accCircle = L.circle([0, 0], { radius:0, color:'#0b7285', weight:1, fillColor:'#0b7285', fillOpacity:.12 });
var follow = true;
map.on('dragstart', function () { follow = false; });

// ---------- Helpers ----------
function haversine(a, b) {
  var R = 6371008.8, rad = Math.PI / 180;
  var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmtTime(ms) {
  var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s % 60) : pad(m) + ':' + pad(s % 60);
}
function say(text, isErr) { el.msg.textContent = text || ''; el.msg.className = 'msg' + (isErr ? ' err' : ''); }

// ---------- UI ----------
function render() {
  var distUnit = useMiles ? 'mi' : 'km';
  var distVal = useMiles ? distanceM / 1609.344 : distanceM / 1000;
  var spdFactor = useMiles ? 2.236936 : 3.6;
  var spdUnit = useMiles ? 'mph' : 'km/h';

  el.distance.textContent = distVal.toFixed(2);
  el.distUnit.textContent = distUnit;
  el.time.textContent = fmtTime(movingMs);
  el.speed.textContent = (currentSpeedMs * spdFactor).toFixed(1);
  el.avg.textContent = (movingMs > 0 ? (distanceM / (movingMs / 1000)) * spdFactor : 0).toFixed(1);
  el.speedLabel.textContent = 'Speed ' + spdUnit;
  el.avgLabel.textContent = 'Avg ' + spdUnit;
  el.acc.textContent = lastAcc == null ? '–' : Math.round(lastAcc) + ' m';
  el.unit.textContent = 'Units: ' + distUnit;

  var rec = status === 'recording', paused = status === 'paused';
  el.dot.className = 'dot' + (rec ? ' rec' : paused ? ' paused' : '');
  el.stateText.textContent = rec ? 'Recording' : paused ? 'Paused' : status === 'stopped' ? 'Stopped' : 'Ready';
  el.start.textContent = (status === 'stopped' || status === 'paused' || rec) ? (rec ? 'Recording…' : 'Resume') : 'Start route';
  el.start.disabled = rec;
  el.pause.disabled = !rec;
  el.stop.disabled = !(rec || paused);
  el.gpx.disabled = points.length < 2;
  el.clear.disabled = points.length === 0 || rec;
}

// ---------- Persistence ----------
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ points:points, distanceM:distanceM, movingMs:movingMs }));
  } catch (e) {}
}
function load() {
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    var d = JSON.parse(raw);
    if (!d.points || !d.points.length) return;
    points = d.points; distanceM = d.distanceM || 0; movingMs = d.movingMs || 0;
    line.setLatLngs(points.map(function (p) { return [p.lat, p.lng]; }));
    startMarker = L.marker([points[0].lat, points[0].lng]).addTo(map);
    map.fitBounds(line.getBounds(), { padding:[40, 200] });
    status = 'stopped';
    say('Restored your last route. Press Resume to continue or Clear to start over.');
  } catch (e) {}
}

// ---------- GPS ----------
function onPosition(pos) {
  var c = pos.coords;
  lastAcc = c.accuracy;
  var ll = [c.latitude, c.longitude];
  me.setLatLng(ll); accCircle.setLatLng(ll).setRadius(c.accuracy);
  if (!map.hasLayer(me)) { accCircle.addTo(map); me.addTo(map); }
  if (follow) map.setView(ll, Math.max(map.getZoom(), 17));

  if (status !== 'recording') { render(); return; }

  if (c.accuracy > MAX_ACCURACY_M) {
    say('Weak GPS signal (±' + Math.round(c.accuracy) + ' m). Waiting for a better fix…');
    render(); return;
  }
  say('');

  var p = { lat:c.latitude, lng:c.longitude, t:pos.timestamp, acc:c.accuracy, alt:c.altitude };
  var prev = points[points.length - 1];
  if (prev) {
    var d = haversine(prev, p);
    var dt = Math.max((p.t - prev.t) / 1000, 0.001);
    if (d < Math.max(MIN_STEP_M, c.accuracy * 0.25)) { render(); return; }  // jitter
    if (d / dt > MAX_SPEED_MS) { render(); return; }                       // GPS jump
    distanceM += d;
    currentSpeedMs = (typeof c.speed === 'number' && c.speed >= 0) ? c.speed : d / dt;
  } else {
    startMarker = L.marker(ll).addTo(map);
  }
  points.push(p);
  line.addLatLng(ll);
  save();
  render();
}

function onError(err) {
  var text = {
    1:'Location permission denied. Allow location for this site in your browser settings.',
    2:'Position unavailable. Check that Location Services are on.',
    3:'Timed out waiting for GPS. Try moving to an open area.'
  }[err.code] || 'GPS error.';
  say(text, true);
}

function startWatch() {
  if (!('geolocation' in navigator)) { say('This browser does not support GPS.', true); return false; }
  if (watchId == null) {
    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy:true, maximumAge:0, timeout:20000
    });
  }
  return true;
}
function stopWatch() {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
}

async function lockScreen() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
function unlockScreen() {
  try { if (wakeLock) wakeLock.release(); } catch (e) {}
  wakeLock = null;
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && status === 'recording') lockScreen();
});

// ---------- Timer ----------
function tick() {
  var now = Date.now();
  if (status === 'recording') { movingMs += now - lastTick; }
  lastTick = now;
  if (status === 'recording') {
    if (movingMs % 10000 < 1000) save();
    render();
  }
}

// ---------- Actions ----------
el.start.addEventListener('click', function () {
  if (!startWatch()) return;
  status = 'recording'; follow = true; lastTick = Date.now();
  if (!tickTimer) tickTimer = setInterval(tick, 1000);
  lockScreen();
  say('Waiting for GPS…');
  render();
});
el.pause.addEventListener('click', function () {
  status = 'paused'; currentSpeedMs = 0; unlockScreen(); save(); say('Paused. Press Resume to continue.'); render();
});
el.stop.addEventListener('click', function () {
  status = 'stopped'; currentSpeedMs = 0; stopWatch(); unlockScreen();
  clearInterval(tickTimer); tickTimer = null; save();
  if (line.getLatLngs().length > 1) map.fitBounds(line.getBounds(), { padding:[40, 220] });
  say('Route finished. Save it as a GPX file or press Resume to keep going.');
  render();
});
el.center.addEventListener('click', function () {
  follow = true;
  if (map.hasLayer(me)) map.setView(me.getLatLng(), Math.max(map.getZoom(), 17));
  else if (!startWatch()) return;
});
el.unit.addEventListener('click', function () {
  useMiles = !useMiles;
  try { localStorage.setItem('routelab.miles', useMiles ? '1' : '0'); } catch (e) {}
  render();
});
el.clear.addEventListener('click', function () {
  if (!confirm('Clear this route?')) return;
  points = []; distanceM = 0; movingMs = 0; currentSpeedMs = 0; lastAcc = null;
  line.setLatLngs([]);
  if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
  try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  status = 'idle'; stopWatch(); say(''); render();
});
el.gpx.addEventListener('click', function () {
  if (points.length < 2) return;
  var name = 'Route ' + new Date(points[0].t).toISOString().slice(0, 10);
  var gpx = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="Route Lab" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    '<trk><name>' + name + '</name><trkseg>\n' +
    points.map(function (p) {
      return '<trkpt lat="' + p.lat.toFixed(7) + '" lon="' + p.lng.toFixed(7) + '">' +
        (p.alt != null ? '<ele>' + p.alt.toFixed(1) + '</ele>' : '') +
        '<time>' + new Date(p.t).toISOString() + '</time></trkpt>';
    }).join('\n') + '\n</trkseg></trk>\n</gpx>';
  var blob = new Blob([gpx], { type:'application/gpx+xml' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/\s+/g, '-').toLowerCase() + '.gpx';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
});

// ---------- Init ----------
load();
render();
  })();
