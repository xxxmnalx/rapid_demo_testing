import fs from 'node:fs';
const html=fs.readFileSync(process.argv[2]||new URL('../index.html',import.meta.url),'utf8');
const core=html.split('// CORE START')[1].split('// CORE END')[0];
const api=new Function(core+';return {generate,summarize,DEFAULTS,TYPES,edgeKey,key,DIRS};')();
const {generate,summarize,DEFAULTS,TYPES,key,DIRS}=api;
function check(M){
  // no overlaps by construction (Map), check rooms/corridors cells consistent with occ, doors on boundary, links connect
  for(const rm of M.rooms){ if(!rm) continue; for(const [x,y] of rm.cells){const o=M.occ.get(key(x,y)); if(!o||o.kind!=='room'||o.id!==rm.id) throw new Error('room cell mismatch');}}
  for(const c of M.corridors){ for(const [x,y] of c.cells){const o=M.occ.get(key(x,y)); if(!o||o.kind!=='corr'||o.id!==c.id) throw new Error('corr cell overwritten');}
    for(let i=1;i<c.cells.length;i++){const a=c.cells[i-1],b=c.cells[i]; if(Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1])!==1) throw new Error('corridor gap');}}
  const total=[...M.occ.keys()].length, sum=M.rooms.filter(Boolean).reduce((n,r)=>n+r.cells.length,0)+M.corridors.reduce((n,c)=>n+c.cells.length,0);
  if(total!==sum) throw new Error('overlap: occ '+total+' vs '+sum);
  // exits within limits
  for(const rm of M.rooms){ if(!rm) continue; const deg=M.links.filter(l=>l.a===rm.id||l.b===rm.id).length; if(deg>TYPES[rm.type].maxExits) throw new Error('too many exits '+rm.type+' '+deg);}
  // safehouse side: nothing below the entrance (y >= 3)
  for(const k of M.occ.keys()){ if(+k.split(',')[1]>=3) throw new Error('cell below entrance '+k);}
  // connectivity: all placed rooms reachable
  if(M.depth.size!==M.rooms.filter(Boolean).length) throw new Error('disconnected');
}
function run(cfg,label,N=500){
  let ok=0,loops=0,tries=0,over=0,t0=Date.now(),rooms=0,dead=0;
  for(let s=0;s<N;s++){const M=generate(1000+s,cfg);check(M);const st=summarize(M,cfg);if(M.ok)ok++;loops+=st.loops;tries+=st.tries;if(st.doors>32)over++;rooms+=st.placed;dead+=st.dead;}
  // determinism
  const a=JSON.stringify(summarize(generate(42,cfg),cfg)), b=JSON.stringify(summarize(generate(42,cfg),cfg));
  console.log(label.padEnd(18), 'ok',(ok/N*100).toFixed(1)+'%','loops',(loops/N).toFixed(2)+'/'+cfg.loops,'tries',(tries/N).toFixed(2),'rooms',(rooms/N).toFixed(1),'dead',(dead/N).toFixed(1),'doors>32',(over/N*100).toFixed(1)+'%', (Date.now()-t0)/N+'ms/map', a===b?'deterministic':'NONDETERMINISTIC');
}
const D=JSON.parse(JSON.stringify(DEFAULTS));
run(D,'default');
run({...D,mainLen:14,branches:10,branchMax:4,loops:6},'max size');
run({...D,mainLen:3,branches:0,loops:0},'min');
run({...D,direct:1},'all direct');
run({...D,direct:0,corrMin:7,corrMax:12},'corr 7-12');
run({...D,loops:6,loopMin:12,loopMax:24},'hard loops');
run({...D,weights:{R1:0,R2:0,R3:0,R4:0,R5:0,R6:0}},'zero weights',200);
run({...D,weights:{R1:5,R2:0,R3:5,R4:0,R5:0,R6:0}},'R1+R3 only',200);
