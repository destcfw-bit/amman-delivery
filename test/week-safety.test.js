const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../src/server.js'),'utf8');
function handler(route,context){
 const start=source.indexOf("app.post('"+route+"'");
 assert.ok(start>=0);
 const end=source.indexOf('\n});',start)+4;
 let result;
 vm.runInNewContext(source.slice(start,end),{...context,auth:()=>{},app:{post:(_r,_a,fn)=>result=fn}});
 return result;
}
function response(){return {code:200,status(code){this.code=code;return this},json(body){this.body=body;return this}}}
test('stale/repeated close rolls back before changing balances',async()=>{
 const queries=[];let released=false;
 const c={async query(q){queries.push(q);return q.includes('SELECT * FROM accounting_weeks')?{rowCount:1,rows:[{id:8}]}:{rowCount:0,rows:[]}},release(){released=true}};
 const fn=handler('/api/admin/weekly/close',{pool:{connect:async()=>c}});const res=response();
 await fn({body:{expected_week_id:7}},res);
 assert.equal(res.code,409);assert.equal(res.body.error,'WEEK_CHANGED');
 assert.ok(queries[1].includes('pg_advisory_xact_lock'));
 assert.equal(queries.at(-1),'ROLLBACK');assert.ok(released);
 assert.ok(!queries.some(q=>/^\s*(INSERT|UPDATE|DELETE)\b/.test(q)));
});
test('missing week cannot close',async()=>{
 const c={query:async()=>({rowCount:0,rows:[]}),release(){}};const res=response();
 await handler('/api/admin/weekly/close',{pool:{connect:async()=>c}})({body:{expected_week_id:1}},res);
 assert.equal(res.code,409);assert.equal(res.body.error,'NO_OPEN_WEEK');
});
for(const action of ['trash','restore'])test(action+' changes only archive visibility and logs action',async()=>{
 const queries=[],audits=[];const res=response();
 await handler('/api/admin/weekly/:id/'+action,{pool:{query:async(q,args)=>{queries.push([q,args]);return {rowCount:1,rows:[{id:3}]}}},audit:async(...a)=>audits.push(a)})({params:{id:'3'}},res);
 assert.equal(res.body.ok,true);assert.equal(queries.length,1);assert.ok(queries[0][0].includes('SET trashed_at='));assert.ok(queries[0][0].includes("status='closed'"));assert.equal(audits.length,1);
});
test('archive excludes trashed weeks',()=>{
 const part=source.slice(source.indexOf("app.get('/api/admin/weekly/archive'"));assert.match(part.split('\n});')[0],/w\.trashed_at IS NULL/);
});
