const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const pages=['index.html','admin.html','captain.html','register.html'];
for(const page of pages){
  test(page+' uses AMMAN independent identity and loads the shared stylesheet',()=>{
    const html=fs.readFileSync(path.join(root,'public',page),'utf8');
    const css='/assets/amman-standalone.css?v=2';
    const theme=html.indexOf('/assets/amman-theme.css'),brand=html.indexOf(css);
    assert.ok(theme!==-1&&brand>theme,'AMMAN design must override legacy style declarations');
    assert.ok(html.includes('class="amman-footer"'));
    assert.ok(html.includes('AMMAN DELIVERY'));
    const visible=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'')
      .replace(/\bon\w+="[^"]*"/g,'');
    assert.doesNotMatch(visible,/Click\s*(?:<b>)?\s*Plus|TiGER|تايجر|كلك/i,'old visible branding should be absent');
    assert.doesNotMatch(visible,/GREEN-API متصل|Worker يعمل/,'connection badges must not pretend to be online');
  });
}
test('AMMAN stylesheet keeps dedicated admin, captain and mobile layouts',()=>{
 const css=fs.readFileSync(path.join(root,'public/assets/amman-standalone.css'),'utf8');
 for(const selector of ['body.amman-index .shell','body.amman-admin .wrap','body.amman-captain #s-home','body.amman-register .shell','@media(max-width:600px)'])
   assert.ok(css.includes(selector),selector+' missing');
});
test('core accounting handlers and auth routes are retained',()=>{
 const source=fs.readFileSync(path.join(root,'src/server.js'),'utf8');
 for(const route of ["/api/admin/weekly/close","/api/admin/login","/api/captain-auth","/health"]){
   assert.ok(source.includes(route),'missing critical route: '+route);
 }
 assert.match(source,/AmmanDelivery\/1\.0/);
});
