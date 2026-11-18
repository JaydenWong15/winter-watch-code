// Summarises 7 winters (1 Nov - 31 Mar, nights 18:00-09:00) per route into data/history.json
const fs = require('fs'); const L = require('../src/logic.js');
const sel = JSON.parse(fs.readFileSync('raw/routes-sel.json')); const out = [];
for (const r of sel) {
  const h = JSON.parse(fs.readFileSync('raw/hist/' + r.ref + '.json')).hourly; const w = L.summariseWinters(h, 2019, 2025);
  out.push({ ref: r.ref, name: r.name, cls: r.cls, km: r.km, lat: r.lat, lon: r.lon, elev: r.elev, lines: r.lines, winters: w });
}
fs.writeFileSync('data/history.json', JSON.stringify({
  generated: new Date().toISOString(),
  source: 'Open-Meteo Historical Weather API (ERA5 reanalysis), CC BY 4.0, hourly, Europe/Dublin',
  roadsSource: 'OpenStreetMap contributors (ODbL) via Overpass API, snapshot 2026-11-18',
  winters: ['2019/20', '2020/21', '2021/22', '2022/23', '2023/24', '2024/25', '2025/26'], routes: out
}));
for (const r of out.slice(0, 3)) console.log(r.ref, JSON.stringify(r.winters.map(w => [w.winter, w.nights, w.grit, w.marginal, w.snow, w.minT])));
const t = out.map(r => ({ ref: r.ref, cls: r.cls, m: +(r.winters.reduce((s, w) => s + w.grit, 0) / 7).toFixed(1) })).sort((a, b) => b.m - a.m);
console.log(t.map(x => x.ref + '(' + x.cls[0] + ')' + x.m).join(' '));
console.log(fs.statSync('data/history.json').size);
