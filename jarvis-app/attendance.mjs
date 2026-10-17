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
import * as ej from "./ej.mjs";
import * as notify from "./notify.mjs";
import { ejState } from "./users.mjs";

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

/**
 * Проверка журнала пользователя (вызывается с каждым обходом, сама решает, пора ли). Возвращает число строк в сообщении.
 * mute — уведомления выключены в профиле: снимок всё равно обновляется, чтобы при включении не пришло всё разом.
 */
export async function checkJournal(tgId, { mute = false, app = "" } = {}) {
  if (!(await ejState(tgId)).connected) return 0;
  const at = await notify.withState(tgId, (s) => s.journal?.at || 0);
  if (Date.now() - at < EVERY) return 0;
  let data;
  try { data = await ej.journal(tgId); } catch { return 0; } // журнал не ответил или вход истёк — в следующий раз
  const lines = await notify.withState(tgId, (s) => {
    const r = journalAlerts(s.journal?.subjects || null, data);
    s.journal = { at: Date.now(), subjects: r.snapshot };
    return r.lines;
  });
  if (mute || !lines.length) return 0;
  const hint = lines.some((l) => l.startsWith("❗")) ? "\n\nЕсли пропуск отмечен по ошибке — напишите преподавателю, пока он помнит занятие." : "";
  await notify.send(tgId, `🎓 Электронный журнал МИСИС\n${lines.slice(0, 12).join("\n")}${lines.length > 12 ? `\n…и ещё ${lines.length - 12}` : ""}${hint}`, undefined,
    app ? [[{ text: "Открыть журнал в Doodle", web_app: { url: `${app}/?tab=journal` } }]] : undefined);
  return lines.length;
}
