/**
 * AMMAN DELIVERY -> Google Sheet "AMMAN DELIVERY"
 * PostgreSQL remains the accounting source of truth.
 * This bridge mirrors الجرد + الحركات into the cleaned Google Sheet.
 */

var AMMAN_SPREADSHEET_ID = '1IY2uq7jRTEm2mblgkXBYg0A7mUbGroUjfW3UBz9gcxQ';

function setTigerMirrorKey(key){
  PropertiesService.getScriptProperties().setProperty('AMMAN_MIRROR_KEY', String(key||''));
}

function doPost(e){
  try{
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var key = String(body.key || '');
    var expected = PropertiesService.getScriptProperties().getProperty('AMMAN_MIRROR_KEY') || '';

    if(!expected || key !== expected) return out_({ok:false,error:'UNAUTHORIZED'});
    if(body.action !== 'sync_batch') return out_({ok:false,error:'BAD_ACTION'});

    var items = body.items || [];
    items.forEach(syncItem_);

    return out_({ok:true,count:items.length});
  }catch(err){
    return out_({ok:false,error:String(err && err.stack || err)});
  }
}

function syncItem_(item){
  var p = item.payload || {};
  var c = p.claim || null;
  var balances = p.balances || [];
  var ss = SpreadsheetApp.openById(AMMAN_SPREADSHEET_ID);

  var balancesSheet = ensureSheet_(ss,'الجرد',[
    'اسم الكابتن','رقم الهاتف','إنتاج','استهلاك','الصافي','آخر تحديث'
  ]);

  var movementsSheet = ensureSheet_(ss,'الحركات',[
    'الوقت','المنتج','رقم المنتج','المستهلك','رقم المستهلك',
    'الرياكشن','القيمة','الحالة','القروب','معرف الرسالة'
  ]);

  balances.forEach(function(b){
    upsert_(balancesSheet,2,String(b.captain_phone),[
      b.captain_name || b.captain_phone,
      b.captain_phone,
      Number(b.production || 0),
      Number(b.consumption || 0),
      Number(b.net || 0),
      b.updated_at || new Date()
    ]);
  });

  if(c){
    var movementKey = String(c.reply_message_id || c.original_message_id || c.id);
    upsert_(movementsSheet,10,movementKey,[
      c.updated_at || c.created_at || new Date(),
      c.producer_display_name || c.producer_phone,
      c.producer_phone,
      c.consumer_display_name || c.consumer_phone,
      c.consumer_phone,
      c.current_reaction || '',
      Number(c.current_value || 0),
      arabicStatus_(c.status),
      c.group_display_name || c.group_id,
      movementKey
    ]);
  }
}

function ensureSheet_(ss,name,headers){
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.setRightToLeft(true);
  sh.setFrozenRows(1);

  var current = sh.getRange(1,1,1,headers.length).getValues()[0];
  var needsHeader = false;
  for(var i=0;i<headers.length;i++){
    if(String(current[i] || '') !== headers[i]){ needsHeader = true; break; }
  }
  if(needsHeader){
    sh.getRange(1,1,1,headers.length).setValues([headers]);
  }
  return sh;
}

function upsert_(sh,keyCol,key,row){
  var lastRow = sh.getLastRow();
  var target = 0;

  if(lastRow >= 2){
    var found = sh.getRange(2,keyCol,lastRow-1,1)
      .createTextFinder(String(key))
      .matchEntireCell(true)
      .findNext();
    if(found) target = found.getRow();
  }

  if(!target) target = Math.max(lastRow + 1, 2);
  sh.getRange(target,1,1,row.length).setValues([row]);
}

function arabicStatus_(s){
  s = String(s || '');
  if(s === 'active') return 'محسوب';
  if(s === 'cancelled') return 'ملغي';
  if(s === 'waiting') return 'بانتظار الرياكشن';
  return s;
}

function out_(o){
  return ContentService
    .createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

