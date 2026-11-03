'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { URL } = require('node:url');
const { initDb, verifyPassword, transaction } = require('./src/db');
const pages = require('./src/pages');
const { svg: qrSvg } = require('./src/qr');
const { bangkokParts, ticketQrText, parseTicketQr, matchesTicketRecord } = require('./src/ticket-qr-data');

const ASSETS = {
  '/assets/styles.css': ['public/styles.css','text/css; charset=utf-8'],
  '/assets/app.js': ['public/app.js','text/javascript; charset=utf-8'],
  '/assets/hero.svg': ['public/hero.svg','image/svg+xml'],
  '/assets/place-villa.svg': ['public/assets/place-villa.svg','image/svg+xml'],
  '/assets/place-garden.svg': ['public/assets/place-garden.svg','image/svg+xml'],
  '/assets/place-hall.svg': ['public/assets/place-hall.svg','image/svg+xml'],
  '/assets/place-arboretum.svg': ['public/assets/place-arboretum.svg','image/svg+xml'],
};
const TTL = 12 * 60 * 60 * 1000;
const stamp = () => new Date().toISOString();
const todayBangkok = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const token = length => randomBytes(length).toString('hex').toUpperCase();

function createApp(options={}) {
  const isProd = options.production ?? process.env.NODE_ENV === 'production';
  const demoPayment = options.demoPayment ?? (
  !isProd
    ? process.env.ENABLE_DEMO_PAYMENT !== 'false'
    : process.env.ENABLE_DEMO_PAYMENT === 'true' &&
      process.env.ALLOW_DEMO_PAYMENT_IN_PRODUCTION === 'true'
);
  const adminPass = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? (isProd ? '' : 'Admin@12345');
  const staffPass = options.staffPassword ?? process.env.STAFF_PASSWORD ?? (isProd ? '' : 'Staff@12345');
  if (!adminPass || !staffPass || (isProd && (adminPass.length < 12 || staffPass.length < 12)))
    throw new Error('Production requires strong ADMIN_PASSWORD and STAFF_PASSWORD environment variables (12+ chars).');
  const dbPath = options.dbPath || process.env.DB_PATH || path.join(__dirname,'data','doitung.sqlite');
  const db = initDb(path.resolve(dbPath), {admin:adminPass,staff:staffPass});
  const sessions = new Map();
  const rateBuckets = new Map();
  const json = (res,code,body) => send(res,code,JSON.stringify(body),'application/json; charset=utf-8');
  const html = (res,code,body) => send(res,code,body,'text/html; charset=utf-8');
  function send(res,code,body,contentType) {
    res.writeHead(code,{'Content-Type':contentType,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"});
    res.end(body);
  }
  function getSession(req) {
    const cookies = Object.fromEntries((req.headers.cookie||'').split(';').map(x => x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));
    const id = cookies.doitung_session;
    if (!id) return null;
    const item = sessions.get(id);
    if (!item) return null;
    if (item.expires < Date.now()) { sessions.delete(id); return null; }
    return {id,...item};
  }
  function cookie(res,id,clear=false) {
    const secure = isProd ? '; Secure' : '';
    res.setHeader('Set-Cookie',`doitung_session=${clear?'':id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${clear?0:Math.floor(TTL/1000)}${secure}`);
  }
  function limited(key,max,windowMs) {
    const now=Date.now(); const found=rateBuckets.get(key);
    if (!found || now>found.reset) {rateBuckets.set(key,{count:1,reset:now+windowMs});return false;}
    found.count++; return found.count > max;
  }
  async function body(req) {
    let total=0;const chunks=[];
    for await (const chunk of req) {
      total+=chunk.length;
      if (total > 32768) {const e=new Error('ข้อมูลเกินขนาดที่อนุญาต');e.status=413;throw e;}
      chunks.push(chunk);
    }
    const raw=Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    if ((req.headers['content-type']||'').includes('application/json')) {
      try {return JSON.parse(raw);} catch {const e=new Error('รูปแบบ JSON ไม่ถูกต้อง'); e.status=400; throw e;}
    }
    return Object.fromEntries(new URLSearchParams(raw));
  }
  function checkCsrf(req,sess,form) {
    if (!sess || (req.headers['x-csrf-token']!==sess.csrf && form?.csrf!==sess.csrf)) {
      const e=new Error('โทเคนยืนยันไม่ถูกต้อง กรุณาโหลดหน้าใหม่');e.status=403;throw e;
    }
  }
  function auth(req,res,session,roles,api=false) {
    if (session && roles.includes(session.role)) return true;
    if (api) json(res,401,{error:'กรุณาเข้าสู่ระบบเจ้าหน้าที่'});
    else { res.writeHead(302,{Location:'/login?next='+encodeURIComponent(new URL(req.url,'http://local').pathname),'Cache-Control':'no-store'});res.end(); }
    return false;
  }
  function getOrder(id) {return db.prepare('SELECT * FROM orders WHERE id=?').get(id);}
  const server = http.createServer(async (req,res)=>{
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const session = getSession(req);const user = session?{username:session.username,role:session.role,csrf:session.csrf}:null;
    try {
      if (req.method==='GET' && ASSETS[pathname]) {
        const [filename,type] = ASSETS[pathname];return send(res,200,fs.readFileSync(path.join(__dirname,filename)),type);
      }
      if (req.method==='GET' && pathname==='/favicon.ico') {res.writeHead(204);return res.end();}
      if (req.method==='GET' && pathname==='/health') return json(res,200,{ok:true,mode:'demo',paymentEnabled:demoPayment});
      if (req.method==='GET' && pathname==='/') {
        const types = db.prepare('SELECT * FROM ticket_types ORDER BY sort_order').all();
        return html(res,200,pages.home(types,todayBangkok(),user));
      }
      if (req.method==='GET' && pathname==='/lookup')return html(res,200,pages.lookup(user));
      if (req.method==='GET' && pathname==='/login') {
        const next=new URL(req.url,'http://localhost').searchParams.get('next')||'';
        return html(res,200,pages.login(next,user));
      }
      const checkout=pathname.match(/^\/checkout\/(DT-[A-F0-9]{24})$/);
      if (req.method==='GET' && checkout) {
        const order = getOrder(checkout[1]);
        if (!order) return html(res,404,pages.errorPage(404,'ไม่พบคำสั่งซื้อ','ตรวจสอบหมายเลขคำสั่งซื้ออีกครั้ง',user));
        const items=db.prepare('SELECT i.*,t.name FROM order_items i JOIN ticket_types t ON t.id=i.ticket_type_id WHERE i.order_id=?').all(order.id);
        return html(res,200,pages.checkout(order,items,demoPayment,user));
      }
      const ticketPage=pathname.match(/^\/tickets\/(DT-[A-F0-9]{24})$/);
      if (req.method==='GET' && ticketPage) {
        const order=getOrder(ticketPage[1]);
        if (!order) return html(res,404,pages.errorPage(404,'ไม่พบคำสั่งซื้อ','ตรวจสอบหมายเลขคำสั่งซื้ออีกครั้ง',user));
        if (order.status==='pending') {res.writeHead(303,{Location:'/checkout/'+order.id});return res.end();}
        const tickets=db.prepare('SELECT t.*, tt.name FROM tickets t JOIN ticket_types tt ON tt.id=t.ticket_type_id WHERE t.order_id=? ORDER BY t.id').all(order.id);
        return html(res,200,pages.tickets(order,tickets,user));
      }
      const qr=pathname.match(/^\/qr\/(DT[A-F0-9]{24})\.svg$/);
      if (req.method==='GET' && qr) {
        const found=db.prepare('SELECT t.qr_token,t.visit_date,o.paid_at FROM tickets t JOIN orders o ON o.id=t.order_id WHERE t.qr_token=?').get(qr[1]);
        if (!found) return html(res,404,pages.errorPage(404,'ไม่พบ QR','ไม่พบรหัสบัตรดังกล่าว',user));
        return send(res,200,qrSvg(ticketQrText(found.qr_token,found.paid_at,found.visit_date),400),'image/svg+xml');
      }
      if (req.method==='GET' && pathname==='/staff') {
        if (!auth(req,res,session,['admin','staff'])) return;
        return html(res,200,pages.staff(user,session.csrf));
      }
      if (req.method==='GET' && pathname==='/admin') {
        if (!auth(req,res,session,['admin']))return;
        const ok=new URL(req.url,'http://localhost').searchParams.has('saved');
        return html(res,200,pages.admin(db,user,session.csrf,ok));
      }
      if (req.method==='POST' && pathname==='/api/login') {
        if (limited('login:'+req.socket.remoteAddress,15,15*60*1000))return json(res,429,{error:'ลองเข้าสู่ระบบมากเกินไป กรุณารอสักครู่'});
        const payload=await body(req);
        const username=String(payload.username||'').trim().slice(0,100);
        const pass=String(payload.password||'');
        const account=db.prepare('SELECT * FROM users WHERE username=?').get(username);
        if (!account || !verifyPassword(pass,account.password_hash))return json(res,401,{error:'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'});
        if (session) sessions.delete(session.id);
        const id=randomBytes(32).toString('hex');
        sessions.set(id,{username:account.username,role:account.role,csrf:randomBytes(32).toString('hex'),expires:Date.now()+TTL});
        cookie(res,id);
        return json(res,200,{ok:true,role:account.role,redirect:account.role==='admin'?'/admin':'/staff'});
      }
      if (req.method==='POST' && pathname==='/api/logout') {
        if (!auth(req,res,session,['admin','staff'],true)) return;
        checkCsrf(req,session);
        sessions.delete(session.id);cookie(res,'',true);return json(res,200,{ok:true});
      }
      if (req.method==='POST' && pathname==='/api/orders') {
        if (limited('order:'+req.socket.remoteAddress,35,15*60*1000))return json(res,429,{error:'สร้างคำสั่งซื้อบ่อยเกินไป กรุณาลองใหม่'});
        const payload=await body(req);
        const customerName=String(payload.customerName||'').trim();
        const email=String(payload.customerEmail||'').trim();
        const visitDate=String(payload.visitDate||'');
        const quantity=Number(payload.quantity);
        const ticketTypeId=String(payload.ticketTypeId||'');
        const tomorrowLimit=new Date(Date.now()+366*86400000).toISOString().slice(0,10);
        const validDate = /^\d{4}-\d{2}-\d{2}$/.test(visitDate) && !Number.isNaN(Date.parse(visitDate+'T12:00:00Z')) && new Date(visitDate+'T12:00:00Z').toISOString().startsWith(visitDate);
        if (customerName.length<2 || customerName.length>80) return json(res,400,{error:'กรุณากรอกชื่อผู้จอง 2–80 ตัวอักษร'});
        if (email.length>120 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))return json(res,400,{error:'รูปแบบอีเมลไม่ถูกต้อง'});
        if (!validDate || visitDate<todayBangkok() || visitDate>tomorrowLimit) return json(res,400,{error:'กรุณาเลือกวันที่เข้าชมภายใน 1 ปีข้างหน้า'});
        if (!Number.isInteger(quantity)||quantity<1||quantity>10)return json(res,400,{error:'จำนวนบัตรต้องเป็น 1–10 ใบ'});
        const type=db.prepare('SELECT * FROM ticket_types WHERE id=? AND active=1').get(ticketTypeId);
        if (!type)return json(res,400,{error:'ไม่มีประเภทบัตรนี้หรือปิดขายแล้ว'});
        const orderId='DT-'+token(12);
        transaction(db,()=>{
          db.prepare('INSERT INTO orders(id,customer_name,customer_email,visit_date,status,total,created_at) VALUES (?,?,?,?,?,?,?)').run(orderId,customerName,email,visitDate,'pending',type.price*quantity,stamp());
          db.prepare('INSERT INTO order_items(order_id,ticket_type_id,quantity,unit_price) VALUES (?,?,?,?)').run(orderId,type.id,quantity,type.price);
        });
        return json(res,201,{ok:true,orderId,checkoutUrl:'/checkout/'+orderId});
      }
      const payApi=pathname.match(/^\/api\/orders\/(DT-[A-F0-9]{24})\/simulate-pay$/);
      if (req.method==='POST' && payApi) {
        if (!demoPayment)return json(res,403,{error:'ฟังก์ชันชำระเงินจำลองถูกปิด'});
        if (limited('pay:'+req.socket.remoteAddress,50,15*60*1000)) return json(res,429,{error:'ส่งคำขอบ่อยเกินไป'});
        const id=payApi[1];const order=getOrder(id);
        if (!order)return json(res,404,{error:'ไม่พบคำสั่งซื้อ'});
        transaction(db,()=>{
          const current=getOrder(id);
          if (current.status==='paid')return;
          const items=db.prepare('SELECT * FROM order_items WHERE order_id=?').all(id);
          const insert=db.prepare('INSERT INTO tickets(id,order_id,ticket_type_id,qr_token,visit_date,status) VALUES (?,?,?,?,?,?)');
          for (const item of items)for(let i=0;i<item.quantity;i++)
            insert.run('T-'+token(6),id,item.ticket_type_id,'DT'+token(12),order.visit_date,'active');
          db.prepare(`UPDATE orders SET status='paid',paid_at=? WHERE id=? AND status='pending'`).run(stamp(),id);
        });
        return json(res,200,{ok:true,ticketUrl:'/tickets/'+id});
      }
      if (req.method==='POST' && pathname==='/api/scan') {
        if (!auth(req,res,session,['admin','staff'],true))return;
        const payload=await body(req);checkCsrf(req,session,payload);
        const qrData=parseTicketQr(payload.token);
        if (!qrData)return json(res,400,{status:'invalid',message:'รูปแบบ QR Code ไม่ถูกต้อง'});
        const row=db.prepare(`SELECT t.*, tt.name, o.paid_at FROM tickets t
          JOIN ticket_types tt ON tt.id=t.ticket_type_id
          JOIN orders o ON o.id=t.order_id
          WHERE t.qr_token=?`).get(qrData.token);
        if (!row)return json(res,404,{status:'invalid',message:'ไม่พบรหัสบัตรในระบบ'});
        if (!matchesTicketRecord(qrData,row.paid_at,row.visit_date))
          return json(res,400,{status:'invalid',message:'ข้อมูลวันที่ใน QR ไม่ตรงกับข้อมูลบัตรจริง'});
        const purchase=bangkokParts(row.paid_at);
        const details={ticketNo:row.id,name:row.name,visitDate:row.visit_date,
          purchaseDate:purchase.purchaseDate,purchaseTime:purchase.purchaseTime};
        if (row.status==='used')return json(res,409,{status:'used',message:'บัตรนี้ถูกใช้งานแล้ว',...details,checkedInAt:row.checked_in_at});
        if (row.visit_date!==todayBangkok())return json(res,409,{status:'wrong_date',message:row.visit_date<todayBangkok()?'บัตรเลยวันที่เข้าชมแล้ว':'บัตรยังไม่ถึงวันที่เข้าชม',...details});
        transaction(db,()=>{
          const time=stamp();
          const updated=db.prepare(`UPDATE tickets SET status='used',checked_in_at=?,checked_in_by=? WHERE qr_token=? AND status='active'`).run(time,user.username,qrData.token);
          if (updated.changes!==1)throw new Error('Concurrent ticket use detected');
          db.prepare('INSERT INTO checkins(ticket_id,checked_in_by,checked_in_at) VALUES (?,?,?)').run(row.id,user.username,time);
        });
        return json(res,200,{status:'valid',message:'บัตรถูกต้อง เข้าใช้งานได้',...details});
      }
      const editType=pathname.match(/^\/api\/admin\/types\/([a-z0-9_-]+)$/);
      if (req.method==='POST' && editType) {
        if (!auth(req,res,session,['admin'],true))return;
        const payload=await body(req);checkCsrf(req,session,payload);
        const price=Number(payload.price), active=payload.active===true||payload.active==='true'||payload.active==='on';
        if (!Number.isInteger(price)||price<0||price>1000000)return json(res,400,{error:'กรุณาระบุราคาที่ถูกต้อง (0–1,000,000)'});
        const update=db.prepare('UPDATE ticket_types SET price=?,active=? WHERE id=?').run(price,active?1:0,editType[1]);
        if (!update.changes)return json(res,404,{error:'ไม่พบประเภทบัตร'});
        return json(res,200,{ok:true});
      }
      if (pathname.startsWith('/api/')) return json(res,404,{error:'ไม่พบ API'});
      return html(res,404,pages.errorPage(404,'ไม่พบหน้าที่ค้นหา','ลิงก์อาจไม่ถูกต้องหรือถูกลบไปแล้ว',user));
    } catch(err) {
      const status=err.status||500;
      console.error('Request error:',err.message);
      if (pathname.startsWith('/api/'))return json(res,status,{error:status===500?'ระบบขัดข้อง กรุณาลองใหม่':err.message});
      return html(res,status,pages.errorPage(status,'เกิดข้อผิดพลาด',status===500?'ระบบขัดข้อง กรุณาลองใหม่':err.message,user));
    }
  });
  return {server,db,close(){ return new Promise((resolve,reject)=>server.close(err=>{db.close();err?reject(err):resolve();})); }};
}
if (require.main === module) {
  const {server}=createApp();
  const port=Number(process.env.PORT||3000);
  server.listen(port,()=>{
    console.log(`DoiTung E-Ticket Demo running at http://localhost:${port}`);
    if (process.env.NODE_ENV !== 'production') console.log('Default local demo logins: admin / Admin@12345 and staff / Staff@12345; override passwords with environment variables before first run.');
    console.log('All prices are mock prices; payments are simulations only.');
  });
}
module.exports={createApp,todayBangkok};
