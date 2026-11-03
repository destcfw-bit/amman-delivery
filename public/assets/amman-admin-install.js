/* AMMAN DELIVERY — administrator PWA installer */
(function(){
  'use strict';
  const btn=document.getElementById('amAdminInstallBtn');
  const modal=document.getElementById('amAdminInstallModal');
  const text=document.getElementById('amAdminInstallHelp');
  if(!btn||!modal||!text)return;
  let installPrompt=null;
  const standalone=()=>window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;
  const isiOS=()=>/iPhone|iPad|iPod/i.test(navigator.userAgent)||(/Macintosh/i.test(navigator.userAgent)&&navigator.maxTouchPoints>1);
  const update=()=>{btn.hidden=standalone();};
  function showInstructions(){
    text.textContent=isiOS()
      ? 'على iPhone: افتح الصفحة من Safari، اضغط زر المشاركة، ثم «إضافة إلى الشاشة الرئيسية» واضغط «إضافة». سيفتح الاختصار لوحة الإدارة مباشرة.'
      : 'على Android: افتح الصفحة من Chrome، ثم من قائمة ⋮ اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية». على الكمبيوتر استخدم خيار تثبيت التطبيق من قائمة المتصفح إن كان متاحًا.';
    modal.hidden=false;
    modal.querySelector('button')?.focus();
  }
  btn.addEventListener('click',async()=>{
    if(standalone()){update();return;}
    if(!installPrompt){showInstructions();return;}
    const event=installPrompt;
    installPrompt=null;
    try{await event.prompt();await event.userChoice;}catch(_){showInstructions();}
    update();
  });
  modal.querySelector('[data-am-install-close]')?.addEventListener('click',()=>{modal.hidden=true;btn.focus();});
  modal.addEventListener('click',e=>{if(e.target===modal)modal.hidden=true;});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')modal.hidden=true;});
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;update();});
  window.addEventListener('appinstalled',()=>{installPrompt=null;update();});
  update();
  if('serviceWorker' in navigator&&location.protocol==='https:'){
    window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(e=>console.warn('AMMAN admin PWA registration failed',e.message)));
  }
})();
