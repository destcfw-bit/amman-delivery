/* Cinematic entrance, cosmetic only. */
(()=>{'use strict';
const intro=document.getElementById('amCinematicIntro');if(!intro)return;
let token='';try{token=localStorage.getItem('amman_captain_token')||''}catch(e){}
const reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if(token){intro.remove();return}
let done=false,normalTimer=null,failTimer=null;
const finish=()=>{if(done)return;done=true;clearTimeout(normalTimer);clearTimeout(failTimer);intro.classList.add('am-intro-leaving');const clean=()=>intro.remove();if(reduce)clean();else setTimeout(clean,520)};
intro.querySelector('.am-intro-skip')?.addEventListener('click',finish,{once:true});
normalTimer=setTimeout(finish,reduce?100:2300);
failTimer=setTimeout(finish,3900);
document.addEventListener('visibilitychange',()=>{if(document.hidden)finish()},{once:true});
})();
