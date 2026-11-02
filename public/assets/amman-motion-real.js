/* Production-bound animation glue. Presentation only: server responses remain authoritative. */
(()=>{'use strict';
const root=document;
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
function install(){
 const refresh=root.querySelector('.am-top-actions button[aria-label="تحديث الحساب"]');
 let pending=0,progress=root.getElementById('amRealProgress'),status=root.getElementById('amRealStatus');
 function loading(on){
  pending=Math.max(0,pending+(on?1:-1));
  if(!progress){progress=root.createElement('div');progress.id='amRealProgress';progress.className='am-actual-progress';progress.setAttribute('role','progressbar');progress.setAttribute('aria-label','تحميل بيانات الحساب');progress.hidden=true;root.body.append(progress)}
  if(!status){status=root.createElement('div');status.id='amRealStatus';status.className='am-load-status';status.setAttribute('role','status');status.hidden=true;status.textContent='جاري تحديث بيانات الحساب';root.body.append(status)}
  const active=pending>0;progress.hidden=!active;status.hidden=!active;
  refresh?.classList.toggle('am-loading',active);
  if(refresh){refresh.disabled=active;refresh.setAttribute('aria-busy',String(active))}
 }
 const fn=window.loadAll;
 if(typeof fn==='function'&&!fn.__amRealLoading){
   const wrapped=async function(...args){
     loading(true);
     try{return await fn.apply(this,args)}
     finally{loading(false)}
   };
   wrapped.__amRealLoading=true;
   window.loadAll=wrapped;
 }
 // Existing cpTween already interpolates from server values. Only flash the final displayed number after a real change.
 const fields=['prod','cons','floor','orderCount','balanceText'];
 const last=new Map();
 const timers=new Map();
 fields.forEach(id=>{
  const el=root.getElementById(id);if(!el)return;
  let tracked=el.dataset.cpValue;
  last.set(id,tracked);
  const watcher=new MutationObserver(()=>{
   const next=el.dataset.cpValue;
   if(next===last.get(id))return;
   const previous=last.get(id);last.set(id,next);
   if(previous===undefined||previous===null||reduced)return;
   clearTimeout(timers.get(id));
   timers.set(id,setTimeout(()=>{
    el.classList.remove('am-numeric-morph');
    void el.offsetWidth;
    el.classList.add('am-numeric-morph');
   },480));
  });
  watcher.observe(el,{attributes:true,attributeFilter:['data-cp-value']});
 });
 // Go already implements a 150ms exit transition and then enters the next screen.
 // Keep it authoritative; do not introduce a competing navigation delay.
 const go=window.go;
 if(typeof go==='function'&&!go.__amExitLinked){
   const wrapped=function(name,btn){
    const old=root.querySelector('.section.active'),next=root.getElementById('s-'+name);
    if(old&&next&&old!==next&&!reduced){
      old.classList.add('am-exit-real');
      setTimeout(()=>old.classList.remove('am-exit-real'),170);
    }
    return go.apply(this,arguments);
   };
   wrapped.__amExitLinked=true;
   window.go=wrapped;
 }
}
if(root.readyState==='loading')root.addEventListener('DOMContentLoaded',install);else install();
})();
