'use strict';
const $ = (s,root=document) => root.querySelector(s);
const THB=n=>'฿'+Number(n||0).toLocaleString('th-TH');
const showToast=(message)=>{const el=$('#toast');if(!el)return;el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),3600);};
const post=async(url,data,csrf='')=>{
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},body:JSON.stringify(data)});
  const payload=await r.json();if(!r.ok)throw Object.assign(new Error(payload.error||payload.message||'เกิดข้อผิดพลาด'),{payload,status:r.status});return payload;
};
const err=(id,msg)=>{const el=$(id);if(el)el.textContent=msg||'';};
const sanitizeLCD=value=>String(value ?? '').replace(/[\r\n|]+/g,' ').trim();

const toggle=$('[data-menu-toggle]');if(toggle)toggle.addEventListener('click',()=>{const nav=$('#main-nav');const open=nav.classList.toggle('open');toggle.setAttribute('aria-expanded',String(open));});

const booking=$('#booking-form');if(booking){
  const select=$('#ticket_type'),qty=$('#quantity'),total=$('#booking-total');
  const update=()=>{const match=select.options[select.selectedIndex].text.match(/฿([\d,]+)$/);const price=match?Number(match[1].replaceAll(',','')):0;total.textContent=THB(price*Math.max(1,Number(qty.value)||1));};
  select.addEventListener('change',update);qty.addEventListener('input',update);update();
  document.querySelectorAll('[data-select-ticket]').forEach(a=>a.addEventListener('click',()=>{select.value=a.dataset.selectTicket;update();}));
  booking.addEventListener('submit',async e=>{e.preventDefault();err('#booking-error','');const button=$('#book-submit');button.disabled=true;button.textContent='กำลังสร้างคำสั่งซื้อ...';try{const data=Object.fromEntries(new FormData(booking));const result=await post('/api/orders',data);window.location.href=result.checkoutUrl;}catch(error){err('#booking-error',error.message);button.disabled=false;button.textContent='ดำเนินการต่อ →';}});
}

const pay=$('#simulate-pay');if(pay)pay.addEventListener('click',async()=>{pay.disabled=true;pay.textContent='กำลังยืนยัน...';err('#payment-error','');try{const data=await post(`/api/orders/${encodeURIComponent(pay.dataset.order)}/simulate-pay`,{});window.location.href=data.ticketUrl;}catch(error){err('#payment-error',error.message);pay.disabled=false;pay.textContent='ยืนยันชำระเงินจำลอง →';}});

const lookup=$('#lookup-form');if(lookup)lookup.addEventListener('submit',e=>{e.preventDefault();const code=$('#lookup-id').value.trim().toUpperCase();if(!/^DT-[A-F0-9]{24}$/.test(code))return err('#lookup-error','หมายเลขคำสั่งซื้อควรขึ้นต้นด้วย DT- ตามด้วยตัวอักษร/ตัวเลข 24 หลัก');window.location.href='/tickets/'+encodeURIComponent(code);});
const login=$('#login-form');if(login)login.addEventListener('submit',async e=>{e.preventDefault();const button=login.querySelector('button');button.disabled=true;err('#login-error','');try{const result=await post('/api/login',Object.fromEntries(new FormData(login)));const next=login.dataset.next;window.location.href=next&&next.startsWith('/')&&!next.startsWith('//')?next:result.redirect;}catch(error){err('#login-error',error.message);button.disabled=false;}});
const logout=$('#logout-form');if(logout)logout.addEventListener('submit',async e=>{e.preventDefault();try{await post('/api/logout',{},logout.dataset.csrf);window.location.href='/';}catch(error){showToast(error.message);}});
const printButton=$('#print-tickets');if(printButton)printButton.addEventListener('click',()=>window.print());

const lcdBridge={port:null,writer:null,connected:false,statusEl:$('#esp-status'),button:$('#esp-connect'),
  setStatus(message){if(this.statusEl)this.statusEl.textContent=message;},
  async connect(){
    if(!('serial' in navigator)) throw new Error('เบราว์เซอร์นี้ไม่รองรับ Web Serial กรุณาใช้ Chrome หรือ Edge');
    if(this.connected){this.setStatus('เชื่อมต่อกับ ESP32 แล้ว');return;}
    this.port=await navigator.serial.requestPort();
    await this.port.open({baudRate:115200});
    this.writer=this.port.writable.getWriter();
    this.connected=true;
    this.setStatus('เชื่อมต่อจอ LCD แล้ว พร้อมส่งข้อมูล');
    if(this.button) this.button.textContent='เชื่อมต่อแล้ว ✓';
    await this.send({status:'ready',message:'LCD Ready',ticketNo:'-',name:'-',purchaseDate:'-',purchaseTime:'-',visitDate:'-',checkedInAt:''});
  },
  async send(data){
    if(!this.connected||!this.writer) return;
    const line=['TICKET',data.status,data.ticketNo,data.name,data.purchaseDate,data.purchaseTime,data.visitDate,data.checkedInAt||'',data.message||''].map(sanitizeLCD).join('|')+'\n';
    await this.writer.write(new TextEncoder().encode(line));
  },
  async close(){
    try{await this.writer?.releaseLock?.();}catch{}
    try{await this.port?.close?.();}catch{}
    this.connected=false;this.writer=null;this.port=null;
  }
};
if(lcdBridge.button){lcdBridge.button.addEventListener('click',async()=>{try{await lcdBridge.connect();showToast('เชื่อมต่อ ESP32 สำเร็จ');}catch(error){lcdBridge.setStatus('เชื่อมต่อไม่สำเร็จ: '+error.message);showToast(error.message);}});} 
window.addEventListener('pagehide',()=>lcdBridge.close());

const scan=$('#scan-form');if(scan){
  const input=$('#scan-token'); let locked=false;let stream=null;let timer=null;
  const render=(data,ok)=>{
    const root=$('#scan-result');
    const icon=data.status==='valid'?'✓':data.status==='used'?'!':'×';
    const title=data.message||'ไม่สามารถตรวจสอบบัตรได้';
    const statusLabel=data.status==='valid'?'พร้อมใช้งานและบันทึกการเข้าแล้ว':data.status==='used'?'ตั๋วถูกใช้งานแล้ว':data.status==='wrong_date'?'ยังไม่ถึง/เลยวันใช้งาน':'ตั๋วไม่ถูกต้อง';
    const facts=[
      ['หมายเลขบัตร',data.ticketNo],
      ['ประเภทบัตร',data.name],
      ['วันที่ซื้อ',data.purchaseDate],
      ['เวลาที่ซื้อ',data.purchaseTime],
      ['วันที่เข้าชม',data.visitDate],
      ['สถานะตั๋ว',statusLabel],
      ['ใช้ไปเมื่อ',data.checkedInAt]
    ].filter(x=>x[1]);
    root.innerHTML=`<div class="result-card ${ok?'result-good':'result-bad'}"><div class="result-big-icon">${icon}</div><h2></h2><p></p><div class="result-facts"></div></div>`;
    root.querySelector('h2').textContent=ok?'ผ่านการตรวจสอบ': 'ไม่ผ่านการตรวจสอบ';
    root.querySelector('p').textContent=title;
    const el=root.querySelector('.result-facts');facts.forEach(([label,value])=>{const row=document.createElement('div');const a=document.createElement('span');a.textContent=label;const b=document.createElement('strong');b.textContent=value;row.append(a,b);el.append(row);});
  };
  const perform=async(code)=>{
    if(locked||!code.trim())return;locked=true;
    try{
      const data=await post('/api/scan',{token:code.trim()},scan.dataset.csrf);
      render(data,true); await lcdBridge.send(data); input.value='';
    }
    catch(error){
      const payload=error.payload||{message:error.message,status:'invalid'};
      render(payload,false); await lcdBridge.send(payload); input.value='';
    }
    finally{locked=false;input.focus();}
  };
  scan.addEventListener('submit',e=>{e.preventDefault();perform(input.value);});
  const cameraBtn=$('#camera-toggle');if(cameraBtn){
    cameraBtn.addEventListener('click',async()=>{
      const placeholder=$('#camera-placeholder'),video=$('#camera-preview');
      if(stream){clearInterval(timer);stream.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;video.style.display='none';placeholder.style.display='flex';cameraBtn.textContent='เปิดกล้องสแกน';return;}
      if(!('BarcodeDetector' in window)){showToast('เบราว์เซอร์นี้ไม่รองรับสแกนด้วยกล้อง กรุณาใช้เครื่องสแกน USB หรือกรอกรหัส');return;}
      if(!navigator.mediaDevices?.getUserMedia){showToast('กล้องต้องใช้ localhost หรือ HTTPS');return;}
      try{
        stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
        video.srcObject=stream;video.style.display='block';placeholder.style.display='none';cameraBtn.textContent='ปิดกล้อง';
        const detector=new BarcodeDetector({formats:['qr_code']});
        timer=setInterval(async()=>{if(locked||video.readyState<2)return;try{const codes=await detector.detect(video);if(codes.length)await perform(codes[0].rawValue);}catch{}},600);
      }catch(error){showToast('ไม่สามารถเปิดกล้องได้: '+error.message);}
    });
    window.addEventListener('pagehide',()=>{clearInterval(timer);stream?.getTracks().forEach(t=>t.stop());});
  }
}

const adminForms=document.querySelectorAll('.admin-type-form');adminForms.forEach(form=>form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await post('/api/admin/types/'+encodeURIComponent(form.dataset.id),{price:form.querySelector('[name="price"]').value,active:form.querySelector('[name="active"]').checked},form.dataset.csrf);showToast('บันทึกการแก้ไขเรียบร้อยแล้ว');window.setTimeout(()=>window.location.reload(),450);}catch(error){showToast(error.message);button.disabled=false;}}));
