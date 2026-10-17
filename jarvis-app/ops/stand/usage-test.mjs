// Проверка учёта расхода и лимитов (usage.mjs) на придуманных журналах Claude CLI — без настоящих данных.
// Лимиты — в токенах с весом: ввод ×1, ответ модели ×5, чтение кэша ×0,1, запись в кэш ×1,25 (5 минут) и ×2 (час).
// Запуск: node usage-test.mjs   (сам задаёт временные папки журналов и хранилища)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(tmpdir(), `usage-test-${process.pid}`);
const TR = join(root, "transcripts"), CHAT = join(root, "chat"), ST = join(root, "store");
rmSync(root, { recursive: true, force: true });
mkdirSync(TR, { recursive: true }); mkdirSync(CHAT, { recursive: true }); mkdirSync(ST, { recursive: true });
process.env.USAGE_TRANSCRIPTS_DIR = TR;
process.env.USAGE_CHAT_TRANSCRIPTS_DIR = CHAT;
process.env.USAGE_STORE_DIR = ST;
process.env.MOODLE_DIRECT = "0";

let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };
const near = (a, b) => Math.abs(a - b) < 0.006;

// «Сейчас» — не раньше двух часов от начала месяца по Москве: вызовы «этого месяца» датируются на час и полчаса раньше
// и в первые минуты месяца иначе попали бы в прошлый.
const mskMonth = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date()).slice(0, 7);
const now = Math.max(Date.now(), Date.parse(`${mskMonth}-01T00:00:00+03:00`) + 2 * 3600e3), iso = (ms) => new Date(ms).toISOString();
const user = (text) => JSON.stringify({ type: "user", timestamp: iso(now - 3600e3), message: { role: "user", content: [{ type: "text", text }] } });
// Первые записи — как у настоящих шаблонов: заголовок, затем (у лабы — после курса и данных студента) подпись с папкой.
const labText = (dir, title = "ЛР4") => `# Лабораторная ${title} (Moodle id 777)\n\nКурс: Курс. Срок сдачи: завтра.\nСтудент: Иванов И. И., группа БИСТ-24-ПО-2. Рабочая папка: \`${dir}\` (подпапки tmp, work).`;
const first = (dir, env = false) => user(env ? `# Окружение для лабораторной «ЛР4» (курс «Курс», задание 777)\n\nПапка лабы: \`${dir}\`.\n\nТы — агент окружения.` : labText(dir));
const call = (id, u, at = now - 1800e3, model = "claude-sonnet-5-5", content = undefined) => JSON.stringify({ type: "assistant", timestamp: at ? iso(at) : undefined, requestId: "r" + id, message: { id, model, usage: u, content } });
const U = (i, o, cr, cw1h = 0, cw5m = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw1h + cw5m, cache_creation: { ephemeral_1h_input_tokens: cw1h, ephemeral_5m_input_tokens: cw5m } });
const reads = (path) => [{ type: "tool_use", name: "Read", input: { file_path: path } }];

// Студент 5001, лаба 777: два вызова; первый записан двумя строками (по блокам ответа) — считается один раз, с полным выводом.
// С весом: m1 = 10 + 400×5 + 100 000×0,1 = 12 010; m2 = 5 + 600×5 + 200 000×0,1 + 50 000×2 = 123 005. Всего 135 015.
writeFileSync(join(TR, "a.jsonl"), [
  first("C:\\Users\\User\\moodle-work\\users\\5001\\777"),
  call("m1", U(10, 50, 100000, 0, 0)),
  call("m1", U(10, 400, 100000, 0, 0)),
  call("m2", U(5, 600, 200000, 50000, 0)),
  "битая строка {",
].join("\n"));
// Владелец, лаба 29397 (папка без users\): вызов в прошлом месяце (1000×5 + 100 000×1,25 = 130 000) и в этом (2000×5 + 1 000 000×0,1 = 110 000).
const lastMonth = now - 40 * 86400e3;
writeFileSync(join(TR, "b.jsonl"), [first("C:\\Users\\User\\moodle-work\\29397"), call("o1", U(0, 1000, 0, 0, 100000), lastMonth), call("o2", U(0, 2000, 1000000))].join("\n"));
// Подагент, которого запустила сессия владельца (журнал в подпапке <сессия>\subagents): инструкции с папкой в нём нет,
// расход идёт в ту же работу. 2000×5 = 10 000.
mkdirSync(join(TR, "b", "subagents"), { recursive: true });
writeFileSync(join(TR, "b", "subagents", "agent-1.jsonl"), [user("Найди в методичке таблицу вариантов"), call("sub1", U(0, 2000, 0))].join("\n"));
// Сессия окружения студента 5001 по той же лабе (1000×5 = 5000) и сессия без рабочей папки (служебная — ничья: 1000 + 1000×5 = 6000).
writeFileSync(join(TR, "c.jsonl"), [first("C:\\Users\\User\\moodle-work\\users\\5001\\777", true), call("e1", U(0, 1000, 0))].join("\n"));
writeFileSync(join(TR, "d.jsonl"), [JSON.stringify({ type: "user", timestamp: iso(now), message: { role: "user", content: "привет" } }), call("x1", U(1000, 1000, 0))].join("\n"));
// Продолжение лабы после сна ПК: журнал начинается с заметки приложения, папки в ней нет — относим по папке, в которой
// агент работает (три обращения к файлам лабы 778 студента 5002). 3 вызова по 2000 токенов ответа = 30 000.
// В заметке — ещё и текст студента с чужой папкой: он в счёт не идёт (считаются только действия самого агента).
const f5002 = "C:\\Users\\User\\moodle-work\\users\\5002\\778\\work\\out\\p1.txt";
const alien = "C:\\Users\\User\\moodle-work\\29397\\x";
const resume = `[Сообщение приложения, не студента.] ПК был в спящем режиме с 16:42 до 18:06, и твой прошлый ход оборвался. Продолжай работу.\n\nСообщение студента: ${Array(20).fill(alien).join(" ")}`;
writeFileSync(join(TR, "e.jsonl"), [user(resume), call("s1", U(0, 2000, 0), undefined, undefined, reads(f5002)), call("s2", U(0, 2000, 0), undefined, undefined, reads(f5002)), call("s3", U(0, 2000, 0), undefined, undefined, reads(f5002))].join("\n"));
// То же, но папка упомянута всего дважды — случайное упоминание, сессия остаётся ничьей (служебной): 2 × 1000×5 = 10 000.
writeFileSync(join(TR, "f.jsonl"), [user("Проверка связи"), call("t1", U(0, 1000, 0), undefined, undefined, reads(f5002)), call("t2", U(0, 1000, 0), undefined, undefined, reads(f5002))].join("\n"));
// Чат бота в Telegram (главный агент, Haiku — множитель 0,5): даже с упоминанием чужой папки к пользователям не относится.
// 2 вызова по 4000 токенов ответа: 2 × 4000×5 × 0,5 = 20 000.
writeFileSync(join(CHAT, "g.jsonl"), [user("Что у меня по дедлайнам?"), ...[1, 2, 3].map((i) => call("c" + i, i < 3 ? U(0, 4000, 0) : U(0, 0, 0), undefined, "claude-haiku-4-5-20251001", reads(f5002)))].join("\n"));
// Подагент без известной родительской сессии: своей «подписи» ему не верим (поручение пишет модель) — он служебный. 200×5 = 1000.
mkdirSync(join(TR, "zzz", "subagents"), { recursive: true });
writeFileSync(join(TR, "zzz", "subagents", "agent-9.jsonl"), [user(labText("C:\\Users\\User\\moodle-work\\users\\5002\\778")), call("orph", U(0, 200, 0))].join("\n"));
// Файл лимитов первой версии — в долларах (без пометки единицы): общий $0,25 и личный $2 студенту 5003.
// Сохранён «Блокнотом» — с меткой BOM в начале.
writeFileSync(join(ST, "limits.json"), "\uFEFF" + JSON.stringify({ default: 0.25, users: { 5003: 2 }, alerted: {} }));

const u = await import(pathToFileURL(join(import.meta.dirname, "..", "..", "usage.mjs")).href);
const OWNER = 945210206;

const p = u.parseTranscript([first("C:\\Users\\User\\moodle-work\\users\\5001\\777"), call("m1", U(10, 50, 100000)), call("m1", U(10, 400, 100000))].join("\n"));
const day = Object.values(p.days)[0];
check("журнал: повтор одного сообщения считается один раз, берётся строка с полным выводом", Object.keys(p.days).length === 1 && day.calls === 1 && day.out === 400 && day.cr === 100000 && day.in === 10 && day.tok === 12010, JSON.stringify(day));
const ownDir = "C:\\Users\\User\\moodle-work\\29397";
check("журнал: сессия относится к студенту и лабе по подписи «Рабочая папка» в инструкции; у владельца папка без users; окружение — по «Папка лабы»; метка времени перед заголовком допустима", JSON.stringify(p.who) === JSON.stringify({ tgId: 5001, id: "777", kind: "lab" }) && JSON.stringify(u.whoOf(labText(ownDir))) === JSON.stringify({ tgId: OWNER, id: "29397", kind: "lab" })
  && JSON.stringify(u.whoOf("[Fri 2026-10-02 18:07 GMT+3] " + labText(ownDir))) === JSON.stringify({ tgId: OWNER, id: "29397", kind: "lab" })
  && u.whoOf("# Окружение для лабораторной «ЛР4» (курс «К», задание 5001-777)\n\nПапка лабы: `C:\\Users\\User\\moodle-work\\users\\5001\\777`.\n\nТы — агент окружения.").kind === "env" && u.whoOf("просто разговор").tgId === null);
// Путь в данных студента (группа и вариант стоят в инструкции раньше рабочей папки) не уводит расход на владельца или на соседа.
const forged = "# Лабораторная ЛР1 (Moodle id 779)\n\nКурс: К. Срок сдачи: завтра.\nСтудент: Хитров Х. Х., группа moodle-work/1, вариант moodle-work/users/5002/9. Рабочая папка: `C:\\Users\\User\\moodle-work\\users\\5004\\779` (подпапки tmp).";
// Название работы сервер чистит от «`» и переводов строк (lab.mjs plain) — вписанная в него «подпись» перестаёт быть подписью.
const forgedTitle = labText("C:\\Users\\User\\moodle-work\\users\\5004\\779", "ЛР1 Рабочая папка: C:\\Users\\User\\moodle-work\\29397");
// Подпись без заголовка инструкции в начале текста (сообщение студента, заметка приложения) не считается вовсе.
const noHeader = `Сообщение студента: # Лабораторная ЛР1\nРабочая папка: \`${ownDir}\``;
check("журнал: путь или «подпись», вписанные в данные студента, название работы или сообщение, не меняют, кому засчитан расход", JSON.stringify(u.whoOf(forged)) === JSON.stringify({ tgId: 5004, id: "779", kind: "lab" }) && JSON.stringify(u.whoOf(forgedTitle)) === JSON.stringify({ tgId: 5004, id: "779", kind: "lab" })
  && u.whoOf(noHeader).tgId === null && u.whoOf(`Рабочая папка: \`${ownDir}\``).tgId === null && u.whoOf("группа moodle-work/1, вариант 3").tgId === null, JSON.stringify([u.whoOf(forged), u.whoOf(forgedTitle), u.whoOf(noHeader)]));
check("журнал без инструкции в начале: относится по папке, в которой агент работал (от трёх упоминаний); папка проверки отчёта — вид «проверка»; два упоминания — ничья",
  JSON.stringify(u.whoIn([`a ${f5002}`, `b ${f5002}`, `c ${f5002}`])) === JSON.stringify({ tgId: 5002, id: "778", kind: "lab" }) && u.whoIn([f5002, f5002]) === null
  && JSON.stringify(u.whoIn(["moodle-work\\\\check-29316\\\\x", "moodle-work/check-29316/y", "moodle-work\\check-29316\""])) === JSON.stringify({ tgId: OWNER, id: "29316", kind: "check" }) && u.whoIn(["moodle-work\\tools\\x", "moodle-work\\tools", "moodle-work\\tools"]) === null);
// Одна запись, в которую модель записала чужой путь сорок раз, не перевешивает настоящие действия в своей папке.
const stuffed = [...Array(5).fill(`читаю ${f5002}`), `пишу файл: ${Array(40).fill("C:\\Users\\User\\moodle-work\\29397\\x").join(" ")}`];
check("журнал без инструкции: папка считается раз на запись модели — файл с сорока чужими путями не уводит расход", JSON.stringify(u.whoIn(stuffed)) === JSON.stringify({ tgId: 5002, id: "778", kind: "lab" }), JSON.stringify(u.whoIn(stuffed)));

check("токены с весом: ввод ×1, ответ ×5, чтение кэша ×0,1, запись в кэш ×1,25 и ×2", u.tokensOf({ in: 1000, out: 1000, cr: 1000, cw5m: 1000, cw1h: 1000 }) === 1000 + 5000 + 100 + 1250 + 2000 && u.tokensOf({}) === 0);
check("поправка на модель: Haiku ×0,5, Sonnet 5.5 ×1, Opus 5.5 ×2, прочий Opus ×2,5, неизвестная — как Sonnet", u.tokensOf({ in: 1000 }, "claude-haiku-4-5-20251001") === 500 && u.tokensOf({ in: 1000 }, "claude-sonnet-5-5") === 1000 && u.tokensOf({ in: 1000 }, "claude-opus-5-5") === 2000 && u.tokensOf({ in: 1000 }, "claude-opus-5") === 2500 && u.tokensOf({ in: 1000 }, "что-то новое") === 1000);
// Модель меняется внутри одного журнала: каждый вызов считается со своим множителем (а не весь журнал — по последнему).
const mixed = u.parseTranscript([first("C:\\Users\\User\\moodle-work\\29397"), call("x1", U(0, 1000, 0)), call("x2", U(0, 1000, 0), undefined, "claude-haiku-4-5-20251001"),
  JSON.stringify({ type: "assistant", message: { id: "x3", model: "claude-sonnet-5-5", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 } } })].join("\n"));
const md = Object.values(mixed.days);
check("журнал: у каждого вызова множитель своей модели; запись в кэш без разбивки считается пятиминутной; вызов без метки времени — в день соседнего", md.length === 1 && md[0].tok === 5000 + 2500 + 1250 && md[0].calls === 3 && md[0].cw5m === 1000 && Object.keys(md[0].models).length === 2, JSON.stringify(md));
const price = { in: 2, out: 10, cr: 0.2 };
check("справочная оценка в долларах: ввод $2, вывод $10, чтение кэша $0,2, запись на час ×2, на 5 минут ×1,25 (за миллион)", near(u.costOf({ in: 1e6, out: 1e6, cr: 1e6, cw1h: 1e6, cw5m: 1e6 }, price), 2 + 10 + 0.2 + 4 + 2.5));

// Старый файл лимитов в долларах пересчитывается: $1 = 500 тыс. токенов.
const s0 = await u.summary();
check("лимиты первой версии (в долларах, файл с меткой BOM) пересчитаны в токены: $0,25 → 125 тыс., $2 → 1 млн", s0.defaultLimit === 125000 && s0.users.find((x) => x.tgId === 5003)?.limit === 1000000, `${s0.defaultLimit} ${s0.users.find((x) => x.tgId === 5003)?.limit}`);
await u.setLimit(null, null); await u.setLimit(5003, null);
check("после первого сохранения файл лимитов помечен единицей «токены»", JSON.parse(readFileSync(join(ST, "limits.json"), "utf8")).unit === "tokens");

const s = await u.summary();
const st = s.users.find((x) => x.tgId === 5001), ow = s.users.find((x) => x.tgId === OWNER), s2u = s.users.find((x) => x.tgId === 5002);
check("сводка: расход студента = лаба + окружение по той же работе (135 015 + 5 000 токенов); рядом справочная оценка в долларах", s.source === "transcripts" && s.users.length === 3 && st.monthTok === 140015 && st.totalTok === 140015 && st.labs === 1 && st.calls === 3 && near(st.month, 0.28), JSON.stringify(st));
check("сводка: расход прошлого месяца в «этот месяц» не входит, но входит в «всего»; подагент засчитан в работу сессии, которая его запустила", ow.monthTok === 120000 && ow.totalTok === 250000 && ow.labs === 1 && ow.calls === 3 && ow.limit === null, JSON.stringify(ow));
check("сводка: продолжение лабы после сна отнесено студенту 5002 (по действиям агента, а не по тексту студента); служебные сессии и чат бота — отдельно, не у пользователей; подагент без известного родителя — служебный", s2u?.monthTok === 30000 && s2u.labs === 1 && s.other.service.totalTok === 6000 + 10000 + 1000 && s.other.chat.totalTok === 20000 && s.monthTok === 140015 + 120000 + 30000, JSON.stringify(s.other));
check("сводка: простая сумма токенов (как в журнале Claude) считается рядом", s.totalRaw === (10 + 400 + 100000) + (5 + 600 + 200000 + 50000) + 1000 + (1000 + 100000) + (2000 + 1000000) + 2000 + 6000, String(s.totalRaw));
const labs = await u.byLab();
const l5001 = labs.find((l) => l.tgId === 5001);
check("по работам: у работы видны доли лабы и окружения в токенах, простая сумма и оценка в долларах", labs.length === 3 && l5001.kindsTok.lab === 135015 && l5001.kindsTok.env === 5000 && l5001.tok === 140015 && l5001.raw === 351015 + 1000 && l5001.kinds.env > 0, JSON.stringify(labs.map((l) => [l.tgId, l.id, l.tok, l.raw, l.kindsTok])));

check("без лимита — проверка перед работой пропускает", (await u.own(5001)).limit === null && (await u.guard(5001, "start")) === undefined);
await u.setLimit(null, 125000); // общий лимит 125 тыс. токенов в месяц: у студента израсходовано 112 %
const o = await u.own(5001);
const blocked = await u.guard(5001, "start").then(() => "", (e) => e.message);
const cont = await u.guard(5001, "message").then(() => "ok", (e) => e.message);
check("общий лимит: новая работа при 112 % не начинается (текст понятен студенту), а сообщение в идущей лабе ещё проходит", o.limit === 125000 && o.used === 140015 && o.percent === 112 && o.level === "start" && /Лимит отчётов на этот месяц исчерпан \(израсходовано 112 %\)/.test(blocked) && /исправление по замечаниям и проверка отчёта/.test(blocked) && /В уже начатой работе писать агенту пока можно/.test(blocked) && cont === "ok", `${o.percent} % | ${blocked}`);
await u.setLimit(5001, 100000); // личный лимит 100 тыс. → 140 %: закрыты и сообщения
const cont2 = await u.guard(5001, "message").then(() => "ok", (e) => e.message);
const start2 = await u.guard(5001, "start").then(() => "ok", (e) => e.message);
check("личный лимит важнее общего; сверх 125 % не проходят и сообщения (и про «можно писать» студенту уже не говорится)", (await u.own(5001)).limit === 100000 && (await u.own(5001)).level === "all" && /Продолжить можно будет/.test(cont2) && !/пока можно/.test(start2), cont2);
check("владельца лимиты не касаются", (await u.own(OWNER)).limit === null && (await u.guard(OWNER, "start", { running: 5 })) === undefined);
const a1 = await u.alerts(), a2 = await u.alerts();
const al = a1.find((x) => x.tgId === 5001);
check("владельцу — одно сообщение о достижении лимита на пользователя и месяц (сразу о 100 %, без отдельного о 80 %), в токенах", a1.length === 1 && al.level === 100 && al.percent === 140 && al.used === 140015 && al.limit === 100000 && al.closed === true && a2.length === 0, JSON.stringify(a1));
// Владелец поменял лимит — о порогах нового лимита он узнаёт заново.
await u.setLimit(5001, null);
await u.setLimit(null, 165000); // 140 015 из 165 000 = 84 %: порог 80 % пройден, работа разрешена
const a3 = await u.alerts();
await u.setLimit(null, 165000); // то же значение ещё раз («Сохранить» без изменений) — повторного предупреждения быть не должно
const a3b = await u.alerts();
check("после смены лимита — снова одно предупреждение (теперь о 80 % нового лимита), повторное сохранение того же лимита его не возвращает; процент округляется вниз; работа разрешена", a3.length === 1 && a3[0].closed === false && a3[0].tgId === 5001 && a3[0].level === 80 && a3[0].percent === 84 && a3b.length === 0 && (await u.own(5001)).percent === 84 && (await u.guard(5001, "start")) === undefined, JSON.stringify(a3));
// У самой границы лимита вторую работу, пока идёт первая, начать нельзя: её расход ещё не посчитан (запас — средняя работа).
const par = await u.guard(5001, "start", { running: 1 }).then(() => "ok", (e) => e.message);
await u.setLimit(5001, 10000000);
const parBig = await u.guard(5001, "start", { running: 1 }).then(() => "ok", (e) => e.message);
await u.setLimit(5001, null);
check("запас на идущую работу: при 84 % и уже идущей работе новая не начинается; при большом лимите — начинается", /уже идёт работа/.test(par) && parBig === "ok", par);
// То же для сообщений: начатым работам, которым ответили разом, не дают вместе уйти далеко за 125 %.
const msg1 = await u.guard(5001, "message", { running: 0 }).then(() => "ok", (e) => e.message);
const msg2 = await u.guard(5001, "message", { running: 1 }).then(() => "ok", (e) => e.message);
check("запас при сообщении: одна начатая работа продолжается, вторая одновременно — ждёт", msg1 === "ok" && /уже идёт другая работа/.test(msg2), msg2);
await u.setLimit(5002, 37000); // 30 000 из 37 000 = 81 %: первое предупреждение этому студенту — о 80 %
const peek1 = await u.alerts({ mark: false }), peek2 = await u.alerts({ mark: false });
check("предупреждение без отметки (сообщение ещё не ушло) возвращается снова; после отметки — нет", peek1.length === 2 && peek2.length === 2);
await u.markAlerted([{ ...peek1.find((x) => x.tgId === 5002), limit: 999 }]); // лимит успели сменить — такая отметка не ставится
check("отметка «сообщено» не ставится, если лимит с тех пор сменили", (await u.alerts({ mark: false })).length === 2);
await u.markAlerted(peek1.filter((x) => x.tgId === 5001));
const a4 = await u.alerts(), w2 = a4.find((x) => x.tgId === 5002);
// (Студенту 5001 лимит только что меняли туда и обратно — о его 84 % владельцу сообщается заново: в peek1 их двое.)
check("порог 80 % у другого студента: предупреждение «на исходе» (о первом уже отмечено)", a4.length === 1 && w2?.level === 80 && w2.percent === 81 && (await u.alerts()).length === 0, JSON.stringify(a4));
await u.setLimit(5002, 0);
const zero = await u.guard(5002, "message").then(() => "ok", (e) => e.message);
check("лимит 0 закрывает пользователю работу агента — с честным текстом, без «1-го числа»", (await u.own(5002)).level === "closed" && /закрыта владельцем бота/.test(zero) && !/1-го числа/.test(zero), zero);
await u.setLimit(5002, null);
const bad = await u.setLimit(5001, "много").then(() => "", (e) => e.message);
const neg = await u.setLimit(5001, -5).then(() => "", (e) => e.message);
check("лимит принимается только неотрицательным числом", /Лимит — неотрицательное число/.test(bad) && /Лимит — неотрицательное число/.test(neg), bad);
// Сохранение лимита и отметка о предупреждении одновременно друг друга не затирают.
await Promise.all([u.setLimit(5003, 700000), u.alerts(), u.setLimit(5004, 800000), u.alerts(), u.setLimit(null, 165000)]);
const lf = JSON.parse(readFileSync(join(ST, "limits.json"), "utf8"));
check("одновременные изменения лимитов и отметок сохраняются все", lf.users["5003"] === 700000 && lf.users["5004"] === 800000 && lf.default === 165000 && lf.unit === "tokens", JSON.stringify(lf));
await u.setLimit(5003, null); await u.setLimit(5004, null);

// Файл лимитов испорчен (правили руками): студентам с лимитом — понятный отказ, владельцу работа не закрыта, расход
// на его экране виден с пометкой, а сохранение лимита чинит файл.
await u.setLimit(5001, 150000);
writeFileSync(join(ST, "limits.json"), "{ это не JSON");
const brokenGuard = await u.guard(5001, "start").then(() => "ok", (e) => e.message);
const brokenSum = await u.summary();
const brokenAlerts = await u.alerts({ mark: false }).then(() => "ok", (e) => e.message);
check("испорченный файл лимитов: студенту понятный отказ, владелец работает, сводка показывается с пометкой", /Лимиты сейчас не читаются/.test(brokenGuard) && (await u.guard(OWNER, "start")) === undefined && brokenSum.limitsBroken === true && brokenSum.users.length === 3 && /не читается/.test(brokenAlerts), brokenGuard);
for (const junk of ['[]', '{"unit":"tokens","default":"5 млн","users":{}}', '{"unit":"tokens","default":null,"users":{"5001":-1}}']) {
  writeFileSync(join(ST, "limits.json"), junk);
  const g = await u.guard(5001, "start").then(() => "ok", (e) => e.message);
  check(`файл лимитов с неверным содержимым (${junk.slice(0, 28)}…) считается испорченным, а не «без лимита»`, /Лимиты сейчас не читаются/.test(g) && (await u.summary()).limitsBroken === true, g);
}
await u.setLimit(null, 165000);
const fixedSum = await u.summary();
check("сохранение лимита владельцем чинит файл: испорченный отложен, лимит действует", fixedSum.limitsBroken === false && fixedSum.defaultLimit === 165000 && existsSync(join(ST, "limits.json.bad")) && JSON.parse(readFileSync(join(ST, "limits.json"), "utf8")).unit === "tokens" && (await u.guard(5001, "start")) === undefined);
// Вызов без метки времени в самом начале журнала попадает в день первой метки файла, а не в день изменения файла.
const early = u.parseTranscript([JSON.stringify({ type: "assistant", message: { id: "n1", model: "claude-sonnet-5-5", usage: U(0, 100, 0) } }), call("n2", U(0, 100, 0), lastMonth)].join("\n"), { mtime: now });
check("журнал: вызов до первой метки времени относится к дню этой метки (не «переезжает» при дозаписи)", Object.keys(early.days).length === 1 && Object.values(early.days)[0].calls === 2, JSON.stringify(Object.keys(early.days)));

// Журнал дописан — пересчитывается только он, прежние итоги не теряются.
writeFileSync(join(TR, "a.jsonl"), [first("C:\\Users\\User\\moodle-work\\users\\5001\\777"), call("m1", U(10, 400, 100000)), call("m2", U(5, 600, 200000, 50000, 0)), call("m3", U(0, 10000, 0))].join("\n"));
await u.scan({ force: true });
const st2 = (await u.summary()).users.find((x) => x.tgId === 5001);
check("журнал дописан — расход пересчитан (ещё один вызов: 10 000 токенов ответа = 50 000 с весом)", st2.calls === 4 && st2.monthTok === 190015, JSON.stringify(st2));
// Журнал удалён (Claude CLI чистит старые) — посчитанное остаётся.
rmSync(join(TR, "b.jsonl"));
await u.scan({ force: true });
check("журнал удалён — уже посчитанный расход остаётся", (await u.summary()).users.find((x) => x.tgId === OWNER)?.totalTok === 250000 && existsSync(join(ST, "data.json")));
rmSync(root, { recursive: true, force: true });
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
