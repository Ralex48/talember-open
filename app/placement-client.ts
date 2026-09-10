type Position={id:string;x:number;y:number;scale:number};
type Layer={id:string;label:string;x:number;y:number;width:number;height:number;png:string};
let previewUrls:string[]=[];
export function initPlacement():void {
 const form=document.querySelector<HTMLFormElement>('#placement-form');
 if(!form||form.dataset.ready)return;
 for(const url of previewUrls)URL.revokeObjectURL(url);previewUrls=[];
 form.dataset.ready='1';
 const video=form.querySelector<HTMLVideoElement>('video')!;
 const stage=form.querySelector<HTMLElement>('.placement-stage')!;
 const select=form.querySelector<HTMLSelectElement>('#placement-select')!;
 const field=(name:string)=>form.elements.namedItem(name) as HTMLInputElement;
 const labels:Record<string,string[]>={en:['Greeting','Heart','Firework','Emoji'],ru:['Пожелание','Сердечко','Фейерверк','Эмодзи'],es:['Mensaje','Corazón','Fuego artificial','Emoji'],he:['ברכה','לב','זיקוק','אימוג׳י']};
 const names=labels[document.documentElement.lang]??labels.en!;
 let positions:Position[]=[],layers:Layer[]=[],width=0,height=0;
 const images=new Map<string,HTMLImageElement>();
 const chosen=()=>positions.find(p=>p.id===select.value);
 const draw=()=>{
  for(const p of positions){const layer=layers.find(l=>l.id===p.id)!,img=images.get(p.id)!;
   const w=layer.width/width*p.scale,h=layer.height/height*p.scale;
   p.x=Math.max(w/2,Math.min(100-w/2,p.x));p.y=Math.max(h/2,Math.min(100-h/2,p.y));
   img.style.width=w+'%';img.style.left=p.x+'%';img.style.top=p.y+'%';
   img.classList.toggle('selected',p.id===select.value);
  }
  field('layout_elements').value=JSON.stringify(positions);
 };
 const sync=()=>{const p=chosen();if(!p)return;field('zoom').max=p.id==='text'?'100':'200';field('zoom').value=String(p.scale);field('cx').value=String(p.x);field('cy').value=String(p.y);draw();};
 select.addEventListener('change',sync);
 form.addEventListener('input',e=>{if(!(e.target instanceof HTMLInputElement)||!['zoom','cx','cy'].includes(e.target.name))return;const p=chosen();if(!p)return;p.scale=Number(field('zoom').value);p.x=Number(field('cx').value);p.y=Number(field('cy').value);draw();});
 form.querySelectorAll<HTMLButtonElement>('[data-place]').forEach(b=>b.addEventListener('click',()=>{const p=chosen();if(!p)return;p.x=50;p.y=b.dataset.place==='top'?0:100;draw();sync();}));
 video.addEventListener('loadedmetadata',()=>{video.currentTime=Math.max(0,video.duration-.5);});
 const visibility=()=>{for(const img of images.values())img.style.visibility=video.paused||video.currentTime>=video.duration-3?'visible':'hidden';};
 video.addEventListener('timeupdate',visibility);video.addEventListener('pause',visibility);
 const load=async(attempt=0):Promise<void>=>{
  try{
   const response=await fetch('/media/greeting',{cache:'no-store'});if(!response.ok)throw new Error();
   const data=await response.json() as {width:number;height:number;bottom:number;layers:Layer[];layout:{x:number;y:number;scale:number;elements:Position[]}};
   if(!form.isConnected)return;
   width=data.width;height=data.height;layers=data.layers;
   const s=data.layout.scale/100,ox=Math.max(0,Math.min(width-width*s,width*data.layout.x/100-width*s/2)),oy=Math.max(0,Math.min(height-data.bottom*s,height*data.layout.y/100-data.bottom*s/2));
   positions=layers.map(l=>data.layout.elements.find(p=>p.id===l.id)??{id:l.id,x:(ox+(l.x+l.width/2)*s)/width*100,y:(oy+(l.y+l.height/2)*s)/height*100,scale:data.layout.scale});
   const ready:Promise<void>[]=[];
   for(const l of layers){
    const img=document.createElement('img');img.alt='';img.draggable=false;img.dataset.layer=l.id;
    const url=URL.createObjectURL(new Blob([Uint8Array.from(atob(l.png),c=>c.charCodeAt(0))],{type:'image/png'}));previewUrls.push(url);
    ready.push(new Promise((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error());}));img.src=url;
    const kind=l.id==='text'?0:l.id.startsWith('heart')?1:l.id.startsWith('firework')?2:3;
    const option=document.createElement('option');option.value=l.id;option.textContent=l.id==='text'?names[0]!:kind===3?l.label:names[kind]+' '+(Number(l.id.replace(/\D/g,''))+1);select.append(option);
    images.set(l.id,img);stage.append(img);
    let dx=0,dy=0;
    img.addEventListener('pointerdown',e=>{select.value=l.id;sync();const r=stage.getBoundingClientRect(),p=chosen()!;dx=e.clientX-r.left-p.x/100*r.width;dy=e.clientY-r.top-p.y/100*r.height;img.setPointerCapture(e.pointerId);e.preventDefault();});
    img.addEventListener('pointermove',e=>{if(!img.hasPointerCapture(e.pointerId))return;const r=stage.getBoundingClientRect(),p=chosen()!;p.x=Math.max(0,Math.min(100,(e.clientX-r.left-dx)/r.width*100));p.y=Math.max(0,Math.min(100,(e.clientY-r.top-dy)/r.height*100));draw();sync();});
    img.addEventListener('pointerup',e=>{if(img.hasPointerCapture(e.pointerId))img.releasePointerCapture(e.pointerId);});
   }
   await Promise.all(ready);select.disabled=false;select.value='text';sync();
   (form.querySelector('#placement-finish') as HTMLButtonElement).disabled=false;
   form.querySelector('#placement-status')!.textContent='';
  }catch{
   if(!form.isConnected)return;
   if(attempt<3){setTimeout(()=>void load(attempt+1),2500);return;}
   const messages:Record<string,string>={en:'The preview is taking longer. Reload this page to try again.',ru:'Предпросмотр загружается дольше обычного. Обновите страницу, чтобы повторить.',es:'La vista previa tarda más de lo habitual. Recarga la página para reintentar.',he:'התצוגה המקדימה מתעכבת. רעננו את הדף כדי לנסות שוב.'};
   form.querySelector('#placement-status')!.textContent=messages[document.documentElement.lang]??messages.en!;
  }
 };
 void load();
}
