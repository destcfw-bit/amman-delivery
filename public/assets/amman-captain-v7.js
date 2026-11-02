
(()=>{
  const q=(s,r=document)=>r.querySelector(s), qa=(s,r=document)=>[...r.querySelectorAll(s)];
  const money6=v=>Number(v||0).toFixed(2);
  function markCode(){return 'AD-CAPTAIN'}
  function injectShell(){
    // Keep security history, without injecting the old balance orb or rewriting the new layout.
    const profile=q('#s-profile');
    if(profile&&!q('#securityBox',profile)){
      profile.insertAdjacentHTML('afterbegin',`<div class="cp-account-tools"><button onclick="adNavigate('history')">▤ كشف الحساب</button><button onclick="adNavigate('notifications')">♧ الإشعارات</button><button onclick="logoutAllDevices()">⌁ خروج الأجهزة</button></div><div class="panel"><div class="ph"><div><h3>أمان الحساب</h3><small>آخر جلسات الدخول</small></div></div><div class="pb" id="securityBox">—</div></div>`);
    }
  }
  function signature(ms=520){return}
  function pulse(x,y){return}
  function sound(kind='click'){
    if(typeof clickSoundOn!=='undefined'&&!clickSoundOn)return;
    try{const C=AudioContext||webkitAudioContext,ctx=new C(),o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);const n=ctx.currentTime;const f=kind==='success'?[510,760]:kind==='warning'?[230,160]:[330,470];o.type=kind==='warning'?'triangle':'sine';o.frequency.setValueAtTime(f[0],n);o.frequency.exponentialRampToValueAtTime(f[1],n+.1);g.gain.setValueAtTime(.0001,n);g.gain.exponentialRampToValueAtTime(.022,n+.015);g.gain.exponentialRampToValueAtTime(.0001,n+.16);o.start(n);o.stop(n+.18);setTimeout(()=>ctx.close().catch(()=>{}),260)}catch(e){}
  }
  function updateOrb(){const d=(typeof state!=='undefined'?state.me:null);if(!d)return;const prod=Math.max(0,Number(d.production||0)),due=Math.max(0,Number(d.consumption||0)+Number(d.floor_fee||0)+Math.max(0,Number(d.old_balance||0))),sum=prod+due||1,share=Math.max(5,Math.min(95,prod/sum*100)),net=Number(d.net||0);const orb=q('#cpBalanceOrb');if(orb)orb.style.setProperty('--share',share+'%');if(q('#cpOrbNet'))q('#cpOrbNet').textContent=(net>0?'+':'')+money6(net);if(q('#cpOrbProd'))q('#cpOrbProd').textContent=money6(prod);if(q('#cpOrbDue'))q('#cpOrbDue').textContent=money6(due);if(q('#cpOrbMeaning')){q('#cpOrbMeaning').textContent=net>0?'إلك':net<0?'عليك':'متعادل';q('#cpOrbMeaning').className=net>0?'plus':net<0?'minus':''}if(q('#cpCaptainCode'))q('#cpCaptainCode').textContent=markCode()}
  function timeline(){
    if(typeof state==='undefined'||!document.getElementById('ordersList')||typeof counterpart!=='function')return;
    const qv=(window.orderSearch?.value||'').trim().toLowerCase(),t=window.orderType?.value||'all',st=window.orderStatus?.value||'all';
    const rows=state.moves.filter(m=>{const c=counterpart(m),hay=[m.original_text,m.reply_text,m.group_name,c.name,c.phone].join(' ').toLowerCase(),ms=movementState(m);return (t==='all'||m.direction===t)&&(st==='all'||st===ms)&&(!qv||hay.includes(qv))});
    document.getElementById('ordersList').innerHTML=`<div class="cp-movement-timeline">${rows.map((m,i)=>{const c=counterpart(m),ms=movementState(m),rx=m.reaction||m.current_reaction||'—',klass=ms==='cancelled'?'cancelled':m.direction;return `<article class="cp-move ${klass}"><div class="cp-move-card"><div class="cp-move-head"><span class="status ${m.direction==='production'?'ok':'info'}">${m.direction==='production'?'إنتاج':'استهلاك'}</span><span class="cp-reaction-chip ${i<2?'hot':''}">${esc(rx)} <b>${money(m.amount)} د.أ</b></span><time>${dt(m.created_at)}</time></div><div class="cp-move-main">${esc(m.original_text||'حركة بدون نص')}</div><div class="cp-move-sub"><span>${c.label}: <b>${esc(c.name||'—')}</b></span><span>${esc(m.group_name||'—')}</span></div>${reactionHistory(m)?`<div class="callout" style="margin-top:9px">↻ ${reactionHistory(m)}</div>`:''}<div class="cp-move-actions"><button class="btn" onclick="orderDetails(${m.id})">التفاصيل</button><button class="btn btn-danger" onclick="openObjection(${m.id})">اعتراض</button></div></div></article>`}).join('')||'<div class="empty">ما في حركات مطابقة</div>'}</div>`;
  }
  function weekScene(){return}
  function skeleton(on){document.body.classList.toggle('cp-loading',!!on);if(on){qa('.stat b,.hero h1').forEach(x=>x.classList.add('cp-skeleton'))}else qa('.cp-skeleton').forEach(x=>x.classList.remove('cp-skeleton'))}
  injectShell();
  document.addEventListener('pointerdown',e=>{const b=e.target.closest('button,.btn,.chip,.iconbtn');if(!b)return;pulse(e.clientX,e.clientY);sound('click')},{passive:true});
  const titles={home:'نظرة عامة',orders:'حركاتي وطلباتي',settlement:'التسويات',history:'كشوف الحساب',notifications:'الإشعارات',profile:'حسابي'};
  function reflectNav(n){
    qa('.am-side-links [data-am-nav]').forEach(btn=>{const selected=btn.dataset.amNav===n;btn.classList.toggle('is-current',selected);if(selected)btn.setAttribute('aria-current','page');else btn.removeAttribute('aria-current')});
    qa('.am-mobile-tabs [data-tab]').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===n));
    const title=q('#amPageTitle');if(title)title.textContent=titles[n]||'بوابة الكابتن';
  }
  const oldGo=window.go;window.go=function(n,b){reflectNav(n);return oldGo(n,b)};
  window.adNavigate=function(n){const tab=q('.am-mobile-tabs [data-tab="'+n+'"]');reflectNav(n);window.go(n,tab||null)};
  window.adTogglePassword=function(button){
    const field=document.getElementById('password');
    if(!field||!button)return;
    const visible=field.type==='password';
    field.type=visible?'text':'password';
    button.textContent=visible?'إخفاء':'إظهار';
    button.setAttribute('aria-label',visible?'إخفاء كلمة المرور':'إظهار كلمة المرور');
    button.setAttribute('aria-pressed',String(visible));
  };
  reflectNav('home');
  const oldRenderAll=window.renderAll;window.renderAll=function(){const r=oldRenderAll();updateOrb();setTimeout(()=>{timeline();weekScene()},40);return r};
  window.renderOrders=timeline;
  const oldLoad=window.loadAll;window.loadAll=async function(){skeleton(true);try{return await oldLoad()}finally{setTimeout(()=>skeleton(false),180)}};
  const oldTell=window.tell;window.tell=function(m){oldTell(m);const s=String(m||'');if(/^✅|تم /.test(s))sound('success');else if(/^❌|⛔|⚠/.test(s))sound('warning')};
  setTimeout(()=>{updateOrb();timeline()},900);
})();

