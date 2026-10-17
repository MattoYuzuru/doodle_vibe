/** Общие мелочи вкладки «Журнал» и плитки журнала на Главной. */

export const plural = (n: number, a: string, b: string, c: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c;
};

/** 87.5 → «87,5%»; null — журнал не посчитал. */
export const pct = (v: number | null) => (v == null ? "—" : `${String(Math.round(v * 10) / 10).replace(".", ",")}%`);

/** Цвет доли, как в самом журнале: от 75% — зелёный, от 50% — обычный (base), ниже — красный. */
export const tone = (v: number | null, base = "var(--c-accent)") =>
  v == null ? "var(--c-hint)" : v >= 75 ? "var(--c-green)" : v >= 50 ? base : "var(--c-red)";
