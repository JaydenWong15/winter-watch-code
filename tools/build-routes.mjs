import fs from 'node:fs';
const j=JSON.parse(fs.readFileSync('raw/roads-osm.json'));
const hav=(a,b)=>{const R=6371,t=x=>x*Math.PI/180,dl=t(b.lat-a.lat),dn=t(b.lon-a.lon);const h=Math.sin(dl/2)**2+Math.cos(t(a.lat))*Math.cos(t(b.lat))*Math.sin(dn/2)**2;return 2*R*Math.asin(Math.sqrt(h));};
const rank={motorway:0,trunk:1,primary:2,secondary:3};
const g={};
for(const w of j.elements){const ref=w.tags.ref.split(';')[0].trim();const o=g[ref]??={ref,names:{},cls:{},len:0,pts:[],ways:0};
 let L=0;for(let i=1;i<w.geometry.length;i++)L+=hav(w.geometry[i-1],w.geometry[i]);
 o.len+=L;o.ways++;o.cls[w.tags.highway]=(o.cls[w.tags.highway]||0)+L;if(w.tags.name)o.names[w.tags.name]=(o.names[w.tags.name]||0)+L;
 o.pts.push(w.geometry.filter((_,i)=>i%4==0||i==w.geometry.length-1).map(p=>[+p.lat.toFixed(4),+p.lon.toFixed(4)]));}
const out=Object.values(g).map(o=>{const all=o.pts.flat();const lat=all.reduce((s,p)=>s+p[0],0)/all.length,lon=all.reduce((s,p)=>s+p[1],0)/all.length;
 const cls=Object.entries(o.cls).sort((a,b)=>b[1]-a[1])[0][0];const name=Object.entries(o.names).sort((a,b)=>b[1]-a[1])[0]?.[0]||'';
 return{ref:o.ref,name,cls,km:+o.len.toFixed(1),ways:o.ways,lat:+lat.toFixed(4),lon:+lon.toFixed(4),lines:o.pts};});
out.sort((a,b)=>rank[a.cls]-rank[b.cls]||b.km-a.km);
fs.writeFileSync('raw/routes-all.json',JSON.stringify(out));
console.log(out.length);for(const r of out.slice(0,70))console.log(r.ref.padEnd(6),r.cls.padEnd9?'':'',r.cls,r.km,r.lat,r.lon,r.name);
