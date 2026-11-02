const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const pages=['index.html','admin.html','captain.html','register.html'];
const styles=[
 'amman-common.css','amman-admin.css','amman-admin-v6.css',
 'amman-captain.css','amman-captain-v7.css','amman-register.css',
 'amman-v6.css','amman-theme.css','amman-standalone.css'
];
const forbidden=/#(?:24a7ff|14b8ff|15c5ff|0876cf|086ec8|087fd4|ff8a1b|ff8a1d|ff7417|ff7a00|ff9a35|ff9d18|22a8ff|1478ff|0b86d0|16bfff|17bfff)(?:[a-f0-9]{2})?\b/gi;
const oldRgb=/rgba?\(\s*(?:36\s*,\s*167\s*,\s*255|20\s*,\s*184\s*,\s*255|255\s*,\s*138\s*,\s*29|255\s*,\s*116\s*,\s*23)/gi;
for(const file of [...pages.map(x=>'public/'+x),...styles.map(x=>'public/assets/'+x)]){
 test('no inherited brand colors in '+file,()=>{
  const source=fs.readFileSync(path.join(root,file),'utf8');
  assert.doesNotMatch(source,forbidden);
  assert.doesNotMatch(source,oldRgb);
 });
}
test('captain phone login has complete visual intro and password control',()=>{
 const html=fs.readFileSync(path.join(root,'public/captain.html'),'utf8');
 const css=fs.readFileSync(path.join(root,'public/assets/amman-captain-v7.css'),'utf8');
 const js=fs.readFileSync(path.join(root,'public/assets/amman-captain-v7.js'),'utf8');
 for(const marker of ['am-mobile-brand','am-mobile-intro','am-mobile-features','am-password-wrap','am-password-eye']){
  assert.ok(html.includes(marker),marker+' missing');
  assert.ok(css.includes(marker),marker+' styling missing');
 }
 assert.match(js,/window\.adTogglePassword=function/);
 assert.match(html,/aria-pressed="false"/);
 assert.equal((html.match(/id="password"/g)||[]).length,1);
 assert.match(css,/@media\(max-width:374px\)/);
 assert.match(css,/max-height:700px/);
});
test('single correct mobile browser theme color and all refreshed CSS links',()=>{
 const html=fs.readFileSync(path.join(root,'public/captain.html'),'utf8');
 assert.deepEqual([...html.matchAll(/<meta name="theme-color" content="([^"]+)">/g)].map(x=>x[1]),['#f6f5f2']);
 assert.match(html,/amman-captain-v7\.css\?v=2/);
 assert.match(html,/amman-captain-v7\.js\?v=2/);
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'public/manifest.webmanifest'),'utf8'));
 assert.equal(manifest.theme_color,'#f6f5f2');
 assert.equal(manifest.start_url,'/captain');
});
