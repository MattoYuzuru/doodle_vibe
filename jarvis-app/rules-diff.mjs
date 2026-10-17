/*
 * Изменения в правилах агента лаб (lab-instruction.md) между тем, что агент уже получил, и текущими — только изменённые
 * строки по разделам «## …». Раньше при каждом изменении правил идущей лабе приходили все правила целиком (27–37 тыс.
 * знаков; в 31667 так — в двух ходах с правками из шести), хотя менялся обычно один-два пункта (16 окт 2026, п. 161
 * NOTES.md). Строка правил — это пункт или абзац (так написан lab-instruction.md), поэтому сравниваем построчно.
 * diffRules(old, cur) → текст изменений или null, если изменений слишком много (тогда шлём правила целиком).
 */
const MAX_SHARE = 0.5; // изменилось больше половины правил — проще и надёжнее прислать целиком
const SHORT = 140;

const short = (s) => (s.length > SHORT ? `${s.slice(0, SHORT).trimEnd()}…` : s);

/** Наибольшая общая подпоследовательность строк → пары [i, j] совпавших строк по порядку. */
function lcs(a, b) {
  const n = a.length, m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; } else if (t[i + 1][j] >= t[i][j + 1]) i++; else j++;
  }
  return pairs;
}

export function diffRules(oldText, curText) {
  const a = String(oldText).replace(/\r/g, "").split("\n"), b = String(curText).replace(/\r/g, "").split("\n");
  const pairs = [...lcs(a, b), [a.length, b.length]];
  const sectionOf = (lines, k) => { for (let x = k; x >= 0; x--) if (lines[x].startsWith("## ")) return lines[x]; return "Начало правил"; };
  const blocks = new Map(); // раздел → строки изменений
  let changed = 0, pi = 0, pj = 0;
  for (const [i, j] of pairs) {
    const gone = a.slice(pi, i).filter((s) => s.trim()), added = b.slice(pj, j).filter((s) => s.trim());
    if (gone.length || added.length) {
      const sec = added.length ? sectionOf(b, pj) : sectionOf(a, pi);
      const out = blocks.get(sec) || [];
      // Пункт переписан: показываем, какой был (начало), и новый целиком; удалённые — только началом.
      if (gone.length && added.length) out.push(`Вместо: ${gone.map((s) => `«${short(s)}»`).join("; ")}\nТеперь:\n${added.join("\n")}`);
      else if (added.length) out.push(`Добавлено:\n${added.join("\n")}`);
      else out.push(`Убрано (больше не действует): ${gone.map((s) => `«${short(s)}»`).join("; ")}`);
      blocks.set(sec, out);
      changed += added.join("\n").length + gone.length * SHORT;
    }
    pi = i + 1; pj = j + 1;
  }
  if (!blocks.size) return "";
  if (changed > MAX_SHARE * curText.length) return null;
  return [...blocks].map(([sec, out]) => `${sec.startsWith("## ") ? sec : `## ${sec}`}\n${out.join("\n\n")}`).join("\n\n");
}

/** Сообщение агенту об изменённых правилах (полный текст сервер кладёт в tmp\ПРАВИЛА.md рабочей папки). */
export const diffNotice = (diff) => `[Сообщение приложения, не студента.] С начала этой лабы правила работы обновились. Ниже — только изменённые места, по разделам; остальные правила — как были, а где новые расходятся с прежними, действуй по новым. Полный текст актуальных правил — в \`tmp\\ПРАВИЛА.md\`, открывай его, только если прежних правил не помнишь. Отвечать на это не нужно — выполни сообщение студента в конце.\n\n${diff}`;
