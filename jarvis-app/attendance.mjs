// Риск по посещаемости и оценкам из электронного журнала МИСИС → сообщения бота (просьба владельца, 4 окт 2026).
// Журнал уже подключён (ej.mjs) и виден во вкладке приложения, но о пропуске или просевшем рейтинге студент узнавал,
// только открыв её. Теперь раз в несколько часов свежие данные журнала сравниваются с прошлым снимком, и бот пишет о том,
// что изменилось к худшему:
//   — в журнале появился пропуск (если он отмечен по ошибке, это видно сразу, пока преподаватель помнит занятие);
//   — посещаемость по предмету перешла в жёлтую (ниже 75 %) или красную (ниже 50 %) зону — границы те же, какими журнал
//     сам красит проценты;
//   — работа оценена ниже порога зачёта;
//   — по уже выставленным оценкам предмет идёт ниже порога тройки.
// Первая проверка и новый предмет только запоминаются. Улучшения (пропуск сняли, посещаемость выросла) — молча.
// Дисциплину журнала без курса в Moodle бот не решает за студента, а спрашивает, его ли она (ниже, 16 окт 2026).
import * as ej from "./ej.mjs";
import * as notify from "./notify.mjs";
import { ejState, listUsers, OWNER_ID } from "./users.mjs";

const EVERY = Number(process.env.JOURNAL_EVERY_MS) || 3 * 3600e3;
export const LOW = 75, CRITICAL = 50;
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
// Дата занятия в журнале — «2026-09-08» без времени: берём число и месяц прямо из строки (разбор через Date сдвинул бы день по поясу сервера).
const day = (d) => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(d ?? "")); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : ""; };
const pct = (v) => `${String(Math.round(v * 10) / 10).replace(".", ",")} %`;
const absKey = (a) => `${String(a.date).slice(0, 10)}|${a.kind}|${a.n ?? ""}`;
const band = (v) => (v == null ? "ok" : v < CRITICAL ? "critical" : v < LOW ? "low" : "ok");
const WORSE = { ok: 0, low: 1, critical: 2 };

/** Доля набранного по работам, у которых уже есть оценка (будущие и непроверенные не считаются), в процентах; null — оценок меньше двух. */
function earned(s) {
  const marked = (s.works || []).filter((w) => w.mark != null && w.max);
  if (marked.length < 2) return null;
  return (marked.reduce((a, w) => a + w.mark, 0) / marked.reduce((a, w) => a + w.max, 0)) * 100;
}

/**
 * Прошлый снимок (или null) + данные журнала → строки для сообщения и новый снимок. Чистая функция: без сети и времени.
 * Снимок: { [id предмета]: { abs: [метки пропусков], band, failed: [названия работ], behind: bool } }.
 */
export function journalAlerts(prev, data) {
  const lines = [], snapshot = {};
  for (const s of data?.subjects || []) {
    if (s.error) { if (prev?.[s.id]) snapshot[s.id] = prev[s.id]; continue; } // предмет сейчас не загрузился — оставляем прежний снимок
    const got = earned(s), thr3 = s.thresholds?.[3] ?? null;
    const cur = {
      abs: (s.absences || []).map(absKey),
      band: band(s.attendance),
      failed: (s.works || []).filter((w) => w.failed).map((w) => w.name),
      behind: got != null && thr3 != null && got < thr3,
    };
    snapshot[s.id] = cur;
    const was = prev?.[s.id];
    if (!was) continue; // первая проверка или новый предмет — только запоминаем
    const fresh = (s.absences || []).filter((a) => !was.abs.includes(absKey(a)));
    if (fresh.length) {
      const list = fresh.slice(0, 4).map((a) => `${String(a.kind).toLowerCase()}${a.n != null ? ` ${a.n}` : ""}${day(a.date) ? `, ${day(a.date)}` : ""}`).join("; ");
      lines.push(`❗ ${fresh.length === 1 ? "Пропуск" : `Пропуски (${fresh.length})`} · ${s.name}: ${list}${fresh.length > 4 ? "…" : ""}`);
    }
    if (WORSE[cur.band] > WORSE[was.band ?? "ok"]) {
      const l = s.lessons;
      lines.push(`⚠️ Посещаемость · ${s.name}: ${pct(s.attendance)} — ниже ${cur.band === "critical" ? CRITICAL : LOW} %${l?.past ? ` (пропущено ${l.absent} из ${l.past} занятий)` : ""}`);
    }
    for (const w of (s.works || []).filter((x) => x.failed && !(was.failed || []).includes(x.name)))
      lines.push(`⚠️ Оценка ниже порога · ${s.name}: «${w.name}» — ${w.mark}${w.max ? ` из ${w.max}` : ""}`);
    if (cur.behind && !was.behind) lines.push(`⚠️ Рейтинг · ${s.name}: по выставленным оценкам ${pct(got)} — ниже порога тройки (${pct(thr3)})`);
  }
  return { lines, snapshot };
}

// ---------- дисциплина журнала без курса в Moodle: спросить студента ----------
// 16 окт 2026: студенту пришло «Оценка ниже порога» по «Теории информационных процессов и систем», а среди его курсов
// Moodle такой нет. Владелец: «при расхождении лучше уточнять информацию у самого студента, существует ли у него такой
// курс или нет». В журнале бывают и настоящие дисциплины без курса в Moodle (у владельца — та же ТИПиС), поэтому решать
// за студента нельзя: о каждой такой дисциплине (admission.unmatchedSubjects) бот один раз спрашивает кнопками. «Нет, не
// моя» — уведомления журнала по ней больше не приходят. Передумать — кнопкой под тем же сообщением или в /settings; курс
// потом появился в Moodle — «не моя» снимается сама (студент записан на курс). Ответ бот пересылает владельцу.
// С 16 окт 2026 (позже) «не моя» и «Не моё» в «Сессии» — одно решение (admission.notMineIds, решает последнее слово):
// не своя дисциплина не идёт ни в уведомления журнала, ни во вкладку «Журнал» и /journal (там — отдельно, с «Вернуть»),
// ни в «Сессию»; скрытую в «Сессии» бот не спрашивает. «Вернуть» откуда угодно снимает обе отметки (restoreMine).
// Состояние (notify): journalAsk = { [id дисциплины журнала]: { name, at, answer, answeredAt, told } }, answer — null (не
// ответил) | "yes" | "no", told — какой ответ уже ушёл владельцу. id дисциплины журнала — свой у каждого семестра: в новом
// семестре вопрос заново. Проверка независимым обзором (16 окт): запись — до отправки (нажатие не теряется, если ответ
// Telegram задержался или оборвался), ворох вопросов в начале семестра отсечён в unmatchedSubjects.
const ASK_MAX = 3; // вопросов за одну проверку — остальные в следующую
const ASK_KEEP = 200; // записей journalAsk не больше — защита файла состояния от поддельных нажатий
// Ответ владельцу — через столько после последнего нажатия: «нет → да → нет» подряд — одно сообщение с итогом.
const TELL_MS = Number(process.env.JOURNAL_ASK_TELL_MS) || 60e3;
const askId = (id) => /^\d{1,15}$/.test(String(id ?? "")); // id уходит в callback_data (Telegram — не длиннее 64 байт)
/**
 * Кого спросить сейчас: дисциплины без курса, о которых ещё не спрашивали и которые студент сам не назвал не своими в
 * «Сессии» (off — admission.notMineIds: id строкой), — не больше ASK_MAX.
 */
export const toAsk = (unmatched, asked, off = null) => (unmatched || []).filter((s) => askId(s.id) && !asked?.[s.id] && !off?.has(String(s.id))).slice(0, ASK_MAX);
/**
 * Данные журнала без дисциплин, которые студент назвал не своими: off — admission.notMineIds (бот и «Сессия»); без него —
 * только ответы бота «не моя». Их нет и в снимке: передумает — по ним только запомним, как по новому предмету, без
 * старых новостей разом.
 */
export const withoutNotMine = (data, asked, off = null) => (data?.subjects
  ? { ...data, subjects: data.subjects.filter((s) => (off ? !off.has(String(s.id)) : asked?.[s.id]?.answer !== "no")) } : data);
/**
 * «Не моя» по дисциплинам, у которых курс в Moodle появился позже ответа, снимается (запись удаляется): студент записан на
 * курс — значит, дисциплина его. unmatched — admission.unmatchedSubjects (null — сравнить не с чем: ничего не трогаем).
 * keep — id (строкой) с отметкой «Не моё» в «Сессии»: там студент скрыл её сам (перезачли, не изучает) — курс в Moodle
 * этому не противоречит, и «снова присылаю» было бы неправдой. Правит asked на месте, возвращает дисциплины со снятым «не моя».
 */
export function dropStaleNo(asked, data, unmatched, keep = null) {
  if (!asked || !unmatched || !data?.subjects) return [];
  const still = new Set(unmatched.map((s) => String(s.id)));
  const out = [];
  for (const s of data.subjects) if (asked[s.id]?.answer === "no" && !still.has(String(s.id)) && !keep?.has(String(s.id))) { delete asked[s.id]; out.push(s); }
  return out;
}
/**
 * Записи о дисциплинах, которых в журнале больше нет (прошлый семестр — у журналов новые id; дисциплину убрали; поддельное
 * нажатие), удаляются — кроме ответа, который ещё не дошёл до владельца. Журнал пустой — ничего не трогаем. Правит на месте.
 */
export function pruneAsk(asked, data) {
  if (!asked || !data?.subjects?.length) return;
  const cur = new Set(data.subjects.map((j) => String(j.id)));
  for (const [id, x] of Object.entries(asked)) if (!cur.has(id) && (x?.answer == null || x.answer === x.told || !x.name)) delete asked[id];
}
/** Текст вопроса; answer — уже данный ответ (после нажатия сообщение правится на месте), back — «моя» после «не моя». */
export function askText(name, answer = null, { back = false } = {}) {
  const q = `❓ Электронный журнал МИСИС\nВ журнале у вас есть дисциплина${name ? ` «${name}»` : ""}, а среди ваших курсов Moodle этого семестра (в Doodle: Профиль → Курсы) курса с таким названием не нашлось. Это ваша дисциплина?\nЕсли нет — уведомления журнала по ней присылать не буду, а в средних и пропусках вкладки «Журнал», в /journal и в «Сессии» она не будет считаться. Ответ увидит и администратор Doodle.`;
  if (answer === "yes") return `${q}\n\n✅ Ответ: моя — уведомления журнала по ней приходят, в «Журнале» и «Сессии» она считается.${back ? " Что было, пока она была не ваша, — во вкладке «Журнал»." : ""}`;
  if (answer === "no") return `${q}\n\n🚫 Ответ: не моя — уведомлений журнала по ней больше не будет. В средних «Журнала» и в «Сессии» она не считается (во вкладке «Журнал» — отдельным списком внизу). Вернуть — кнопкой ниже, в /settings или во вкладке «Журнал».`;
  return q;
}
/** Кнопки: до ответа — «Да, моя» и «Нет, не моя»; после — одна, чтобы передумать. В кнопке — сам ответ, а не «переключить»: повтор нажатия безвреден. */
export function askButtons(id, answer = null) {
  const yes = { text: answer === "no" ? "Всё-таки моя" : "Да, моя", callback_data: `ejq:y:${id}` };
  const no = { text: answer === "yes" ? "Всё-таки не моя" : "Нет, не моя", callback_data: `ejq:n:${id}` };
  return [answer === "yes" ? [no] : answer === "no" ? [yes] : [yes, no]];
}
/**
 * Нажатие «Да, моя» / «Нет, не моя» (bot-commands.callback: ejq:<y|n>:<id> под вопросом; «Вернуть» — restoreMine) → вид
 * сообщения для правки на месте. Без сети: обработка нажатий у бота идёт по одному, сообщение владельцу — отложенное.
 */
export async function answerAsk(tgId, id, yes, { quiet = false } = {}) {
  const answer = yes ? "yes" : "no";
  // Дисциплины уже нет в журнале (кнопка под вопросом прошлого семестра, дисциплину убрали, поддельное нажатие) — ничего не меняем.
  const cur = ej.lastGood(tgId)?.subjects;
  if (cur?.length && !cur.some((j) => String(j.id) === String(id))) return { text: "Этой дисциплины уже нет в вашем электронном журнале — отвечать на вопрос не нужно.", buttons: [] };
  let q = null, changed = false, back = false, created = false;
  await notify.withState(tgId, (s) => {
    const all = (s.journalAsk ??= {});
    // Записи нет (состояние восстановлено из копии и т. п.), а кнопка — от вопроса бота: ответ всё равно запоминаем.
    // Название — из последнего журнала (после перезапуска его может не быть — допишет следующая проверка; до тех пор
    // владельцу не сообщаем: так поддельные нажатия с придуманными id до него не доходят).
    if (!all[id] && Object.keys(all).length >= ASK_KEEP) return;
    // quiet (restoreMine) — запись, заведённая не ответом на вопрос бота, владельцу не уходит (told сразу).
    if (!all[id]) { created = true; all[id] = { name: cur?.find((j) => String(j.id) === String(id))?.name ?? null, at: Date.now(), answer: null, ...(quiet ? { told: answer } : {}) }; }
    const x = all[id];
    changed = x.answer !== answer;
    back = yes && x.answer === "no";
    if (changed) x.answer = answer;
    // Время — и у повторного нажатия: с «Не моё» в «Сессии» решает последнее слово (admission.notMineNow), и «Всё-таки
    // моя» после «Не моё» там должна перевесить его, даже если в боте уже было «моя».
    x.answeredAt = Date.now();
    q = { ...x };
  });
  if (!q) return { text: "Этот вопрос устарел — отвечать на него не нужно.", buttons: [] };
  if (changed) {
    console.log(`journal-ask ${tgId}: «${q.name}» — ${yes ? "моя" : "не моя"}`);
    if (tgId !== OWNER_ID && !(quiet && created)) tellLater(tgId, String(id)); // свой ответ владелец и так знает
  }
  return { text: askText(q.name, q.answer, { back }), buttons: askButtons(id, q.answer) };
}
/**
 * «Вернуть» дисциплину журнала, которую студент назвал не своей (вкладка «Журнал» — POST api/ej/mine; /journal и
 * /settings — кнопки ejj:<id> и ejs:<id>): снимаются обе отметки — «Не моё» «Сессии» у её пары (admission.unhideJournal)
 * и «не моя» в боте (answerAsk «моя»; владельцу — как обычный ответ). Не своей она была только по «Сессии» (в боте «не
 * моя» нет, отметку нашли и сняли) — бот не трогаем. Пару найти не удалось (журнал не загрузился) — в боте тихое «моя»:
 * последнее слово перевешивает отметку «Сессии» (admission.notMineNow).
 */
export async function restoreMine(tgId, id) {
  let cleared = 0;
  try { cleared = await (await import("./admission.mjs")).unhideJournal(tgId, id); }
  catch (e) { console.log(`journal-ask ${tgId}: «Не моё» в «Сессии» не снято (${e.message || e})`); }
  const q = (await notify.peekState(tgId)).journalAsk?.[id];
  if (q?.answer === "no") return answerAsk(tgId, id, true);
  if (cleared) return null;
  return answerAsk(tgId, id, true, { quiet: true });
}
const telling = new Map(); // «tgId:id» → таймер отложенного сообщения владельцу
function tellLater(tgId, id) {
  const key = `${tgId}:${id}`;
  clearTimeout(telling.get(key));
  const t = setTimeout(() => {
    telling.delete(key);
    tellOwner(tgId, id).catch((e) => console.log(`journal-ask ${tgId}: владельцу не отправлено (${e.message || e})`));
  }, TELL_MS);
  t.unref?.();
  telling.set(key, t);
}
/** Владельцу — нынешний ответ студента, если он ещё не уходил (told). Не дошло — повторит следующая проверка журнала. */
async function tellOwner(tgId, id) {
  const q = (await notify.peekState(tgId)).journalAsk?.[id];
  if (!q?.answer || q.answer === q.told || !q.name) return; // без названия — после проверки журнала (она же повторит)
  // Имя — только украшение сообщения (как у запроса доступа к отчётам): список не прочитался — шлём без имени.
  const me = (await listUsers().catch(() => [])).find((x) => x.tgId === tgId);
  const who = [me?.tgName, me?.tgUsername ? "@" + me.tgUsername : null, me?.fullName, me?.group].filter(Boolean).join(" · ");
  const r = await notify.deliver(OWNER_ID, `🎓 Ответ о дисциплине журнала без курса в Moodle:\n${who || "без имени"} · id ${tgId}\n«${q.name}» — ${q.answer === "yes" ? "моя" : "не моя (не считается в уведомлениях журнала, «Журнале» и «Сессии»)"}`);
  if (!notify.settled(r)) return;
  await notify.withState(tgId, (s) => { const x = s.journalAsk?.[id]; if (x?.answer === q.answer) x.told = q.answer; });
}
/** Вопросы о дисциплинах журнала без курса в Moodle — каждой один раз (кроме скрытых в «Сессии», off). Возвращает число дошедших. */
async function askAbout(tgId, unmatched, off = null) {
  const list = toAsk(unmatched, (await notify.peekState(tgId)).journalAsk, off);
  let n = 0;
  for (const s of list) {
    try {
      // Запись — до отправки: нажатие, пришедшее раньше ответа Telegram или после обрыва, найдёт свой вопрос.
      let fresh = false;
      await notify.withState(tgId, (st) => { const all = (st.journalAsk ??= {}); if (!all[s.id]) { all[s.id] = { name: s.name, at: Date.now(), answer: null }; fresh = true; } });
      if (!fresh) continue;
      const r = await notify.deliver(tgId, askText(s.name), undefined, askButtons(s.id));
      // Точно не дошло — временный сбой (5xx, 429, нет сети) или /stop: запись убираем, если ответа так и нет, — спросим в
      // следующую проверку (после /stop — когда включит сообщения). «Неизвестно, дошло ли» (обрыв) оставляем: кнопки под
      // дошедшим сообщением должны работать, а дубль вопроса хуже. Недоступен боту (403) — тоже оставляем: повторять незачем.
      if (r.status === "muted" || (r.retryable && !r.maybe)) await notify.withState(tgId, (st) => { if (st.journalAsk?.[s.id]?.answer === null) delete st.journalAsk[s.id]; });
      else if (r.ok) n++;
      if (r.down) break; // связь с Telegram лежит — остальных спросим потом
    } catch (e) { console.log(`journal-watch ${tgId}: вопрос о «${s.name}» (${e.message || e})`); }
  }
  if (n) console.log(`journal-watch ${tgId}: вопросов о дисциплинах без курса в Moodle ${n}`);
  return n;
}

// Сообщение о журнале не ушло (временный сбой) — повтор через столько, а не через EVERY (3 ч): о пропуске важно сразу.
const RETRY_MS = Math.min(15 * 60e3, EVERY);
/**
 * Проверка журнала пользователя (вызывается с каждым обходом, сама решает, пора ли). Возвращает число строк в сообщении
 * (0 — если сообщение не дошло: тогда снимок возвращается прежним, и проверка повторится примерно через 15 минут).
 * mute — уведомления выключены в профиле: снимок всё равно обновляется, чтобы при включении не пришло всё разом.
 * deadlines — прочитанные дедлайны Moodle (курсы семестра) для вопроса о дисциплинах без курса; null — не спрашиваем.
 * night — ночь: вопросы ждут дневной проверки (сами уведомления журнала идут как раньше).
 */
export async function checkJournal(tgId, { mute = false, app = "", deadlines = null, night = false } = {}) {
  if (!(await ejState(tgId)).connected) return 0;
  // Только прочитать (peekState, без записи): раньше и этот снимок шёл через withState и переписывал файл.
  const st0 = await notify.peekState(tgId);
  if (Date.now() - (st0.journal?.at || 0) < EVERY) return 0;
  let data;
  try { data = await ej.journal(tgId); } catch { return 0; } // журнал не ответил или вход истёк — в следующий раз
  // Дисциплины без курса в Moodle — днём и когда курсы прочитаны; иначе ни вопросов, ни снятия «не моя». Снимается «не
  // моя» только по курсам семестра (decided), без курсов прошлых семестров, о которых студента ещё спрашивают: такой курс
  // временный (ответит «не актуален» — пропадёт), и «не моя» то снималось бы, то спрашивалось заново.
  // admission — тяжёлый модуль: загружается только здесь, а не при загрузке этого (attendance-test).
  const a = await import("./admission.mjs").catch(() => null);
  let unmatched = null, decided = null;
  if (a && deadlines && !night) {
    unmatched = a.unmatchedSubjects(data, deadlines) ?? null;
    decided = a.unmatchedSubjects(data, { courses: deadlines.courses, pendingCourses: [] }) ?? null;
  }
  // «Не моё» в «Сессии» у пар дисциплин журнала (16 окт 2026): такая дисциплина не своя и для уведомлений, и для вопроса.
  const byJ = a ? await a.sessionMarks(tgId, data, { courses: deadlines?.courses || null }).catch((e) => { console.log(`journal-watch ${tgId}: отметки «Сессии» не прочитаны (${e.message || e})`); return new Map(); }) : new Map();
  let prev = null, wrote = 0, dropped = [], untold = [], off = null;
  const lines = await notify.withState(tgId, (s) => {
    prev = s.journal || null;
    // Уведомления журнала выключены — «не моя» не снимаем: строку «снова присылаю» сказать нельзя, снимем при включении.
    const was = { ...(s.journalAsk || {}) };
    dropped = (mute ? [] : dropStaleNo(s.journalAsk, data, decided, new Set(byJ.keys()))).map((j) => ({ id: String(j.id), name: j.name, entry: was[j.id] }));
    for (const j of data?.subjects || []) { const x = s.journalAsk?.[j.id]; if (x && !x.name) x.name = j.name; } // ответ без названия (answerAsk)
    pruneAsk(s.journalAsk, data);
    untold = Object.entries(s.journalAsk || {}).filter(([, x]) => x?.answer && x.answer !== x.told).map(([id]) => id);
    off = a ? a.notMineIds(data?.subjects, s.journalAsk, byJ) : null;
    const r = journalAlerts(s.journal?.subjects || null, withoutNotMine(data, s.journalAsk, off));
    s.journal = { at: (wrote = Date.now()), subjects: r.snapshot };
    return r.lines;
  });
  // Ответ студента не дошёл до владельца (сбой Telegram, перезапуск сервера до отправки) — ещё раз.
  if (Number(tgId) !== OWNER_ID) for (const id of untold) if (!telling.has(`${Number(tgId)}:${id}`)) tellLater(Number(tgId), id);
  if (mute) return 0;
  // «Не моя» снята — студенту строка, до уведомлений (сбой уведомления ниже её не отменит); не дошла — запись «не моя»
  // возвращается (если студент за это время не ответил сам), следующая проверка снимет и напишет снова.
  for (const d of dropped) {
    console.log(`journal-watch ${tgId}: курс в Moodle есть — «не моя» снято: ${d.name}`);
    const r = await notify.deliver(tgId, `🎓 Электронный журнал МИСИС\nДля дисциплины «${d.name}» среди ваших курсов Moodle теперь есть курс — снова присылаю уведомления журнала по ней и считаю её в «Журнале» и «Сессии».`);
    if (!notify.settled(r) && d.entry) await notify.withState(tgId, (s) => { (s.journalAsk ??= {})[d.id] ??= d.entry; }).catch(() => {});
  }
  let sent = 0;
  if (lines.length) {
    const hint = lines.some((l) => l.startsWith("❗")) ? "\n\nЕсли пропуск отмечен по ошибке — напишите преподавателю, пока он помнит занятие." : "";
    const r = await notify.deliver(tgId, `🎓 Электронный журнал МИСИС\n${lines.slice(0, 12).join("\n")}${lines.length > 12 ? `\n…и ещё ${lines.length - 12}` : ""}${hint}`, undefined,
      app ? [[{ text: "Открыть журнал в Doodle", web_app: { url: `${app}/?tab=journal` } }]] : undefined);
    if (!notify.settled(r)) {
      // Не дошло (сеть, 5xx, 429; 15 окт 2026 — раньше такое сообщение терялось): прежний снимок обратно, а время — так,
      // чтобы следующая проверка была через ~15 минут; она сравнит свежий журнал с прежним снимком и напишет снова.
      // Вопросы о дисциплинах без курса — тоже в ней.
      await notify.withState(tgId, (s) => {
        if (s.journal?.at !== wrote || notify.retryExhausted(s, "journal", r)) return;
        s.journal = { at: Date.now() - EVERY + RETRY_MS, subjects: prev?.subjects || {} };
      });
      return 0;
    }
    if (st0.retry?.journal) await notify.withState(tgId, (s) => notify.retryClear(s, "journal"));
    sent = r.ok ? lines.length : 0;
  }
  if (unmatched) await askAbout(tgId, unmatched, off).catch((e) => console.log(`journal-watch ${tgId}: вопрос о дисциплине без курса не задан (${e.message || e})`));
  return sent;
}
