const C='amman-delivery-standalone-v1';
const STATIC=['/manifest.webmanifest','/assets/amman-logo.jpeg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.addAll(STATIC)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const u=new URL(e.request.url);
  if(u.pathname.startsWith('/api/'))return;
  const fresh=e.request.mode==='navigate'||u.pathname.endsWith('.html')||u.pathname.endsWith('.css')||u.pathname.endsWith('.js')||u.pathname==='/admin'||u.pathname==='/captain'||u.pathname==='/register';
  if(fresh){
    e.respondWith(fetch(e.request,{cache:'no-store'}).catch(()=>caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request).then(r=>{const x=r.clone();caches.open(C).then(c=>c.put(e.request,x));return r})));
});

