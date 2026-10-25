import { AppError } from './errors.mjs';

export function createTelegramHandler({botToken, publicBaseUrl, fetchImpl = fetch}) {
  const seen = new Map();
  return async update => {
    if(!update || !Number.isSafeInteger(update.update_id)) throw new AppError('INVALID_UPDATE');
    if(seen.has(update.update_id)) return seen.get(update.update_id);
    const message=update.message;
    if(message?.chat?.type!=='private' || message.from?.is_bot || message.from?.id!==message.chat.id ||
      !/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(message.text||'')) return;
    if(!publicBaseUrl) return;
    const pending=(async()=>{
    let response;
    try { response=await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),headers:{'content-type':'application/json'},
      body:JSON.stringify({chat_id:message.chat.id,text:'Открой Doodle: учебные данные и пространства вузов.',
        reply_markup:{inline_keyboard:[[{text:'Открыть Doodle',web_app:{url:publicBaseUrl}}]]}}),
    }); }
    catch { throw new AppError('TELEGRAM_UNAVAILABLE',503); }
    if(!response.ok) { await response.body?.cancel(); throw new AppError('TELEGRAM_UNAVAILABLE',503); }
    await response.body?.cancel();
    })();
    seen.set(update.update_id,pending);
    try { await pending; if(seen.size>2000) seen.delete(seen.keys().next().value); }
    catch(error) { if(seen.get(update.update_id)===pending) seen.delete(update.update_id);throw error; }
  };
}
