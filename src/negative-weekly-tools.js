'use strict';

// Shared weekly debt review and manual group-removal record.
// This ledger is operational only: it never modifies accounting balances or settlements.
module.exports = function setupNegativeWeeklyTools({app,pool,auth,getOpenWeek,weeklyRows,normalizePhone,audit}){
  async function ensureTable(){
    await pool.query(`
      CREATE TABLE IF NOT EXISTS negative_manual_removals (
        id BIGSERIAL PRIMARY KEY,
        week_id BIGINT NOT NULL,
        captain_phone TEXT NOT NULL,
        captain_name TEXT NOT NULL DEFAULT '',
        recorded_debt NUMERIC(12,3) NOT NULL DEFAULT 0,
        removed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        undone_at TIMESTAMPTZ
      )
    `);
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS negative_manual_active_once ON negative_manual_removals(week_id,captain_phone) WHERE undone_at IS NULL');
    await pool.query('CREATE INDEX IF NOT EXISTS negative_manual_phone_active ON negative_manual_removals(captain_phone) WHERE undone_at IS NULL');
  }
  function parseId(value){
    const n=Number(value);
    return Number.isSafeInteger(n)&&n>0?n:null;
  }
  async function getWeek(id){
    const q=await pool.query("SELECT id,starts_at,closed_at,status FROM accounting_weeks WHERE id=$1 AND trashed_at IS NULL AND status IN ('open','closed')",[id]);
    return q.rows[0]||null;
  }
  async function negativeRows(week){
    if(week.status==='open'){
      const live=await weeklyRows(week.id);
      return live.filter(r=>Number(r.net||0)<-0.0001 && r.active!==false).map(r=>({
        phone:normalizePhone(r.phone),name:r.name||r.phone,
        old_balance:Number(r.old_balance||0),current_net:Number(r.net||0),
        current_week_production:Number(r.production||0),
        current_week_consumption:Number(r.consumption||0),status:'open'
      }));
    }
    const q=await pool.query(`
      SELECT s.captain_phone phone,s.captain_name name,s.old_balance,
             s.net current_net,s.production current_week_production,
             s.consumption current_week_consumption,s.status
      FROM weekly_settlements s
      WHERE s.week_id=$1 AND s.net < 0
        AND COALESCE(s.status,'pending') NOT IN ('settled','carried_forward')
      ORDER BY s.captain_name,s.captain_phone
    `,[week.id]);
    return q.rows.map(r=>({
      phone:normalizePhone(r.phone),name:r.name||r.phone,
      old_balance:Number(r.old_balance||0),current_net:Number(r.current_net||0),
      current_week_production:Number(r.current_week_production||0),
      current_week_consumption:Number(r.current_week_consumption||0),status:r.status
    }));
  }
  function routeError(res,e,code){
    console.error(code,e);
    return res.status(500).json({ok:false,error:code});
  }
  app.get('/api/admin/negative-weeks',auth,async(req,res)=>{
    try{
      await ensureTable();
      const q=await pool.query("SELECT id,starts_at,closed_at,status FROM accounting_weeks WHERE trashed_at IS NULL AND status IN ('open','closed') ORDER BY id DESC LIMIT 150");
      res.set('Cache-Control','no-store').json({ok:true,rows:q.rows});
    }catch(e){routeError(res,e,'NEGATIVE_WEEKS_FAILED')}
  });
  app.get('/api/admin/negative-week/:weekId/candidates',auth,async(req,res)=>{
    try{
      await ensureTable();
      const week=await getWeek(parseId(req.params.weekId));
      if(!week)return res.status(404).json({ok:false,error:'WEEK_NOT_FOUND'});
      const marks=await pool.query('SELECT DISTINCT captain_phone FROM negative_manual_removals WHERE undone_at IS NULL');
      const suppressed=new Set(marks.rows.map(r=>r.captain_phone));
      const rows=(await negativeRows(week))
        .filter(x=>/^9627\d{8}$/.test(x.phone) && !suppressed.has(x.phone))
        .sort((a,b)=>String(a.name).localeCompare(String(b.name),'ar'));
      res.set('Cache-Control','no-store').json({ok:true,week,count:rows.length,rows});
    }catch(e){routeError(res,e,'NEGATIVE_WEEK_CANDIDATES_FAILED')}
  });
  app.post('/api/admin/negative-week/:weekId/manual-remove',auth,async(req,res)=>{
    try{
      await ensureTable();
      const week=await getWeek(parseId(req.params.weekId));
      if(!week)return res.status(404).json({ok:false,error:'WEEK_NOT_FOUND'});
      const phone=normalizePhone(req.body?.phone||'');
      if(!/^9627\d{8}$/.test(phone))return res.status(400).json({ok:false,error:'INVALID_PHONE'});
      const r=(await negativeRows(week)).find(x=>x.phone===phone);
      if(!r)return res.status(409).json({ok:false,error:'NOT_A_NEGATIVE_CANDIDATE'});
      const other=await pool.query('SELECT id FROM negative_manual_removals WHERE captain_phone=$1 AND undone_at IS NULL LIMIT 1',[phone]);
      if(other.rowCount)return res.status(409).json({ok:false,error:'ALREADY_MARKED_REMOVED'});
      const inserted=await pool.query(`
        INSERT INTO negative_manual_removals(week_id,captain_phone,captain_name,recorded_debt)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id
      `,[week.id,phone,r.name,Math.abs(r.current_net)]);
      if(!inserted.rowCount)return res.status(409).json({ok:false,error:'ALREADY_MARKED_REMOVED'});
      await audit('NEGATIVE_MANUALLY_REMOVED',{week_id:week.id,phone,amount:Math.abs(r.current_net),record_id:inserted.rows[0].id});
      res.set('Cache-Control','no-store').json({ok:true,id:inserted.rows[0].id});
    }catch(e){routeError(res,e,'MANUAL_REMOVE_FAILED')}
  });
  app.get('/api/admin/negative-week/:weekId/manual-removed',auth,async(req,res)=>{
    try{
      await ensureTable();
      const week=await getWeek(parseId(req.params.weekId));
      if(!week)return res.status(404).json({ok:false,error:'WEEK_NOT_FOUND'});
      const q=await pool.query(`
        SELECT m.id,m.week_id,m.captain_phone phone,m.captain_name name,
               m.recorded_debt,m.removed_at
        FROM negative_manual_removals m
        WHERE m.week_id=$1 AND m.undone_at IS NULL
        ORDER BY m.removed_at DESC,m.id DESC
      `,[week.id]);
      const open=await getOpenWeek();
      const current=await weeklyRows(open.id);
      const byPhone=new Map(current.map(x=>[normalizePhone(x.phone),x]));
      const rows=q.rows.map(r=>{
        const live=byPhone.get(r.phone);
        const pending_due=live?Math.max(0,-Number(live.net||0)):0;
        return {...r,recorded_debt:Number(r.recorded_debt||0),pending_due};
      });
      res.set('Cache-Control','no-store').json({ok:true,week,count:rows.length,rows});
    }catch(e){routeError(res,e,'NEGATIVE_MANUAL_REMOVED_FAILED')}
  });
  app.post('/api/admin/negative-week/manual-removed/:id/undo',auth,async(req,res)=>{
    try{
      await ensureTable();
      const id=parseId(req.params.id);
      if(!id)return res.status(400).json({ok:false,error:'INVALID_RECORD_ID'});
      const q=await pool.query('UPDATE negative_manual_removals SET undone_at=now() WHERE id=$1 AND undone_at IS NULL RETURNING week_id,captain_phone',[id]);
      if(!q.rowCount)return res.status(404).json({ok:false,error:'RECORD_NOT_FOUND'});
      await audit('NEGATIVE_MANUAL_REMOVAL_UNDONE',{record_id:id,week_id:q.rows[0].week_id,phone:q.rows[0].captain_phone});
      res.set('Cache-Control','no-store').json({ok:true});
    }catch(e){routeError(res,e,'NEGATIVE_MANUAL_UNDO_FAILED')}
  });
  app.get('/api/admin/weekly/archive/captain-search',auth,async(req,res)=>{
    try{
      const q=String(req.query.q||'').trim().slice(0,80);
      if(q.length<2)return res.set('Cache-Control','no-store').json({ok:true,rows:[]});
      const like='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
      const r=await pool.query(`
        SELECT s.week_id,COUNT(*)::int matches
        FROM weekly_settlements s JOIN accounting_weeks w ON w.id=s.week_id
        WHERE w.status='closed' AND w.trashed_at IS NULL
          AND (s.captain_phone ILIKE $1 ESCAPE '\' OR s.captain_name ILIKE $1 ESCAPE '\')
        GROUP BY s.week_id ORDER BY s.week_id DESC LIMIT 150
      `,[like]);
      res.set('Cache-Control','no-store').json({ok:true,rows:r.rows});
    }catch(e){routeError(res,e,'ARCHIVE_CAPTAIN_SEARCH_FAILED')}
  });
};
