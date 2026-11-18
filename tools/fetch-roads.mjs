// Fetches real County Dublin road geometry from OpenStreetMap (Overpass). Run: node tools/fetch-roads.mjs
import fs from 'node:fs';
const q = `[out:json][timeout:120];area["ISO3166-2"="IE-D"]->.a;way(area.a)["highway"~"^(motorway|trunk|primary|secondary)$"]["ref"];out geom;`;
let r; for (const u of ['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://overpass-api.de/api/interpreter']) { r = await fetch(u, {method:'POST', headers:{'User-Agent':'WinterWatchResearch/0.1','Content-Type':'application/x-www-form-urlencoded'}, body:'data='+encodeURIComponent(q)}); if (r.ok) break; console.log(u, r.status); await new Promise(s=>setTimeout(s,8000)); }
if(!r.ok) throw new Error(r.status);
const j = await r.json();
fs.writeFileSync('raw/roads-osm.json', JSON.stringify(j));
console.log(j.elements.length, 'ways', (JSON.stringify(j).length/1e6).toFixed(1)+'MB', j.osm3s?.timestamp_osm_base);
