import fs from 'node:fs';
const all=JSON.parse(fs.readFileSync('raw/routes-all.json'));
const sel=all.filter(r=>r.cls!=='secondary'||(r.km>=12||r.ref==='R115')).filter(r=>r.ref!=='N50'&&r.km>=2.5);
const lat=sel.map(r=>r.lat).join(','),lon=sel.map(r=>r.lon).join(',');
const e=await (await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`)).json();
sel.forEach((r,i)=>r.elev=e.elevation[i]);
fs.writeFileSync('raw/routes-sel.json',JSON.stringify(sel));
console.log(sel.length,'routes; total km',sel.reduce((s,r)=>s+r.km,0).toFixed(0));
console.log(sel.map(r=>r.ref+':'+r.elev).join(' '));
