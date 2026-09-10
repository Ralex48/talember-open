import { type Job, type ServiceEnv } from './types';
import { PublicError, bounded } from './security';
const words = {
 en:['Place your greeting','Drag the greeting away from faces. Text and decorations move together. Scrub the final three seconds to check your placement.','Top','Bottom','Size','Horizontal position','Vertical position','Finish video','Adjust greeting','Loading preview…'],
 ru:['Разместите пожелание','Перетащите пожелание, чтобы оно не закрывало лица. Текст и украшения перемещаются вместе. Проверьте последние три секунды видео.','Сверху','Снизу','Размер','По горизонтали','По вертикали','Завершить видео','Разместить пожелание','Загрузка предпросмотра…'],
 es:['Coloca tu mensaje','Arrastra el mensaje para no cubrir caras. El texto y los adornos se mueven juntos. Revisa los últimos tres segundos.','Arriba','Abajo','Tamaño','Posición horizontal','Posición vertical','Terminar vídeo','Ajustar mensaje','Cargando vista previa…'],
 he:['מיקום הברכה','גררו את הברכה למקום שאינו מסתיר פנים. הטקסט והקישוטים זזים יחד. בדקו את שלוש השניות האחרונות.','למעלה','למטה','גודל','מיקום אופקי','מיקום אנכי','סיום הסרטון','התאמת הברכה','טוען תצוגה מקדימה…'],
};
export function adjustButton(job:Job):string {
 return job.raw_video_key ? `<form action="/create/placement" method="post" id="placement-open"><input type="hidden" name="csrf" value="${job.csrf}"><input type="hidden" name="intent" value="open"><button class="secondary">${words[job.locale][8]}</button></form>` : '';
}
export function placementPanel(job:Job):string {
 const t=words[job.locale];
 const help={en:'Select the greeting, a heart or a firework, then drag it. Check the final three seconds before saving.',ru:'Выберите пожелание, сердечко или фейерверк и перетащите его. Проверьте последние три секунды перед сохранением.',es:'Selecciona el mensaje, un corazón o un fuego artificial y arrástralo. Revisa los últimos tres segundos antes de guardar.',he:'בחרו את הברכה, לב או זיקוק וגררו אותו. בדקו את שלוש השניות האחרונות לפני השמירה.'}[job.locale];
 const select={en:'What would you like to move?',ru:'Что переместить?',es:'¿Qué quieres mover?',he:'מה להזיז?'}[job.locale];
 return `<h1>${t[0]}</h1><p>${help}</p><form id="placement-form" action="/create/placement" method="post"><input type="hidden" name="csrf" value="${job.csrf}"><input type="hidden" name="intent" value="finish"><input type="hidden" name="revision" value="${job.overlay_revision}"><input type="hidden" name="layout_elements" value="[]">${[['scale',job.overlay_scale],['x',job.overlay_x],['y',job.overlay_y]].map(([name,value])=>`<input type="hidden" name="${name}" value="${value}">`).join('')}<div class="placement-stage"><video id="placement-video" src="/media/raw" controls playsinline preload="auto"></video></div><p id="placement-status" role="status">${t[9]}</p><label>${select}<select id="placement-select" disabled></select></label><div class="script-actions"><button type="button" data-place="top">${t[2]}</button><button type="button" data-place="bottom">${t[3]}</button></div>${[['zoom',t[4],30,100,80],['cx',t[5],0,100,50],['cy',t[6],0,100,20]].map(([name,label,min,max,value])=>`<label>${label}<input type="range" name="${name}" min="${min}" max="${max}" step="0.1" value="${value}"></label>`).join('')}<button class="primary" id="placement-finish" disabled>${t[7]}</button></form>`;
}
export async function placementAction(env:ServiceEnv,job:Job,data:FormData):Promise<Job> {
 if(!job.raw_video_key||!job.paid_at||!job.capture_id)throw new PublicError(409,'Video is not ready.');
 const intent=data.get('intent');
 if(data.getAll('intent').length!==1)throw new PublicError(400,'Invalid placement.');
 let sql:string, params:unknown[];
 if(intent==='open') {
  sql="UPDATE creation_jobs SET overlay_review=1,overlay_revision=overlay_revision+1 WHERE id=? AND phase='complete' AND lease_until<=? RETURNING *";params=[job.id,Date.now()];
 }else if(intent==='finish'){
  let elements:unknown;
  try{if(data.getAll('layout_elements').length!==1)throw new Error();elements=JSON.parse(String(data.get('layout_elements')));}catch{throw new PublicError(400,'Invalid placement.');}
  if(!Array.isArray(elements)||elements.length>85||elements.some(p=>!p||typeof p!=='object'||typeof p.id!=='string'||!/^(text|emoji(?:[0-9]|[1-7][0-9])|heart[01]|firework[01])$/.test(p.id)||['x','y','scale'].some(k=>typeof p[k]!=='number'||!Number.isFinite(p[k]))||p.x<0||p.x>100||p.y<0||p.y>100||p.scale<30||p.scale>(p.id==='text'?100:200))||new Set(elements.map(p=>p.id)).size!==elements.length)throw new PublicError(400,'Invalid placement.');
  const elementJson=JSON.stringify(elements.map(({id,x,y,scale})=>({id,x,y,scale})));
  const allowed=new Set(['text',...Array.from(job.closing_wish??'').filter(c=>c==='❤'||c==='🎉').map((_,i)=>`emoji${i}`),...(['hearts','celebration'].includes(job.greeting_effect)?['heart0','heart1']:[]),...(['fireworks','celebration'].includes(job.greeting_effect)?['firework0','firework1']:[])]);
  if(elements.some(p=>!allowed.has(p.id)))throw new PublicError(400,'Invalid placement.');
  const values=['x','y','scale','revision'].map(k=>{const s=data.get(k);if(data.getAll(k).length!==1||typeof s!=='string'||!/^\d{1,9}$/.test(s))throw new PublicError(400,'Invalid placement.');return Number(s);});
  const [x,y,scale,revision]=values as [number,number,number,number];
  if(x>100||y>100||scale<30||scale>100)throw new PublicError(400,'Invalid placement.');
  sql="UPDATE creation_jobs SET overlay_x=?,overlay_y=?,overlay_scale=?,overlay_elements_json=?,overlay_review=0,overlay_revision=overlay_revision+1,phase='video_generating',next_at=0 WHERE id=? AND overlay_review=1 AND overlay_revision=? AND lease_until<=? AND raw_video_key IS NOT NULL RETURNING *";params=[x,y,scale,elementJson,job.id,revision,Date.now()];
 }else throw new PublicError(400,'Invalid placement.');
 sql=sql.replace(' RETURNING *'," AND content_deleted_at IS NULL AND EXISTS(SELECT 1 FROM creation_payments p WHERE p.job_id=creation_jobs.id AND p.capture_id=creation_jobs.capture_id AND p.order_id=creation_jobs.order_id) RETURNING *");
 const changed=await env.TALEMBER_DB.prepare(sql).bind(...params).first<Job>();
 if(!changed)throw new PublicError(409,'Please reload this page.');
 return changed;
}
export async function greetingPreview(env:ServiceEnv,job:Job):Promise<Response>{
 if(!job.overlay_review||!job.raw_video_key||!env.TALEMBER_RENDERER)throw new PublicError(404,'Not found.');
 const [w,h]=job.video_ratio.split(':').map(Number) as [number,number];
 const width=Math.round(720*w/Math.min(w,h)),height=Math.round(720*h/Math.min(w,h));
 const metadata=btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({text:job.closing_wish??'',locale:job.locale,font:job.greeting_font,color:job.greeting_color,effect:job.greeting_effect,width,height}))));
 const r=await env.TALEMBER_RENDERER.fetch('https://renderer/preview',{method:'POST',headers:{'X-Greeting':metadata}});
 if(!r.ok)throw new PublicError(503,'Preview is starting. Please reload shortly.');
 const manifest=JSON.parse(new TextDecoder().decode(await bounded(r.body,2*1024*1024)));
 return Response.json({...manifest,layout:{x:job.overlay_x,y:job.overlay_y,scale:job.overlay_scale,elements:JSON.parse(job.overlay_elements_json??'[]')}},{headers:{'Cache-Control':'private, no-store'}});
}
