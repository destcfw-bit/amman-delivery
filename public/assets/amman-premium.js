/* Captain premium enhancements; no writes to accounting APIs. */
(()=>{'use strict';
const $=(s)=>document.querySelector(s);
const safeNum=(id)=>{const t=($('#'+id)?.textContent||'').replace(/[^\d.,-]/g,'').replace(/,/g,'');const n=parseFloat(t);return Number.isFinite(n)?Math.max(0,n):0};
const afterApp=()=>{
const home=$('#s-home');if(home&&!$('#adPremiumChart')){
const panel=document.createElement('section');panel.id='adPremiumChart';panel.className='ad-premium-chart';panel.setAttribute('aria-label','مقارنة الإنتاج والاستهلاك');
panel.innerHTML='<h3>◈ الإنتاج والاستهلاك</h3><div class="ad-premium-bars"><div class="ad-premium-bar production" id="adProdBar"></div><div class="ad-premium-bar consumption" id="adConsBar"></div></div><div class="ad-premium-legend"><span>الإنتاج <strong id="adProdSum">—</strong></span><span>الاستهلاك <strong id="adConsSum">—</strong></span></div>';
const place=home.querySelector('.am-metrics');if(place)place.after(panel);else home.append(panel);
}
const profile=$('#s-profile');if(profile&&!$('#adPremiumWA')){const a=document.createElement('a');a.id='adPremiumWA';a.className='ad-premium-whatsapp';a.href='https://wa.me/962791579870';a.target='_blank';a.rel='noopener noreferrer';a.textContent='◉ تواصل مع DropCode عبر واتساب';profile.append(a)}
};
const chart=()=>{const p=safeNum('prod'),c=safeNum('cons'),m=Math.max(p,c,1);const a=$('#adProdBar'),b=$('#adConsBar');if(a)a.style.height=Math.max(5,p/m*100)+'%';if(b)b.style.height=Math.max(5,c/m*100)+'%';if($('#adProdSum'))$('#adProdSum').textContent=p.toFixed(2)+' د.أ';if($('#adConsSum'))$('#adConsSum').textContent=c.toFixed(2)+' د.أ'};
let latestBalance=null;const animateBalance=()=>{const el=$('#balanceText');if(!el)return;const str=el.textContent||'';const target=parseFloat(str.replace(/[^\d.,-]/g,'').replace(/,/g,''));if(!Number.isFinite(target)||target===latestBalance)return;latestBalance=target;if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;const fmt=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});const suffix=str.replace(/[\d.,\s-]/g,'').trim()||'د.أ';const started=performance.now();function step(now){if(latestBalance!==target)return;const t=Math.min(1,(now-started)/700),ease=1-Math.pow(1-t,3);el.textContent=fmt.format(target*ease)+' '+suffix;if(t<1)requestAnimationFrame(step);else el.textContent=str}requestAnimationFrame(step)};
let busy=false;const update=()=>{if(busy)return;busy=true;requestAnimationFrame(()=>{busy=false;afterApp();chart()})};
document.addEventListener('DOMContentLoaded',()=>{
afterApp();chart();
let lastP='',lastC='',lastBal='';
setInterval(()=>{if(!document.body.classList.contains('captain-app-ready'))return;const p=$('#prod')?.textContent,c=$('#cons')?.textContent,b=$('#balanceText')?.textContent;if(p!==lastP||c!==lastC){lastP=p;lastC=c;update()}if(b!==lastBal){lastBal=b;/* balance display remains server-authoritative */}},1100);
const node=$('#app');if(node){const obs=new MutationObserver(()=>{if(document.body.classList.contains('captain-app-ready'))update()});obs.observe(node,{attributes:true,subtree:false})}
});
})();
