require('dotenv').config();
const { pool, initDb } = require('./db');
const { processEvent } = require('./accounting');

const BATCH = Number(process.env.WORKER_BATCH_SIZE || 50);
const POLL = Number(process.env.WORKER_POLL_MS || 250);
const SYNC_BATCH = Number(process.env.SHEET_SYNC_BATCH_SIZE || 100);
const SYNC_POLL = Number(process.env.SHEET_SYNC_POLL_MS || 1500);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function claimEvents() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(`
      SELECT * FROM event_queue
      WHERE status IN ('pending','retry') AND next_attempt_at<=now()
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT $1`, [BATCH]);
    if (r.rows.length) {
      await c.query(`
        UPDATE event_queue SET status='processing',locked_at=now()
        WHERE id = ANY($1::bigint[])`, [r.rows.map(x=>x.id)]);
    }
    await c.query('COMMIT');
    return r.rows;
  } catch(e) {
    await c.query('ROLLBACK'); throw e;
  } finally { c.release(); }
}

async function finishEvent(id) {
  await pool.query(`UPDATE event_queue SET status='done',processed_at=now(),last_error=NULL WHERE id=$1`,[id]);
}
async function failEvent(row, err) {
  const attempts = Number(row.attempts||0)+1;
  const retryable = !!err.retryable && attempts < 8;
  const delaySec = Math.min(60, Math.pow(2, attempts));
  await pool.query(`
    UPDATE event_queue
    SET status=$2, attempts=$3, next_attempt_at=now()+($4||' seconds')::interval, last_error=$5
    WHERE id=$1`,
    [row.id,retryable?'retry':'failed',attempts,String(delaySec),String(err.message||err).slice(0,1000)]);
}

async function processLoop() {
  while (true) {
    try {
      const rows = await claimEvents();
      if (!rows.length) { await sleep(POLL); continue; }
      await Promise.all(rows.map(async row => {
        try { await processEvent(row); await finishEvent(row.id); }
        catch(e) { await failEvent(row,e); }
      }));
    } catch(e) {
      console.error('worker loop error',e);
      await sleep(1000);
    }
  }
}

async function claimSheetRows() {
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const r=await c.query(`
      SELECT * FROM sheet_sync_queue
      WHERE status IN ('pending','retry') AND next_attempt_at<=now()
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1`,[SYNC_BATCH]);
    if(r.rows.length) await c.query(`UPDATE sheet_sync_queue SET status='processing' WHERE id=ANY($1::bigint[])`,[r.rows.map(x=>x.id)]);
    await c.query('COMMIT'); return r.rows;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function sheetLoop(){
  while(true){
    if(!(process.env.AMMAN_SHEETS_BRIDGE_URL||process.env.TIGER_SHEETS_BRIDGE_URL) || !(process.env.AMMAN_SHEETS_BRIDGE_KEY||process.env.TIGER_SHEETS_BRIDGE_KEY)){await sleep(5000);continue;}
    try{
      const rows=await claimSheetRows();
      if(!rows.length){await sleep(SYNC_POLL);continue;}
      try{
        const res=await fetch((process.env.AMMAN_SHEETS_BRIDGE_URL||process.env.TIGER_SHEETS_BRIDGE_URL),{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({key:(process.env.AMMAN_SHEETS_BRIDGE_KEY||process.env.TIGER_SHEETS_BRIDGE_KEY),action:'sync_batch',items:rows.map(r=>({id:r.id,kind:r.kind,payload:r.payload}))})
        });
        const bridgeText=await res.text();
        if(!res.ok) throw new Error(`bridge HTTP ${res.status}: ${bridgeText}`);
        let bridgeJson=null;
        try{ bridgeJson=JSON.parse(bridgeText); }catch(_){}
        if(!bridgeJson || bridgeJson.ok !== true){
          throw new Error(`bridge rejected: ${bridgeText.slice(0,800)}`);
        }
        await pool.query(`UPDATE sheet_sync_queue SET status='done',processed_at=now(),last_error=NULL WHERE id=ANY($1::bigint[])`,[rows.map(x=>x.id)]);
      }catch(e){
        await pool.query(`
          UPDATE sheet_sync_queue
          SET status='retry',attempts=attempts+1,next_attempt_at=now()+interval '10 seconds',last_error=$2
          WHERE id=ANY($1::bigint[])`,[rows.map(x=>x.id),String(e.message||e).slice(0,1000)]);
      }
    }catch(e){console.error('sheet loop error',e);await sleep(2000);}
  }
}


async function heartbeat(){
  try{
    await pool.query(`INSERT INTO runtime_status(key,value,updated_at) VALUES('worker',$1::jsonb,now())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[JSON.stringify({pid:process.pid,state:'running'})]);
  }catch(e){ console.error('worker heartbeat error',e.message||e); }
}
(async()=>{
  await initDb();
  console.log('AMMAN DELIVERY worker started');
  await heartbeat(); setInterval(heartbeat,15000).unref();
  processLoop();
  sheetLoop();
})().catch(e=>{console.error(e);process.exit(1);});

