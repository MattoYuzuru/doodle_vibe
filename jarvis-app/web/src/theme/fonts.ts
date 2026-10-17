// Переключатель шрифта для сравнения: ?font=<имя>. Подключает Google Fonts и переопределяет --font-sans / --font-display.
// Все варианты с полноценной кириллицей. display — отдельный шрифт для заголовков и крупных цифр (если задан).
export const FONTS: Record<string, { sans: string; display?: string }> = {
  manrope: { sans: "Manrope" },
  inter: { sans: "Inter" },
  onest: { sans: "Onest" },
  golos: { sans: "Golos Text" },
  geologica: { sans: "Geologica" },
  nunito: { sans: "Nunito" },
  wix: { sans: "Wix Madefor Display" },
  unbounded: { sans: "Onest", display: "Unbounded" },
};

export function initFonts() {
  const key = new URLSearchParams(location.search).get("font") ?? "";
  const f = FONTS[key];
  if (!f || key === "manrope") return; // manrope — в сборке, Google Fonts не нужен
  const families = [f.sans, f.display].filter(Boolean)
    .map((n) => `family=${n!.replace(/ /g, "+")}:wght@500;600;700;800`).join("&");
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
  document.head.appendChild(link);
  const root = document.documentElement.style;
  root.setProperty("--font-sans", `"${f.sans}", system-ui, sans-serif`);
  root.setProperty("--font-display", `"${f.display ?? f.sans}", system-ui, sans-serif`);
}
