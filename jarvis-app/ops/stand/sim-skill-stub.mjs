// Заглушка скрипта навыка moodle-student для симуляции: submit/status идут в поддельный Moodle (127.0.0.1:9911).
// Повторяет поведение настоящего: токен из MOODLE_TOKEN, «submit <id> <файл> [--final]», при отказе — текст в stderr и код 1.
import { basename } from "node:path";

const [cmd, id, file, flag] = process.argv.slice(2);
const token = process.env.MOODLE_TOKEN, BASE = "http://127.0.0.1:9911";
if (!token) { console.error("MOODLE_TOKEN не задан"); process.exit(1); }
try {
  if (cmd === "submit") {
    const r = await fetch(`${BASE}/sim/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, id, name: basename(file), final: flag === "--final" }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    console.log("Файл прикреплён (черновик).");
    if (flag === "--final") console.log("Отправлено на проверку.");
  } else if (cmd === "status") {
    const j = await (await fetch(`${BASE}/sim/status?token=${encodeURIComponent(token)}&id=${id}`)).json();
    console.log(`Статус ответа: ${j.status}; можно редактировать: ${j.canedit}`);
    for (const f of j.files) console.log(`Прикреплён файл: ${f}`);
  } else console.log("Команды: submit | status");
} catch (e) { console.error("Ошибка: " + e.message); process.exit(1); }
