// Проверка assets/extract_text.py (текст вложений и материалов курса для агента лабы, п. 159 NOTES.md) и assets/peek.py.
// Папка лабы собирается во временной папке: DOCX с таблицей, PDF с текстом, PDF-«скан» без текста, HTML лекции с длинным
// названием (путь длиннее 260 знаков), файл в work\ (не должен браться). Запуск: node extract-text-test.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = mkdtempSync(join(tmpdir(), "extract-"));
const LAB = join(ROOT, "lab");
let fails = 0;
const check = (name, ok, info = "") => { console.log(`${ok ? "OK  " : "FAIL"} ${name}${ok ? "" : ` — ${info}`}`); if (!ok) fails++; };
const py = (args, input) => spawnSync("python", ["-X", "utf8", ...args], { input, encoding: "utf8" });

const LONG = "Лекция 3. Профилирование и ресурсы операционной системы_ процессор, память, ввод-вывод, диаграмма вызовов, последовательное обследование ресурсов, подробное описание инструментов и методики их применения.html";
const make = py(["-"], `
import os, docx, pymupdf
lab = r"${LAB}"
os.makedirs(os.path.join(lab, "материалы курса"), exist_ok=True)
os.makedirs(os.path.join(lab, "work"), exist_ok=True)
d = docx.Document(); d.add_paragraph("Методичка: первый абзац")
t = d.add_table(rows=2, cols=2); t.cell(0,0).text = "Параметр"; t.cell(0,1).text = "Значение"; t.cell(1,0).text = "N"; t.cell(1,1).text = "42"
d.add_paragraph("Последний абзац после таблицы"); d.save(os.path.join(lab, "Методичка.docx"))
p = pymupdf.open(); pg = p.new_page(); pg.insert_text((72, 72), "Page one text of the task " * 5); p.new_page().insert_text((72, 72), "Second page " * 8); p.save(os.path.join(lab, "Задание.pdf"))
s = pymupdf.open(); s.new_page(); s.new_page(); s.save(os.path.join(lab, "материалы курса", "Скан.pdf"))
long = "\\\\\\\\?\\\\" + os.path.join(lab, "материалы курса", ${JSON.stringify(LONG)})
open(long, "w", encoding="utf-8").write("<html><head><style>.x{}</style><script>var a=1</script></head><body><h1>Лекция 3</h1><p>Профилирование &amp; ресурсы</p><table><tr><td>CPU</td><td>90%</td></tr></table></body></html>")
d2 = docx.Document(); d2.add_paragraph("чужое"); d2.save(os.path.join(lab, "work", "свой отчёт.docx"))
print(len(long))
`);
check("тестовая папка собрана (путь лекции длиннее 260 знаков)", make.status === 0 && Number(make.stdout) > 260, make.stderr || make.stdout);

const run = () => { const r = py([join(APP, "assets", "extract_text.py"), LAB]); return { r, list: r.status === 0 ? JSON.parse(r.stdout) : [] }; };
const { r, list } = run();
const by = (s) => list.find((x) => x.file.includes(s));
const txt = (x) => readFileSync("\\\\?\\" + join(LAB, x.txt), "utf8");
check("скрипт отработал", r.status === 0, r.stderr);
check("взяты 4 файла: вложения и материалы курса, но не work\\", list.length === 4 && !list.some((x) => x.file.includes("отчёт")), JSON.stringify(list.map((x) => x.file)));
const m = by("Методичка");
check("DOCX: абзацы и таблица по порядку", m && /первый абзац\nПараметр \| Значение\nN \| 42\n\nПоследний абзац/.test(txt(m)), m && txt(m));
const z = by("Задание");
check("PDF: текст по страницам, не скан", z && z.pages === 2 && !z.scan && /=== стр\. 1 ===\nPage one/.test(txt(z)) && txt(z).includes("=== стр. 2 ==="), JSON.stringify(z));
check("PDF без текста помечен как скан", by("Скан")?.scan === true, JSON.stringify(by("Скан")));
const l = by("Лекция 3");
check("HTML с длинным именем: текст без разметки, стилей и скриптов", l && !l.error && /Лекция 3\n\nПрофилирование & ресурсы\n\nCPU \| 90%/.test(txt(l)) && !txt(l).includes("var a") && !txt(l).includes(".x{"), l && (l.error || txt(l)));
check("имя файла текста короткое, с хешем", l && l.txt.length < 120 && /[0-9a-f]{6}\.txt$/.test(l.txt), l?.txt);

// Повторный запуск не пересоздаёт готовый текст; изменённый исходник — пересоздаёт.
const mt = statSync(join(LAB, m.txt)).mtimeMs;
const again = run().list;
check("повтор: текст не пересоздан, числа те же", statSync(join(LAB, m.txt)).mtimeMs === mt && JSON.stringify(again) === JSON.stringify(list),
  list.map((x, i) => (JSON.stringify(x) === JSON.stringify(again[i]) ? "=" : `${JSON.stringify(x)} → ${JSON.stringify(again[i])}`)).join("\n"));
py(["-c", `import docx; d=docx.Document(); d.add_paragraph("новая методичка"); d.save(r"${join(LAB, "Методичка.docx")}")`]);
const future = new Date(Date.now() + 5000); utimesSync(join(LAB, "Методичка.docx"), future, future);
const third = run().list;
check("изменённый исходник — текст пересоздан", txt(third.find((x) => x.file.includes("Методичка"))).includes("новая методичка"));

// Битый файл не роняет остальные.
writeFileSync(join(LAB, "битый.docx"), "не docx");
const fourth = run();
check("битый файл: ошибка у него, остальные на месте", fourth.r.status === 0 && fourth.list.find((x) => x.file === "битый.docx")?.error && fourth.list.filter((x) => !x.error).length === 4, fourth.r.stderr || fourth.r.stdout);

// peek.py: копия до 1000 px в tmp\peek\ рабочей папки, фрагмент --crop.
writeFileSync(join(LAB, "JOB.json"), "{}");
py(["-c", `from PIL import Image; Image.new("RGBA", (2400, 1200), (255,0,0,128)).save(r"${join(LAB, "work", "big.png")}")`]);
const pk = py([join(APP, "assets", "peek.py"), join(LAB, "work", "big.png")]);
const pkPath = pk.stdout.split(" ")[0];
check("peek: копия 1000x500 в tmp\\peek рабочей папки", pk.status === 0 && pkPath.startsWith(join(LAB, "tmp", "peek")) && existsSync(pkPath) && pk.stdout.includes("1000x500 (исходный 2400x1200)"), pk.stderr || pk.stdout);
const cr = py([join(APP, "assets", "peek.py"), join(LAB, "work", "big.png"), "--crop", "0,0,600,300"]);
check("peek --crop: фрагмент в полном размере", cr.status === 0 && cr.stdout.includes("600x300"), cr.stderr || cr.stdout);

rmSync(ROOT, { recursive: true, force: true });
console.log(fails ? `\nПровалов: ${fails}` : "\nВсе проверки прошли");
process.exit(fails ? 1 : 0);
