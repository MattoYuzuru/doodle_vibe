import { LazyMotion, domMax } from "framer-motion";
import { StrictMode, Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./boot-guard";
import "./lib/perf";
import { markPainted } from "./boot-guard";
import "./index.css";
import { initTelegram } from "./telegram/webapp";
import { initFonts } from "./theme/fonts";

// Экран «Вузы» (вход, удалённый браузер, данные вузов) — отдельный поток на #/universities; прежнее приложение не затрагивается.
const UniversitiesApp = lazy(() => import("./universities/UniversitiesApp").then((m) => ({ default: m.UniversitiesApp })));
const inUniversities = () => location.hash.startsWith("#/universities");
function Root() {
  const [universities, setUniversities] = useState(inUniversities);
  useEffect(() => {
    const onHash = () => setUniversities(inUniversities());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return universities ? <Suspense fallback={null}><UniversitiesApp /></Suspense> : <App />;
}

initTelegram();
initFonts();
// Фон страницы: ?bg=glow|plain|gradient|dots|grain|rings|grid|glow1 (пока идёт выбор варианта).
document.documentElement.dataset.bg = new URLSearchParams(location.search).get("bg") ?? "glow";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Набор анимаций — сразу, не отложенно: с отложенной загрузкой значения, заданные до её окончания (ширина ленты
        вкладок), терялись, и при открытии сразу на вкладке «План»/«Журнал» показывалась Главная (2 окт). */}
    <LazyMotion features={domMax} strict>
      <Root />
    </LazyMotion>
  </StrictMode>,
);
requestAnimationFrame(() => requestAnimationFrame(markPainted));
