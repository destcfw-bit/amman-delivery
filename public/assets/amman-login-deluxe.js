/* Cosmetic login enhancements. Passwords and auth responses are never stored here. */
(()=>{'use strict';
const onReady=()=>{
const login=document.getElementById('login'),phone=document.getElementById('phone'),password=document.getElementById('password'),button=login?.querySelector('.login-btn'),card=login?.querySelector('.ad-login-card'),msg=document.getElementById('loginMsg');
if(!login||!phone||!password||!button||!card)return;
phone.setAttribute('inputmode','tel');phone.setAttribute('autocomplete','username');phone.setAttribute('enterkeyhint','next');
password.setAttribute('autocomplete','current-password');password.setAttribute('enterkeyhint','go');
const fieldHint=document.createElement('div');fieldHint.className='ad-field-hint';fieldHint.setAttribute('role','status');phone.after(fieldHint);
const caps=document.createElement('div');caps.className='ad-caps-warning';caps.textContent='تنبيه: زر Caps Lock مفعّل';password.closest('.am-password-wrap')?.after(caps);
const checkbox=document.createElement('label');checkbox.className='ad-remember';checkbox.innerHTML='<input type="checkbox" id="adRememberDevice"> تذكّر رقم هاتفي على هذا الجهاز';button.before(checkbox);
const saved=localStorage.getItem('amman_remember_phone');if(saved&&/^07\d{8}$/.test(saved)){phone.value=saved;checkbox.querySelector('input').checked=true}
const status=document.createElement('div');status.className='ad-login-status';status.setAttribute('aria-live','polite');button.after(status);
const biometric=document.createElement('div');biometric.className='ad-biometric-note';biometric.textContent='البصمة وFace ID تتطلب تفعيل Passkeys الآمن من السيرفر، وليست مفعّلة حاليًا';card.querySelector('.ad-safe-note')?.after(biometric);
const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if(!reduced){const layer=document.createElement('div');layer.className='ad-particles';for(let i=0;i<12;i++){const b=document.createElement('i');b.className='ad-particle';b.style.setProperty('--x',((i*31+8)%100)+'%');b.style.setProperty('--y',((i*23+12)%100)+'%');b.style.setProperty('--d',(4+(i%5))+'s');layer.append(b)}login.prepend(layer)}
function validate(){const v=phone.value.replace(/\s/g,'');if(!v)fieldHint.textContent='';else if(!/^07\d{8}$/.test(v))fieldHint.textContent='اكتب رقم أردني بصيغة 07XXXXXXXX';else fieldHint.textContent='';return /^07\d{8}$/.test(v)}
phone.addEventListener('input',validate);password.addEventListener('keyup',e=>caps.classList.toggle('visible',Boolean(e.getModifierState&&e.getModifierState('CapsLock'))));
phone.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();password.focus()}});
password.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();button.click()}});
const original=window.loginCaptain;if(typeof original!=='function')return;
let running=false;
window.loginCaptain=async function(){if(running)return;const v=validate();if(!v||!password.value){status.textContent='تأكد من رقم الهاتف وكلمة المرور';return}
running=true;button.disabled=true;const label=button.innerHTML;button.textContent='جارٍ التحقق من بياناتك…';status.textContent='اتصال آمن بالسيرفر';
if(checkbox.querySelector('input').checked)localStorage.setItem('amman_remember_phone',phone.value.replace(/\s/g,''));else localStorage.removeItem('amman_remember_phone');
try{await original.apply(this,arguments);
if(document.body.classList.contains('captain-app-ready')){card.classList.add('ad-login-success');status.textContent='تم تسجيل الدخول بنجاح'}
else if(msg?.textContent&&!/جاري|جارٍ/.test(msg.textContent)){card.classList.remove('ad-shake');void card.offsetWidth;card.classList.add('ad-shake');status.textContent='تعذر تسجيل الدخول — راجع التنبيه أعلاه'}
else if(document.body.classList.contains('captain-onboarding'))status.textContent='يرجى إكمال تجهيز حسابك';
}catch(e){status.textContent='تعذر الاتصال، حاول مرة أخرى';throw e}
finally{running=false;button.disabled=false;button.innerHTML=label}
};
};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',onReady);else onReady();
})();
