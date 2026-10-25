import { AppError } from './errors.mjs';
import { createHash } from 'node:crypto';

const cleanText = (text, max) => String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
export function createChatService({store, model, retrieveWeb, now = Date.now}) {
  return {
    async ask(userId, spaceId, text) {
      const space = store.getSpace(userId, spaceId);
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new AppError('INVALID_QUESTION');
      const question = text.trim();
      const kind = /пар[аыуе]?(?!\p{L})|расписан|заняти|schedule|lesson/iu.test(question) ? 'schedule'
        : /дедлайн|задани|сдать|deadline|assignment/iu.test(question) ? 'deadlines' : null;
      const evidence = [], references=[];
      if (kind) {
        for (const snapshot of store.listSnapshots(userId, spaceId, {kind})) {
          if(snapshot.items.length) references.push({type:'snapshot',id:snapshot.id,connectionId:snapshot.connectionId,
            digest:createHash('sha256').update(JSON.stringify(snapshot.items)).digest('hex')});
          for (const item of snapshot.items.slice(0, 100)) {
            evidence.push({id:`item:${item.id}`, title:cleanText(item.title, 200), url:item.url,
              fetchedAt:snapshot.fetchedAt, kind, startsAt:item.startsAt, endsAt:item.endsAt,
              dueAt:item.dueAt, location:cleanText(item.location, 200)});
          }
        }
      }
      const stopWords = new Set(['как','какие','какой','какая','меня','мой','мои','для','где','что','это','мне','есть','университет']);
      const tokens = question.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(x => x.length > 2 && !stopWords.has(x)).slice(0, 12);
      const documents = tokens.length ? store.searchDocuments(userId, spaceId, tokens.join(' '), {limit:6}) : [];
      if(!documents.length) {
        const found = new Set();
        for(const token of tokens.slice(0,4)) for(const doc of store.searchDocuments(userId,spaceId,token,{limit:3})) {
          if(!found.has(doc.id)) { documents.push(doc); found.add(doc.id); }
          if(documents.length>=6) break;
        }
      }
      let retrieval = null;
      if(!kind && !documents.length && retrieveWeb) {
        try {
          retrieval=await retrieveWeb(userId,spaceId,question);
          const found=new Set();
          for(const token of tokens.slice(0,4)) for(const doc of store.searchDocuments(userId,spaceId,token,{limit:3})) {
            if(!found.has(doc.id)) { documents.push(doc);found.add(doc.id); }
            if(documents.length>=6) break;
          }
        } catch { retrieval={errorCodes:['web_source_unavailable'],documents:[]}; }
      }
      for (const doc of documents) {
        references.push({type:'document',id:doc.id,connectionId:doc.connectionId,
          digest:createHash('sha256').update(JSON.stringify([doc.url,doc.title,doc.text,doc.fetchedAt])).digest('hex')});
        evidence.push({id:`doc:${doc.id}`, title:cleanText(doc.title, 200),url:doc.url,
          fetchedAt:doc.fetchedAt,kind:'document',text:cleanText(doc.text, 3000)});
      }
      const sources = evidence.slice(0, 50);
      let answer, mode = 'retrieval', errorCode = null;
      if (!sources.length) {
        answer = `В пространстве «${space.name}» пока нет подтверждённых данных для ответа. Подключи источник или обнови его. Выбранный вуз: ${space.universityId}.`;
      } else if (model) {
        try {
          const result = await model.answer({question, university:space.name, now:new Date(now()).toISOString(), evidence:sources});
          const ids = new Set(sources.map(x => x.id));
          if (!result || typeof result.answer !== 'string' || !result.answer.trim() || result.answer.length > 8000 ||
              !Array.isArray(result.sourceIds) || !result.sourceIds.length || result.sourceIds.some(id => !ids.has(id))) {
            throw new AppError('MODEL_INVALID_ANSWER', 502);
          }
          answer = result.answer; mode = 'model';
          const chosen = new Set(result.sourceIds);
          sources.splice(0, sources.length, ...sources.filter(x => chosen.has(x.id)));
        } catch (error) { errorCode = error instanceof AppError ? error.code : 'MODEL_UNAVAILABLE'; }
      }
      if (!answer) {
        answer = sources.slice(0, 8).map(item => `${item.title}${item.startsAt ? ` — ${item.startsAt}` : ''}${item.dueAt ? ` — срок ${item.dueAt}` : ''}${item.location ? `, ${item.location}` : ''}${item.text ? `: ${item.text.slice(0, 450)}` : ''}`).join('\n');
      }
      const citations = sources.map(({id,title,url,fetchedAt}) => ({id,title,url,fetchedAt,
        stale: !Number.isFinite(Date.parse(fetchedAt)) || now() - Date.parse(fetchedAt) > 24*3600_000}));
      return store.withEvidenceCurrent(userId,spaceId,references,()=>{
        store.appendMessage(userId, spaceId, {role:'user',text:question});
        store.appendMessage(userId, spaceId, {role:'assistant',text:answer,sources:citations});
        return {answer, sources:citations, mode, errorCode, spaceId, generatedAt:new Date(now()).toISOString(),
          retrieval:retrieval?{fetched:retrieval.fetched||0,cached:retrieval.cached||0,errorCodes:retrieval.errorCodes||[],limitations:retrieval.limitations||[]}:null};
      });
    },
  };
}
