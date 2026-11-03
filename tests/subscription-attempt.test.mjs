import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { createSubscriptionAttempt } from '../subscription-attempt.mjs';

function storage() { const m = new Map(); return { getItem:k=>m.get(k)??null, setItem:(k,v)=>m.set(k,String(v)), removeItem:k=>m.delete(k), entries:()=>[...m] }; }
const input = { cart:{prod_beef:5,mushroom:1}, cadence:'weekly', deliveryAddress:{street:'1 Test St',city:'Jacksonville',state:'FL',zip:'32204'}, customerName:'Test',customerEmail:'test@example.invalid' };
const response = { subscriptionOrderId:'ds_'+ 'a'.repeat(64), checkoutSessionId:'cs_test_123', checkoutUrl:'https://checkout.stripe.com/c/pay/cs_test_123', expiresAt:Date.now()+60000, amountPerDelivery:14000, currency:'usd' };
const valid = p => ({ ...response, subscriptionOrderId:'ds_'+createHash('sha256').update(p.requestId).digest('hex') });
test('persists independent random capability before network and recovers unchanged after reload', async () => {
  const session=storage(); let first;
  const a=createSubscriptionAttempt({storage:session,crypto:webcrypto,uid:'tester'});
  await assert.rejects(a.prepare(input, async payload => { assert.ok(session.entries().length); first=structuredClone(payload); throw Error('offline'); }));
  const b=createSubscriptionAttempt({storage:session,crypto:webcrypto,uid:'tester'});
  const result=await b.prepare(input,async payload=>{assert.deepEqual(payload,first);return valid(payload);});
  assert.match(first.capability,/^[a-f0-9]{64}$/); assert.notEqual(first.capability,first.requestId); assert.equal(result.checkoutUrl,response.checkoutUrl);
});
test('changed cart or identity cannot reuse an existing capability', async () => {
  const s=storage(); const a=createSubscriptionAttempt({storage:s,crypto:webcrypto,uid:'one'}); let first;
  await a.prepare(input, async p=>{first=p;return valid(p)});
  const b=createSubscriptionAttempt({storage:s,crypto:webcrypto,uid:'two'}); let second;
  await b.prepare({...input,cart:{prod_chicken:6}}, async p=>{second=p;return valid(p)});
  assert.notEqual(first.capability,second.capability); assert.notEqual(first.requestId,second.requestId);
});
test('rejects untrusted checkout URLs and fails closed if storage fails', async () => {
  const a=createSubscriptionAttempt({storage:storage(),crypto:webcrypto,uid:null});
  await assert.rejects(a.prepare(input,async()=>({...response,checkoutUrl:'https://checkout.stripe.com.attacker.invalid/x'})));
  let called=false; const b=createSubscriptionAttempt({storage:{getItem(){return null},setItem(){throw Error('storage')},removeItem(){}},crypto:webcrypto,uid:null});
  await assert.rejects(b.prepare(input,async()=>{called=true;return response})); assert.equal(called,false);
});
test('rejects an order reference that does not match the retained request', async () => {
  const a=createSubscriptionAttempt({storage:storage(),crypto:webcrypto,uid:'tester'});
  await assert.rejects(a.prepare(input,async()=>response));
});
test('older async completion cannot return a URL after new checkout revision', async () => {
  const s=storage();const a=createSubscriptionAttempt({storage:s,crypto:webcrypto,uid:'tester'});let release;const old=a.prepare(input,()=>new Promise(r=>{release=r}));
  await a.prepare({...input,cadence:'monthly'},async p=>valid(p)); release(response); await assert.rejects(old);
});
