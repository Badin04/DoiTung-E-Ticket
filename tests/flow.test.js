'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const { createApp, todayBangkok } = require('../server');
const { matrix } = require('../src/qr');

test('QR generator outputs valid-size matrix',()=>{
  const m=matrix('DT0123456789ABCDEF01234567');
  assert.equal(m.length,29);assert.equal(m[0].length,29);
  assert.equal(m[0][0],true);assert.equal(m[6][6],true);
});

test('complete booking, mock payment, login, check-in, replay denial and admin update', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'doitung-test-'));
  const app=createApp({dbPath:path.join(dir,'test.sqlite'),adminPassword:'UnitTestAdminPassword123!',staffPassword:'UnitTestStaffPassword123!',production:false,demoPayment:true});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  async function req(url,options={}) {
    const result=await fetch(origin+url,{redirect:'manual',...options});
    const text=await result.text();
    let data;try{data=JSON.parse(text);}catch{data=text;}
    return {status:result.status,data,headers:result.headers};
  }
  const post=(url,payload,opts={})=>req(url,{method:'POST',headers:{'Content-Type':'application/json',...(opts.headers||{})},body:JSON.stringify(payload)});
  try{
    const home=await req('/');assert.equal(home.status,200);assert.ok(home.data.includes('จองบัตรเข้าชม'));
    assert.ok(!home.data.includes('demo-stripe'), 'top green strip must be removed');
    assert.ok(home.data.includes('วิธีจองบัตร'), 'realistic booking steps should be shown');
    assert.ok(!home.data.includes('SMART BOOKING'), 'developer marketing labels should be removed');
    assert.ok(!home.data.includes('ESP32/LCD'), 'customer-facing home must not mention staff hardware');
    const stylesheet=await req('/assets/styles.css');assert.equal(stylesheet.status,200);
    assert.ok(stylesheet.data.includes('font-size:clamp(15px,1.2vw,17px)'), 'navigation must be enlarged');
    const unauthorized=await post('/api/scan',{token:'DT'+'0'.repeat(24)});assert.equal(unauthorized.status,401);
    const invalid=await post('/api/orders',{customerName:'Test User',visitDate:'1999-01-01',ticketTypeId:'garden',quantity:1});assert.equal(invalid.status,400);
    const order=await post('/api/orders',{customerName:'Test User',customerEmail:'test@example.com',visitDate:todayBangkok(),ticketTypeId:'combo',quantity:2});
    assert.equal(order.status,201);assert.match(order.data.orderId,/^DT-[A-F0-9]{24}$/);
    let receipt=await req(order.data.checkoutUrl);assert.ok(receipt.data.includes('รอชำระเงินจำลอง'));
    const paid=await post(`/api/orders/${order.data.orderId}/simulate-pay`,{});assert.equal(paid.status,200);
    const paidAgain=await post(`/api/orders/${order.data.orderId}/simulate-pay`,{});assert.equal(paidAgain.status,200);
    const page=await req(paid.data.ticketUrl);assert.equal(page.status,200);assert.ok(page.data.includes('<svg'));
    const tokens=[...page.data.matchAll(/Token: <code>(DT[A-F0-9]{24})<\/code>/g)].map(x=>x[1]);
    assert.equal(tokens.length,2);assert.notEqual(tokens[0],tokens[1]);
    const svg=await req('/qr/'+tokens[0]+'.svg');assert.equal(svg.status,200);assert.ok(svg.data.includes('<svg'));
    const login=await post('/api/login',{username:'staff',password:'UnitTestStaffPassword123!'});
    assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
    const staff=await req('/staff',{headers:{cookie}});assert.equal(staff.status,200);
    const csrf=staff.data.match(/data-csrf="([a-f0-9]{64})"/)[1];
    const scanHeaders={'Cookie':cookie,'X-CSRF-Token':csrf};
    const check=await post('/api/scan',{token:tokens[0]},{headers:scanHeaders});assert.equal(check.status,200);assert.equal(check.data.status,'valid');
    const again=await post('/api/scan',{token:tokens[0]},{headers:scanHeaders});assert.equal(again.status,409);assert.equal(again.data.status,'used');
    const other=await post('/api/scan',{token:tokens[1]},{headers:scanHeaders});assert.equal(other.status,200);
    const bad=await post('/api/scan',{token:'DT'+'1'.repeat(24)},{headers:scanHeaders});assert.equal(bad.status,404);
    const adminLogin=await post('/api/login',{username:'admin',password:'UnitTestAdminPassword123!'});assert.equal(adminLogin.status,200);
    const adminCookie=adminLogin.headers.get('set-cookie').split(';')[0];
    const admin=await req('/admin',{headers:{Cookie:adminCookie}});assert.equal(admin.status,200);assert.ok(admin.data.includes('ภาพรวมการขายบัตร'));
    const adminCsrf=admin.data.match(/data-csrf="([a-f0-9]{64})"/)[1];
    const price=await post('/api/admin/types/garden',{price:175,active:true},{headers:{Cookie:adminCookie,'X-CSRF-Token':adminCsrf}});assert.equal(price.status,200);
    const newOrder=await post('/api/orders',{customerName:'Another Guest',visitDate:todayBangkok(),ticketTypeId:'garden',quantity:2});assert.equal(newOrder.status,201);
    const totals=app.db.prepare('SELECT total FROM orders WHERE id=?').get(newOrder.data.orderId);assert.equal(totals.total,350);
    const logout=await post('/api/logout',{},{headers:{Cookie:adminCookie,'X-CSRF-Token':adminCsrf}});assert.equal(logout.status,200);
    const afterLogout=await req('/admin',{headers:{Cookie:adminCookie}});assert.equal(afterLogout.status,302);
  } finally {await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});
