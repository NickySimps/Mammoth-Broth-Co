import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
const { fixture, base } = createRequire(import.meta.url)('./commerce-fixture.cjs');
const staffAdmin = { auth: { uid: 'staff', token: { admin: true } } };
async function backend() {
  const f = fixture();
  const result = await f.api.createPreorder({ ...base, paymentMethod: 'pickup' });
  const path = `orders/${result.orderId}`;
  return { ...f, id: result.orderId, path, read: () => ({ ...structuredClone(f.records.get(path)), id: result.orderId }) };
}

const test = vm.SourceTextModule ? nodeTest : () => {};
if (!vm.SourceTextModule) nodeTest('pickup admin UI isolated VM suite', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', env });
  assert.match(output, /# fail 0/); assert.match(output, /# skipped 0/);
});
const root = new URL('../', import.meta.url);
const tick = () => new Promise(setImmediate);
const defer = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const ID = 'a'.repeat(64);
const order = (extra = {}) => ({ id: ID, status: 'pending', paymentMethod: 'pickup', fulfillmentMethod: 'market_pickup', marketName: 'Fixture Market', pickupDate: '2026-11-07', totalAmount: 2500, currency: 'usd', items: [], ...extra });
async function ui({ read = async () => order(), call = async () => ({}), admin = true } = {}) {
  const nodes = new Map();
  const element = () => ({ hidden:false, disabled:false, checked:false, textContent:'', value:'', children:[], listeners:{}, append(...c){this.children.push(...c);}, replaceChildren(...c){this.children=c;this.textContent='';}, addEventListener(t,f){this.listeners[t]=f;}, focus(){this.focused=true;}, setAttribute(k,v){this[k]=v;} });
  const node = id => { if(!nodes.has(id)) nodes.set(id,element()); return nodes.get(id); };
  const auth = {currentUser:null}; let observer;
  const events={}; const location={hash:`#order=${ID}`}; const calls=[]; const reads=[];
  const context=vm.createContext({URL,URLSearchParams,Intl,crypto:webcrypto,location,document:{getElementById:node,createElement:element},window:{addEventListener(t,f){events[t]=f;}}});
  const deps={
    './store.js':{auth},
    './auth.js?v=3':{watchUser:f=>{observer=f;},isAdmin:async()=>admin,signInEmail:async()=>{},signInProvider:async()=>{},logout:async()=>{auth.currentUser=null;observer(null);}},
    './staff-store.mjs':{getStaffOrder:async(...args)=>{reads.push(args);return read(...args);}},
    'https://www.gstatic.com/firebasejs/9.6.1/firebase-functions.js':{getFunctions:()=>({fixture:true}),httpsCallable:(_f,name)=>{assert.equal(name,'recordMarketPickupAction');return async payload=>{calls.push(JSON.parse(JSON.stringify(payload)));return call(payload);};}}
  };
  async function link(spec){if(spec==='./order-lookup.mjs')return new vm.SourceTextModule(await readFile(new URL(spec,root),'utf8'),{context}); const d=deps[spec];assert.ok(d,`Unexpected dependency ${spec}`);return new vm.SyntheticModule(Object.keys(d),function(){for(const [k,v]of Object.entries(d))this.setExport(k,v);},{context});}
  const mod=new vm.SourceTextModule(await readFile(new URL('staff.mjs',root),'utf8'),{context,importModuleDynamically:async spec=>{const m=await link(spec);await m.link(link);await m.evaluate();return m;}});await mod.link(link);await mod.evaluate();
  return {node,calls,reads,auth, async change(user){auth.currentUser=user;observer(user);await tick();},async hash(hash){location.hash=hash;events.hashchange();await tick();},async click(id){await node(id).listeners.click?.();await tick();},text(){const collect=n=>[n.textContent,...n.children.map(collect)].join(' ');return collect(node('order-details'));}};
}
test('actual admin backend composes with UI for lost-response replay, sequential collection and exact readback', async()=>{
  for (const action of ['record_payment','record_payment_and_collection']) {
    const f=await backend(); let lost=true;
    const app=await ui({read:async()=>f.read(),call:async p=>{
      const outcome=await f.api.recordMarketPickupAction(p,staffAdmin);
      assert.equal(outcome.revision,p.expectedRevision+1);
      if(lost){lost=false;throw Error('lost committed response');}
      return {data:outcome};
    }});
    await app.hash(`#order=${f.id}`);await app.change({uid:'staff'});
    await app.click(action==='record_payment'?'record-payment':'record-payment-and-collection');
    await app.click('confirm-pickup-action');
    assert.match(app.node('pickup-action-status').textContent,/not verified/);
    assert.equal(f.read().pickupAdminRevision,1,'Backend must persist pickupAdminRevision, not generic revision');
    await app.click('retry-lookup');await app.click('retry-pickup-action');await app.click('confirm-pickup-action');
    assert.deepEqual(app.calls[0],app.calls[1]);
    assert.match(app.node('pickup-action-status').textContent,/Declaration verified/);
    assert.equal(f.read().pickupAdminRevision,1);
    assert.match(app.text(),/Payment declaration actor:.*staff/);
    assert.match(app.text(),new RegExp(app.calls[0].operationId));
    if(action==='record_payment'){
      await app.click('record-collection');await app.click('confirm-pickup-action');
      assert.equal(app.calls[2].expectedRevision,1);
      // The sequential action must also pass the real backend's payment audit lookup.
      assert.equal(f.read().fulfillmentStatus,'collected');
      assert.equal(f.read().pickupAdminRevision,2);
      assert.match(app.node('pickup-action-status').textContent,/Declaration verified/);
    }
    assert.equal(f.payments.length+f.sessions.length+f.mails.length,0);
    assert.equal([...f.records.keys()].filter(k=>k.startsWith('pickupActionAudits/')).length,action==='record_payment'?2:1);
  }
});

test('readback refuses incomplete or mismatched action evidence and preserves the retry payload',async()=>{
  for(const patch of [
    {paymentEvidence:{recordedAt:0}}, {paymentEvidence:{totalAmount:1}}, {paymentEvidence:{currency:'eur'}},
    {paidAt:0}, {paymentMethod:'stripe'}, {fulfillmentMethod:'local_delivery'},
    {collectionEvidence:{recordedAt:0}}, {collectedAt:0}, {collectionEvidence:{actorUid:'other'}},
    {pickupAdminRevision:0}, {pickupAdminRevision:null}, {reconciliationRequired:true}
  ]){
    let p;const app=await ui({call:async payload=>{p=payload;return {};},read:async()=>{
      if(!p)return order();
      const fresh=order({status:'paid',pickupAdminRevision:1,paidAt:123,fulfillmentStatus:'collected',collectedAt:123,
        paymentEvidence:{source:'operator_declaration',actorUid:'staff',operationId:p.operationId,recordedAt:123,totalAmount:2500,currency:'usd'},
        collectionEvidence:{actorUid:'staff',operationId:p.operationId,recordedAt:123}});
      for(const [k,v]of Object.entries(patch))fresh[k]=k.endsWith('Evidence')?{...fresh[k],...v}:v;
      return fresh;
    }});
    await app.change({uid:'staff'});await app.click('record-payment-and-collection');await app.click('confirm-pickup-action');
    assert.match(app.node('pickup-action-status').textContent,/not verified/,JSON.stringify(patch));
    assert.equal(app.node('retry-pickup-action').hidden,false);
  }
});

test('eligible exact pickup order exposes deliberate confirmation, never writes on scanning',async()=>{
  const app=await ui();await app.change({uid:'staff'});
  assert.equal(app.node('pickup-actions').hidden,false);
  assert.equal(app.calls.length,0);
  await app.click('record-payment');
  assert.equal(app.node('pickup-confirmation').hidden,false);
  assert.match(app.node('pickup-confirm-summary').textContent,/a{64}.*Fixture Market.*2026-11-07.*25\.00/s);
  assert.equal(app.calls.length,0);
  await app.click('cancel-pickup-action');assert.equal(app.node('pickup-confirmation').hidden,true);
});
test('confirmed declaration sends guarded payload once and requires exact server readback', async()=>{
  const response=defer();let count=0;let payload;
  const app=await ui({call:p=>{payload=p;return response.promise;},read:async()=>++count===1?order():order({status:'paid',paidAt:1,pickupAdminRevision:1,paymentEvidence:{source:'operator_declaration',recordedAt:1,totalAmount:2500,currency:'usd',operationId:payload.operationId,actorUid:'staff'}})});
  await app.change({uid:'staff'});await app.click('record-payment');
  const pending=app.click('confirm-pickup-action');await tick();
  assert.equal(app.calls.length,1);
  assert.equal(app.node('confirm-pickup-action').disabled,true);
  await app.click('confirm-pickup-action');assert.equal(app.calls.length,1);
  assert.deepEqual(Object.keys(app.calls[0]).sort(),['action','expectedCurrency','expectedRevision','expectedTotalAmount','operationId','orderId'].sort());
  assert.equal(app.calls[0].expectedRevision,0);assert.equal(app.calls[0].expectedTotalAmount,2500);
  assert.doesNotMatch(app.node('pickup-action-status').textContent,/verified/i);
  response.resolve({data:{success:true}});await pending;
  assert.equal(app.reads.length,2);assert.equal(app.reads[1][0],ID);
  assert.match(app.node('pickup-action-status').textContent,/verified/i);
  assert.match(app.text(),/Payment recorded at pickup by an authorized operator/);
});

test('uncertain retry keeps the exact original payload even after a fresh lookup',async()=>{
  let attempts=0;let sent;
  const app=await ui({call:async p=>{sent=p;if(++attempts===1)throw Error('lost response');return {};},read:async()=>attempts?order({status:'paid',paidAt:1,pickupAdminRevision:1,paymentEvidence:{source:'operator_declaration',recordedAt:1,totalAmount:2500,currency:'usd',actorUid:'staff',operationId:sent.operationId}}):order()});
  const staff={uid:'staff'};await app.change(staff);await app.click('record-payment');await app.click('confirm-pickup-action');
  assert.match(app.node('pickup-action-status').textContent,/not verified/);
  assert.equal(app.node('record-payment').hidden,true);
  await app.click('retry-lookup');await tick();
  await app.click('retry-pickup-action');await app.click('confirm-pickup-action');
  assert.equal(app.calls.length,2);assert.deepEqual(app.calls[0],app.calls[1]);
  assert.match(app.node('pickup-action-status').textContent,/Declaration verified/);
});

test('successful callable without matching readback is never declared verified',async()=>{
  for(const fresh of [order(),null,order({id:'other'}),order({status:'paid',pickupAdminRevision:1,paymentEvidence:{source:'operator_declaration',actorUid:'staff',operationId:'wrong'}})]){
    let reads=0;const app=await ui({read:async()=>++reads===1?order():fresh});
    await app.change({uid:'staff'});await app.click('record-payment');await app.click('confirm-pickup-action');
    assert.match(app.node('pickup-action-status').textContent,/not verified/);
    assert.equal(app.node('retry-pickup-action').hidden,false);
  }
});

test('late verification read cannot repopulate a signed-out or changed exact-order view',async()=>{
  for(const mode of ['signout','order']){
    const response=defer();let count=0;const app=await ui({read:async()=>++count===1?order():response.promise});
    await app.change({uid:'staff'});await app.click('record-payment');const pending=app.click('confirm-pickup-action');await tick();
    assert.equal(app.reads.length,2);
    if(mode==='signout')await app.change(null);else await app.hash('#order=other');
    response.resolve(order({status:'paid',pickupAdminRevision:1,customerName:'Late private response'}));await pending;
    assert.doesNotMatch(app.text(),/Late private/);assert.doesNotMatch(app.node('pickup-action-status').textContent,/Declaration verified/);
  }
});

test('auth or exact-order changes fence late mutation responses and disable signed-out actions',async()=>{
  for(const mode of ['signout','switch','same-uid','order']){
    const response=defer();const app=await ui({call:()=>response.promise});const staff={uid:'staff'};
    await app.change(staff);await app.click('record-payment');const pending=app.click('confirm-pickup-action');await tick();
    if(mode==='order')await app.hash('#order=another-order');else await app.change(mode==='signout'?null:{uid:mode==='same-uid'?'staff':'other'});
    const reads=app.reads.length;response.resolve({data:{success:true}});await pending;
    assert.equal(app.reads.length,reads);assert.doesNotMatch(app.node('pickup-action-status').textContent,/Declaration verified/);
    if(mode==='signout'){assert.equal(app.node('confirm-pickup-action').disabled,true);assert.equal(app.node('pickup-confirmation').hidden,true);}
  }
});

test('ineligible orders never offer new declarations or submit through handlers',async()=>{
  const invalid=[{id:'legacy-order'},{status:'cancelled'},{status:'refunded'},{status:'paid_requires_review'},{status:'payment_processing'},{status:'completed'},{fulfillmentStatus:'collected'},{fulfillmentStatus:'unknown'},{fulfillmentMethod:'local_delivery'},{paymentMethod:'special_order'},{currency:'eur'},{totalAmount:undefined},{pickupAdminRevision:-1},{pickupAdminRevision:null},{pickupAdminRevision:Number.MAX_SAFE_INTEGER},{paymentMethod:'stripe',status:'paid'},{status:'paid'},{reconciliationRequired:true},{paymentIntentId:'pi_started'},{checkoutUrl:'provider-setup'},{paidAt:1234},{paidAt:0},{paymentEvidence:false},{collectedAt:0},{collectionEvidence:false},{paymentLease:'orphan'},{checkoutLease:'orphan'},{paymentLeaseUntil:'expired'},{collectionEvidence:{}},{reviewReason:'hold'}];
  for(const extra of invalid){
    const app=await ui({read:async()=>order(extra)});await app.change({uid:'staff'});
    assert.equal(app.node('pickup-actions').hidden,true,JSON.stringify(extra));
    await app.click('record-payment');await app.click('record-collection');await app.click('confirm-pickup-action');assert.equal(app.calls.length,0);
  }
});

test('verified online paid pickup offers collection only and never manual payment',async()=>{
  const app=await ui({read:async()=>order({paymentMethod:'stripe',status:'paid',paidAt:1,paymentIntentId:'pi_fixture',paymentEvidence:{source:'stripe',recordedAt:1,totalAmount:2500,currency:'usd',paymentIntentId:'pi_fixture',eventId:'evt_fixture'}})});
  await app.change({uid:'staff'});assert.equal(app.node('record-collection').hidden,false);
  assert.equal(app.node('record-payment').hidden,true);assert.equal(app.node('record-payment-and-collection').hidden,true);
  assert.match(app.text(),/verified online by Stripe/);
});

test('collection requires complete matching prior payment evidence and preserves payment source',async()=>{
  for(const method of ['pickup','stripe']){
    const evidence=method==='stripe'?{source:'stripe',paymentIntentId:'pi_fixture',eventId:'evt_fixture'}:{source:'operator_declaration',actorUid:'prior-staff',operationId:'00000000-0000-4000-8000-000000000000'};
    const base=order({paymentMethod:method,status:'paid',paidAt:1,pickupAdminRevision:4,...(method==='stripe'?{paymentIntentId:'pi_fixture'}:{}),paymentEvidence:{...evidence,recordedAt:1,totalAmount:2500,currency:'usd'}});
    for(const invalid of [{paidAt:null},{paymentEvidence:{...base.paymentEvidence,recordedAt:0}},{paymentEvidence:{...base.paymentEvidence,totalAmount:1}},{paymentEvidence:{...base.paymentEvidence,currency:'eur'}}]){
      const app=await ui({read:async()=>({...base,...invalid})});await app.change({uid:'staff'});assert.equal(app.node('pickup-actions').hidden,true,JSON.stringify(invalid));
    }
    let p;const app=await ui({call:async payload=>{p=payload;return {};},read:async()=>p?{...base,pickupAdminRevision:5,fulfillmentStatus:'collected',collectedAt:2,collectionEvidence:{actorUid:'staff',operationId:p.operationId,recordedAt:2}}:base});
    await app.change({uid:'staff'});await app.click('record-collection');await app.click('confirm-pickup-action');
    assert.equal(app.calls[0].action,'record_collection');assert.equal(app.calls[0].expectedRevision,4);assert.match(app.node('pickup-action-status').textContent,/Declaration verified/);
    assert.match(app.text(),method==='stripe'?/verified online by Stripe/:/Payment recorded at pickup by an authorized operator/);
  }
});

// Opt-in real-browser lab; all remote modules and transport are synthetic and
// every unrecognized request is aborted. No live project or provider calls.
if (process.env.PICKUP_BROWSER_TEST === '1' || process.env.PICKUP_ADMIN_PLAYWRIGHT) test('offline Edge: actual backend retry/readback, keyboard/mobile confirmation and stale-session fencing', async()=>{
  const { chromium } = createRequire(import.meta.url)(process.env.PICKUP_ADMIN_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ headless:true, channel:process.env.PICKUP_ADMIN_BROWSER_CHANNEL || 'msedge' });
  const files = Object.fromEntries(await Promise.all(['staff.html','staff.css','staff.mjs','order-lookup.mjs'].map(async f=>[f,await readFile(new URL(f,root),'utf8')])));
  const requested=[];const unexpected=[];const errors=[];
  const origin='http://localhost:41789';
  const synthetic = {
    '/store.js': 'export const auth=window.fixture.auth;',
    '/auth.js?v=3': `export const watchUser=f=>{window.fixture.observer=f;f(window.fixture.auth.currentUser);}; export const isAdmin=async()=>true; export const signInEmail=async()=>{};export const signInProvider=async()=>{}; export const logout=async()=>{window.fixture.auth.currentUser=null;window.fixture.observer(null);};`,
    '/staff-store.mjs': `export async function getStaffOrder(id,user){window.fixture.reads.push(id);return window.backendRead(id,user.uid);}`,
    'https://www.gstatic.com/firebasejs/9.6.1/firebase-functions.js': `export const getFunctions=()=>({synthetic:true}); export const httpsCallable=(_f,name)=>{if(name!=='recordMarketPickupAction')throw Error('Unexpected callable');return async p=>{const f=window.fixture;f.calls.push(structuredClone(p));if(f.hold)await new Promise(resolve=>{f.release=resolve;});const outcome=await window.backendCall(p);if(f.failOnce){f.failOnce=false;throw Error('Synthetic lost response after actual backend commit');}return {data:outcome};};};`
  };
  async function setup(viewport,javaScriptEnabled=true){
    const f=await backend();
    const context=await browser.newContext({viewport,javaScriptEnabled,serviceWorkers:'block'});
    await context.exposeBinding('backendRead',async(_source,id,uid)=>{assert.equal(id,f.id);assert.equal(uid,'staff');return f.read();});
    await context.exposeBinding('backendCall',async(_source,p)=>f.api.recordMarketPickupAction(p,staffAdmin));
    await context.addInitScript(()=>{window.fixture={auth:{currentUser:{uid:'staff'}},calls:[],reads:[],failOnce:false,hold:false};});
    await context.route('**/*',async route=>{
      const url=route.request().url();requested.push(url);const parsed=new URL(url);const key=parsed.pathname+parsed.search;
      if(url in synthetic)return route.fulfill({contentType:'text/javascript',body:synthetic[url]});
      if(parsed.origin===origin){if(key in synthetic)return route.fulfill({contentType:'text/javascript',body:synthetic[key]});const file=parsed.pathname.slice(1);if(file in files)return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript',body:files[file]});if(file==='assets/logo.png')return route.fulfill({status:204,body:''});}
      unexpected.push(url);await route.abort();
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(`${origin}/staff.html#order=${f.id}`);
    return {context,page,f};
  }
  try{
    for(const width of [320,390,1280]){
      const {context,page,f}=await setup({width,height:800});
      await page.locator('#record-payment').waitFor({state:'visible'});
      assert.equal(await page.evaluate(()=>window.fixture.calls.length),0);
      await page.locator('#record-payment').focus();await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(()=>document.activeElement.id),'confirm-pickup-action');
      assert.match(await page.locator('#pickup-confirm-summary').innerText(),/Atlantic.*2026-10-25.*25\.00/);
      const geometry=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll('#pickup-actions button')].filter(b=>b.getClientRects().length).map(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height};})}));
      assert.ok(geometry.width<=geometry.viewport,JSON.stringify(geometry));for(const r of geometry.buttons){assert.ok(r.left>=0&&r.right<=width&&r.height>=44,JSON.stringify(r));}
      await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'cancel-pickup-action');await page.keyboard.press('Enter');
      assert.equal(await page.locator('#pickup-confirmation').isHidden(),true);assert.equal(await page.evaluate(()=>window.fixture.calls.length),0);
      await page.evaluate(()=>{window.fixture.failOnce=true;});await page.locator('#record-payment-and-collection').click();await page.locator('#confirm-pickup-action').click();
      await page.waitForFunction(()=>document.getElementById('pickup-action-status').textContent.includes('not verified'));
      assert.equal(f.read().pickupAdminRevision,1,'Backend must persist pickupAdminRevision, not generic revision');
      await page.locator('#retry-pickup-action').click();await page.locator('#confirm-pickup-action').click();
      await page.waitForFunction(()=>document.getElementById('pickup-action-status').textContent.startsWith('Declaration verified'));
      const result=await page.evaluate(()=>({calls:window.fixture.calls,reads:window.fixture.reads,text:document.getElementById('order-details').textContent}));assert.equal(result.calls.length,2);assert.deepEqual(result.calls[0],result.calls[1]);assert.deepEqual(result.reads,[f.id,f.id]);assert.match(result.text,/Payment recorded at pickup by an authorized operator/);assert.match(result.text,/collected/);assert.match(result.text,/not independent bank or card-payment verification/);assert.match(result.text,new RegExp(result.calls[0].operationId));
      assert.equal(f.read().pickupAdminRevision,1);assert.equal([...f.records.keys()].filter(k=>k.startsWith('pickupActionAudits/')).length,1);assert.equal(f.payments.length+f.sessions.length+f.mails.length,0);
      await context.close();
    }
    const {context,page}=await setup({width:390,height:844});await page.locator('#record-payment').waitFor({state:'visible'});
    await page.evaluate(()=>{window.fixture.hold=true;});await page.locator('#record-payment').click();await page.locator('#confirm-pickup-action').click();
    await page.waitForFunction(()=>window.fixture.calls.length===1);assert.equal(await page.locator('#confirm-pickup-action').isDisabled(),true);
    await page.locator('#staff-signout').click();await page.evaluate(()=>window.fixture.release());
    await page.waitForFunction(()=>document.getElementById('order-card').hidden);assert.equal(await page.locator('#pickup-actions').isHidden(),true);assert.equal(await page.locator('#order-details').innerText(),'');assert.equal(await page.evaluate(()=>window.fixture.reads.length),1);await context.close();
    const nojs=await setup({width:320,height:700},false);assert.equal(await nojs.page.locator('#pickup-actions').isHidden(),true);assert.equal(await nojs.page.locator('#confirm-pickup-action').isDisabled(),true);await nojs.context.close();
    assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);assert.ok(requested.length>0);
  }finally{await browser.close();}
});
