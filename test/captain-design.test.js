const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public/captain.html'),'utf8');
const beforeScripts=html.split('<script>')[0];
const css=fs.readFileSync(path.join(root,'public/assets/amman-captain-v7.css'),'utf8');
const js=fs.readFileSync(path.join(root,'public/assets/amman-captain-v7.js'),'utf8');
const important=[
  'login','phone','password','loginMsg','onboarding','newPw','newPw2','ob1','ob2','payMethod','payFields',
  'app','s-home','s-orders','s-settlement','s-history','s-notifications','s-profile',
  'capName','statusBadge','stoppedBanner','balanceText','balanceMeaning','weekTitle','weekTime','weekCount',
  'prod','cons','floor','orderCount','settlementHome','activitySummary','ordersList','orderSearch','orderType',
  'orderStatus','settlementBox','currentStatement','historyList','notificationsList','objectionsList',
  'profileName','profilePhone','profileStatus','profileReason','profileSeen','profileLogin','paymentCurrent',
  'oldPw','changePw','installBtn','modal','modalTitle','modalBody','toast','notifDot','soundToggle'
];
test('new captain DOM retains all critical live fields exactly once',()=>{
 for(const id of important){
  const pattern=new RegExp('\\bid="'+id+'"','g');
  const n=[...beforeScripts.matchAll(pattern)].length;
  assert.equal(n,1,'must retain exactly one live element #'+id);
 }
});
test('captain dashboard is a new finance app with distinct login and home architecture',()=>{
 for(const marker of ['am-auth-shell','am-auth-story','am-app-frame','am-side-links','am-money-card',
  'am-week-card','am-account-grid','am-metrics','am-quick','am-mobile-tabs','am-workspace']){
  assert.ok(beforeScripts.includes(marker),'missing new layout: '+marker);
 }
 assert.match(html,/amman-captain-v7\.css\?v=1/);
 assert.match(html,/amman-captain-v7\.js\?v=1/);
 assert.doesNotMatch(beforeScripts,/Click\s*Plus|TiGER|تايجر|كلك/);
});
test('all six captain sections remain navigable on desktop and mobile',()=>{
 for(const name of ['home','orders','settlement','history','notifications','profile']){
  assert.ok(beforeScripts.includes('data-am-nav="'+name+'"'),name+' desktop navigation missing');
  assert.ok(js.includes(name+':')||js.includes("'"+name+"'"),name+' missing nav handling');
 }
 for(const name of ['home','orders','settlement','history','profile']){
  assert.ok(beforeScripts.includes('data-tab="'+name+'"'),name+' mobile tab missing');
 }
 assert.match(js,/window\.adNavigate=function/);
 assert.match(js,/window\.renderOrders=timeline/);
});
test('visual layer supports responsive mobile and keeps onboarding and statements',()=>{
 assert.match(css,/@media\(max-width:980px\)/);
 assert.match(css,/@media\(max-width:700px\)/);
 assert.match(css,/am-auth-form-area/);
 assert.match(css,/\.onboarding/);
 assert.match(css,/am-metrics/);
 assert.match(html,/openPreviousWeekStatement\(\)/);
 assert.match(html,/changePassword\(\)/);
 assert.match(html,/markNotificationsRead\(\)/);
});
