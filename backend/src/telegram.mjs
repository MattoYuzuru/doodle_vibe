import { AppError } from './errors.mjs';

// Telegram executes this method directly from its authenticated webhook response.
// No outbound Bot API connection or bot credential is needed for a welcome reply.
export function createTelegramHandler({publicBaseUrl, now = Date.now}) {
  const seen = new Map();
  return update => {
    if(!update || !Number.isSafeInteger(update.update_id)) throw new AppError('INVALID_UPDATE');
    const time=now();
    for(const [id,until] of seen) if(until<=time) seen.delete(id);
    if(seen.has(update.update_id)) return null;
    const message=update.message;
    if(message?.chat?.type!=='private' || message.from?.is_bot || message.from?.id!==message.chat.id ||
      !Number.isSafeInteger(message.chat.id) || message.chat.id<=0 ||
      !/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(message.text||'')) return null;
    if(!publicBaseUrl) return null;
    seen.set(update.update_id,time+24*3600_000);
    if(seen.size>2000) seen.delete(seen.keys().next().value);
    return {method:'sendMessage',chat_id:message.chat.id,text:'Открой Doodle: учебные данные и пространства вузов.',
      reply_markup:{inline_keyboard:[[{text:'Открыть Doodle',web_app:{url:publicBaseUrl}}]]}};
  };
}
