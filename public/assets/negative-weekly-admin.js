/* Weekly negative-balance tools shared by AMMAN / CLICK / TiGER / LOCATION. */
(function(){
  'use strict';
  var weeks=[],selectedWeekId=null,selectedWeekStatus='',weeklyRows=[],manualRows=[],loadSeq=0,archiveSeq=0;
  var hasLegacyRemoval=typeof window.loadNegativeCarryRemoved==='function';
  var outstandingDue=new Map();
  var previousRemoval=typeof window.removeSelectedNegativeCaptains==='function'?window.removeSelectedNegativeCaptains:null;
  var previousArchiveLoad=typeof window.loadArchive==='function'?window.loadArchive:null;
  function el(id){return document.getElementById(id)}
  function html(s){return typeof esc==='function'?esc(String(s==null?'':s)):String(s==null?'':s).replace(/[&<>"']/g,function(x){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]})}
  function fmt(n){return Number(n||0).toFixed(2)}
  function announce(s){if(typeof tell==='function')tell(s);else alert(s)}
  function weekName(w){var date=w.starts_at?new Date(w.starts_at).toLocaleDateString('ar-JO',{timeZone:'Asia/Amman'}):'';return 'الأسبوع #'+w.id+(date?' — '+date:'')+(w.status==='open'?' (الحالي)':' (مقفل)')}
  function isCurrent(){return selectedWeekStatus==='open'}
  function renderRows(){
    var tbody=el('negativeCarryBody');
    var count=el('negativeCarryCount');
    if(count)count.textContent=weeklyRows.length+' كابتن';
    if(!tbody)return;
    var hasBot=!!previousRemoval;
    tbody.innerHTML=weeklyRows.map(function(x){
      var phone=html(x.phone),canBot=hasBot&&isCurrent()&&Number(x.old_balance)>0;
      var check=canBot?'<input type="checkbox" class="neg-carry-check" value="'+phone+'">':'<span class="muted">—</span>';
      return '<tr><td>'+check+'</td><td><b>'+html(x.name)+'</b></td><td dir="ltr">'+phone+'</td>'+
        '<td class="money minus">'+fmt(x.old_balance)+'</td><td class="money minus"><b>'+fmt(x.current_net)+'</b></td>'+
        '<td class="money plus">'+fmt(x.current_week_production)+'</td><td class="money minus">'+fmt(x.current_week_consumption)+'</td>'+
        '<td><span class="badge off">عليه مبلغ</span></td><td><button class="btn btn-primary" type="button" data-phone="'+phone+'" onclick="markNegativeManual(this.dataset.phone)">✓ تم إزالته يدويًا</button></td></tr>';
    }).join('')||'<tr><td colspan="9" class="empty">✅ لا يوجد كباتن سالب غير مسجّلين كإزالة في هذا الأسبوع</td></tr>';
    var botButton=el('negativeBotRemoveButton');
    if(botButton){botButton.disabled=!isCurrent();botButton.title=isCurrent()?'إزالة أصحاب الرصيد المرحّل من القروبات':'الإزالة الآلية متاحة للأسبوع المفتوح فقط';}
    var toggleButtons=document.querySelectorAll('[onclick*="toggleNegativeCarryAll"]');
    toggleButtons.forEach(function(b){b.disabled=!isCurrent()});
  }
  function renderManualRemoved(){
    var tbody=el('negativeWeeklyManualRemovedBody'),count=el('negativeWeeklyManualRemovedCount');
    if(count)count.textContent=manualRows.length+' كابتن';
    if(!tbody)return;
    tbody.innerHTML=manualRows.map(function(x){
      var due=Number(x.pending_due||0),phone=html(x.phone);
      var wa=due>0.0001?'<button class="btn btn-primary" onclick="openNegativeWhatsApp(this.dataset.phone,this.dataset.name,this.dataset.amount)" data-phone="'+phone+'" data-name="'+html(x.name)+'" data-amount="'+due+'">💬 مطالبة واتساب</button>':'<span class="badge ok">لا يوجد مبلغ سالب حالي</span>';
      return '<tr><td><b>'+html(x.name)+'</b></td><td dir="ltr">'+phone+'</td><td>'+html(new Date(x.removed_at).toLocaleDateString('ar-JO'))+'</td>'+
        '<td class="money minus">'+fmt(x.recorded_debt)+'</td><td class="money minus">'+fmt(due)+'</td><td><span class="badge ok">✓ تمت إزالته يدويًا</span></td>'+
        '<td style="display:flex;gap:6px;flex-wrap:wrap">'+wa+'<button class="btn" onclick="undoNegativeManual('+Number(x.id)+')">↶ تراجع عن العلامة</button></td></tr>';
    }).join('')||'<tr><td colspan="7" class="empty">لا يوجد كباتن مسجّلين كإزالة يدوية في هذا الأسبوع</td></tr>';
  }
  async function loadWeek(){
    var id=Number(el('negativeWeekSelect')&&el('negativeWeekSelect').value);
    if(!id)return;
    selectedWeekId=id;
    var week=weeks.find(function(x){return Number(x.id)===id});
    selectedWeekStatus=week?week.status:'';
    var seq=++loadSeq;
    var responses=await Promise.all([
      api('/api/admin/negative-week/'+id+'/candidates?_='+Date.now()),
      api('/api/admin/negative-week/'+id+'/manual-removed?_='+Date.now())
    ]);
    if(seq!==loadSeq)return;
    if(!responses[0].ok||!responses[1].ok){announce('❌ تعذر تحميل كشف الأسبوع: '+html(responses.find(function(x){return !x.ok})?.error||''));return}
    weeklyRows=responses[0].rows||[];
    manualRows=responses[1].rows||[];
    if(typeof negativeCarryCandidates!=='undefined')negativeCarryCandidates=weeklyRows;
    var badge=el('negativeCarryWeek');if(badge)badge.textContent=weekName(week||{id:id,status:selectedWeekStatus});
    renderRows();renderManualRemoved();
  }
  async function loadNegativeSection(){
    var w=await api('/api/admin/negative-weeks?_='+Date.now());
    if(!w.ok)return announce('❌ تعذر تحميل الأسابيع');
    weeks=w.rows||[];
    var select=el('negativeWeekSelect');
    if(select){
      var previous=selectedWeekId;
      select.innerHTML=weeks.map(function(x){return '<option value="'+Number(x.id)+'">'+html(weekName(x))+'</option>'}).join('');
      select.value=String(weeks.some(function(x){return Number(x.id)===previous})?previous:(weeks[0]?.id||''));
    }
    await loadWeek();
    if(hasLegacyRemoval&&typeof window.loadNegativeCarryRemoved==='function'){
      var due=await api('/api/admin/negative-outstanding?_='+Date.now());
      if(due.ok)outstandingDue=new Map((due.rows||[]).map(function(x){return [String(x.phone),Number(x.due||0)]}));
      await window.loadNegativeCarryRemoved();
    }
  }
  window.loadNegativeRemovalSection=loadNegativeSection;
  window.loadNegativeCarryCandidates=loadWeek;
  window.changeNegativeWeek=loadWeek;
  window.refreshNegativeWeekly=loadNegativeSection;
  if(previousRemoval){
    window.removeSelectedNegativeCaptains=function(){
      if(!isCurrent())return announce('الإزالة من القروبات متاحة للأسبوع الحالي فقط؛ للأسبوع المقفل استخدم «تم إزالته يدويًا».');
      return previousRemoval.apply(this,arguments);
    };
  }
  window.markNegativeManual=async function(phone){
    var cap=weeklyRows.find(function(x){return x.phone===phone});
    if(!cap)return;
    if(!confirm('تأكيد أن المحاسب أزال «'+cap.name+'» من القروب يدويًا؟\n\nسيختفي من المرشحين، ويُحفظ في سجل الأسبوع. الرصيد والمستحقات لن تتغير.'))return;
    var j=await api('/api/admin/negative-week/'+selectedWeekId+'/manual-remove',{method:'POST',body:JSON.stringify({phone:phone})});
    if(!j.ok)return announce('❌ '+(j.error||'فشل التسجيل'));
    announce('✅ تم تسجيل الإزالة اليدوية بدون تعديل الرصيد');
    await loadWeek();
  };
  window.undoNegativeManual=async function(id){
    if(!confirm('إلغاء علامة «تم إزالته يدويًا»؟\nلن تتم إضافة الكابتن إلى واتساب تلقائيًا.'))return;
    var j=await api('/api/admin/negative-week/manual-removed/'+Number(id)+'/undo',{method:'POST',body:'{}'});
    if(!j.ok)return announce('❌ '+(j.error||'فشل التراجع'));
    await loadWeek();announce('✅ أُلغيت العلامة ويمكن مراجعة الكابتن مجددًا');
  };
  window.openNegativeWhatsApp=function(phone,name,amount){
    var due=Number(amount||0);
    if(!(due>0))return announce('لا يوجد مبلغ مستحق ظاهر حاليًا للمطالبة');
    var digits=String(phone||'').replace(/\D/g,'');
    if(!/^9627\d{8}$/.test(digits))return announce('رقم واتساب غير صالح');
    var message='مرحبًا '+String(name||'')+'،\nحسب كشف حساب التوصيل يوجد مبلغ مستحق غير مسدد بقيمة '+fmt(due)+' دينار أردني.\nنرجو تسديد المبلغ وإرسال إثبات التحويل للإدارة. إذا سبق أن دفعت، يرجى إرسال الإثبات لمراجعة الحساب.\nشكرًا لتعاونك.';
    window.open('https://wa.me/'+digits+'?text='+encodeURIComponent(message),'_blank','noopener,noreferrer');
  };
  // Preserve the legacy WhatsApp-group removal/restore history and add a manual demand link.
  if(hasLegacyRemoval){
    window.renderNegativeCarryRemoved=function(){
      var tbody=el('negativeRemovedBody'),count=el('negativeRemovedCount');
      if(!tbody)return;
      var rows=typeof negativeCarryRemoved!=='undefined'?negativeCarryRemoved:[];
      if(count)count.textContent=rows.length+' كابتن';
      tbody.innerHTML=rows.map(function(x){
        var due=Math.max(0,-Number(x.current_net||0),outstandingDue.get(String(x.phone))||0);
        var wa=due>0.0001?'<button class="btn btn-primary" data-phone="'+html(x.phone)+'" data-name="'+html(x.name)+'" data-amount="'+due+'" onclick="openNegativeWhatsApp(this.dataset.phone,this.dataset.name,this.dataset.amount)">💬 مطالبة واتساب</button>':'';
        var groups=typeof removedGroupsHtml==='function'?removedGroupsHtml(x.groups):'—';
        return '<tr><td><b>'+html(x.name)+'</b></td><td dir="ltr">'+html(x.phone)+'</td><td>'+html(new Date(x.removed_at).toLocaleDateString('ar-JO'))+'</td>'+
          '<td class="money minus">'+fmt(x.current_net)+'</td><td>'+groups+'</td><td>'+(due>0?'<span class="badge off">عليه '+fmt(due)+' د.أ</span>':'<span class="badge ok">لا يوجد رصيد سالب</span>')+'</td>'+
          '<td><div style="display:flex;gap:6px;flex-wrap:wrap">'+wa+'<button class="btn btn-primary" onclick="restoreNegativeCaptain(this.dataset.phone)" data-phone="'+html(x.phone)+'">↩️ إرجاع للقروبات</button></div></td></tr>';
      }).join('')||'<tr><td colspan="7" class="empty">ما في كباتن تمت إزالتهم من القروبات بواسطة البوت</td></tr>';
    };
  }
  window.searchArchiveCaptains=async function(){
    var input=el('archiveCaptainSearch'),badge=el('archiveCaptainSearchStatus');
    if(!input||typeof state==='undefined'||typeof renderArchive!=='function')return;
    var query=input.value.trim(),seq=++archiveSeq;
    if(query.length<2){
      renderArchive();
      if(badge)badge.textContent=query?'اكتب حرفين على الأقل':'';
      return;
    }
    if(badge)badge.textContent='جاري البحث...';
    var r=await api('/api/admin/weekly/archive/captain-search?q='+encodeURIComponent(query));
    if(seq!==archiveSeq||!r.ok)return;
    var matched=new Map((r.rows||[]).map(function(x){return [Number(x.week_id),Number(x.matches||0)]}));
    var original=state.archive||[];
    state.archive=original.filter(function(x){return matched.has(Number(x.id))});
    try{renderArchive()}finally{state.archive=original}
    if(badge)badge.textContent=matched.size?'وُجد في '+matched.size+' أسبوع':'لا يوجد كابتن مطابق في الأرشيف';
  };
  if(previousArchiveLoad){
    window.loadArchive=async function(){
      var r=await previousArchiveLoad.apply(this,arguments);
      var input=el('archiveCaptainSearch');
      if(input&&input.value.trim().length>=2)await window.searchArchiveCaptains();
      return r;
    };
  }
})();
