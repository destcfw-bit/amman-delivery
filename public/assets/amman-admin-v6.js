
(()=>{
 const $=(s,r=document)=>r.querySelector(s);
 function inject(){
   const main=$('.main'); if(main&&!$('#cpLiveStrip'))main.insertAdjacentHTML('afterbegin',`<div id="cpLiveStrip" class="cp-live-strip"><span class="cp-live-item" data-k="whatsapp"><i class="cp-live-dot"></i>WhatsApp <b>…</b></span><span class="cp-live-item" data-k="db"><i class="cp-live-dot"></i>DB <b>…</b></span><span class="cp-live-item" data-k="worker"><i class="cp-live-dot"></i>Worker <b>…</b></span><span class="cp-live-item" data-k="group"><i class="cp-live-dot"></i>Groups <b>…</b></span><span class="cp-live-item" data-k="queue"><i class="cp-live-dot"></i>Queue <b>…</b></span><span id="cpLiveTime" class="cp-live-time">—</span></div>`);
   const hero=$('.hero h1'); if(hero)hero.parentElement.classList.add('cp-command-title');
   const groups=$('#s-groups'); if(groups&&!$('#cpRadarPanel'))groups.insertAdjacentHTML('afterbegin',`<div id="cpRadarPanel" class="cp-radar-panel"><div class="cp-radar"><i class="cp-radar-ping" style="right:23%;top:38%"></i><i class="cp-radar-ping p2"></i><i class="cp-radar-ping p3"></i></div><div class="cp-radar-stats"><div class="cp-radar-stat"><small>قروبات مفعلة</small><b id="radarGroups">0</b></div><div class="cp-radar-stat"><small>كباتن فعالين</small><b id="radarActive" class="plus">0</b></div><div class="cp-radar-stat"><small>كباتن موقوفين</small><b id="radarStopped" class="minus">0</b></div><div class="cp-radar-stat"><small>أرقام غير مسجلة</small><b id="radarUnknown" class="floor">0</b></div></div></div>`);
 }
 function setItem(k,cls,text){const el=$(`#cpLiveStrip [data-k="${k}"]`);if(!el)return;el.classList.remove('ok','warn','bad');if(cls)el.classList.add(cls);const b=$('b',el);if(b)b.textContent=text}
 async function runtime(){if(typeof window.api!=='function')return;const j=await api('/api/admin/runtime-status');if(!j.ok){setItem('db','bad','Offline');setItem('worker','bad','Unknown');return}setItem('db',j.db?'ok':'bad',j.db?'Online':'Offline');setItem('worker',j.worker?.running?'ok':'warn',j.worker?.running?'Running':'Waiting');setItem('whatsapp',j.whatsapp?.online?'ok':j.whatsapp?.configured?'warn':'bad',j.whatsapp?.online?'Online':j.whatsapp?.configured?(j.whatsapp.state||'Configured'):'Not Configured');setItem('group',Number(j.groups)>0?'ok':'warn',String(j.groups||0)+' Active');setItem('queue',Number(j.queue)>20?'warn':'ok',String(j.queue||0));if($('#cpLiveTime'))$('#cpLiveTime').textContent=new Date(j.time||Date.now()).toLocaleTimeString('ar-JO',{hour:'2-digit',minute:'2-digit'});if($('#radarGroups'))$('#radarGroups').textContent=j.groups||0}
 function radar(){if(typeof state==='undefined')return;const rows=state.rows||[],caps=state.captains||[],unknown=state.unregistered||[];if($('#radarGroups'))$('#radarGroups').textContent=(state.groups||[]).filter(x=>x.active).length;if($('#radarActive'))$('#radarActive').textContent=caps.filter(x=>x.active).length;if($('#radarStopped'))$('#radarStopped').textContent=caps.filter(x=>!x.active).length;if($('#radarUnknown'))$('#radarUnknown').textContent=unknown.length}
 inject();
 const hasAdminToken=()=>!!localStorage.getItem('amman_token');
 if(hasAdminToken())runtime();
 setInterval(()=>{if(hasAdminToken())runtime()},60000);
 if(typeof window.renderGroups==='function'){const old=window.renderGroups;window.renderGroups=function(){const r=old();radar();return r}}
 if(typeof window.renderAll==='function'){const old=window.renderAll;window.renderAll=function(){const r=old();radar();return r}}
 setTimeout(radar,800);
})();

