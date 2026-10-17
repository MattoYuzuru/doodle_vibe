import { useContext, useEffect, useRef } from "react";
import { inTelegram, tg } from "../telegram/webapp";
import { ScreenDepthContext, useScreenActive } from "./useScreenActive";

/*
 * Экраны сменяются с анимацией ухода (AnimatePresence): старый экран размонтируется позже, чем смонтировался новый,
 * и его очистка прятала кнопку, которую только что показал новый экран (в Telegram пропадали и «Назад», и главная кнопка).
 * Поэтому кнопкой владеет стопка экземпляров хука: показывает и получает нажатия только верхний, очистка убирает
 * свой экземпляр и возвращает кнопку предыдущему (например, экрану под закрывшейся шторкой) или прячет, если никого нет.
 *
 * Верхний — самый глубокий экран стека (ScreenDepthContext), среди равных — зарегистрированный позже (проверка 15 окт):
 * весь стек теперь в DOM, и нижний экран, у которого что-то смонтировалось позже, иначе отнял бы кнопку у верхнего.
 * Неактивный экран (useScreenActive: накрыт другим или уже уезжает) нажатий не получает, а его главная кнопка спрятана.
 * Уезжающий экран остаётся верхним до размонтирования: нижний получит кнопку только после конца анимации, и второе
 * нажатие двойного тапа по «Сохранить» не попадёт в «Отметить сданным» или «Сделать отчёт» экрана под формой.
 */
let seq = 0;

interface Owner { id: number; depth: number; active: boolean }
function topOf<T extends Owner>(owners: T[]): T | undefined {
  let top: T | undefined;
  for (const o of owners) if (!top || o.depth > top.depth || (o.depth === top.depth && o.id > top.id)) top = o;
  return top;
}

const backOwners: Owner[] = [];
function applyBack() {
  if (backOwners.length) tg!.BackButton.show(); else tg!.BackButton.hide();
}

/** Системная кнопка «Назад» Telegram, пока экран (или шторка) открыт. */
export function useBackButton(onBack: () => void) {
  const ref = useRef(onBack);
  ref.current = onBack;
  const active = useScreenActive();
  const depth = useContext(ScreenDepthContext);
  const own = useRef<Owner | null>(null);
  const activeNow = useRef(active);
  activeNow.current = active;
  useEffect(() => {
    if (!inTelegram) return;
    const o: Owner = { id: ++seq, depth, active: activeNow.current };
    own.current = o;
    backOwners.push(o);
    // Уезжающий экран «Назад» не прячет (стрелка не мигает), но и нажатие не берёт: пусть сначала доедет.
    const handler = () => { const top = topOf(backOwners); if (top === o && o.active) ref.current(); };
    tg!.BackButton.onClick(handler);
    applyBack();
    return () => {
      tg!.BackButton.offClick(handler);
      const i = backOwners.indexOf(o);
      if (i >= 0) backOwners.splice(i, 1);
      own.current = null;
      applyBack();
    };
  }, []);
  useEffect(() => { if (own.current) own.current.active = active; }, [active]);
}

interface MainOwner extends Owner { text: string; enabled: boolean }
const mainOwners: MainOwner[] = [];
function applyMain() {
  const top = topOf(mainOwners);
  // Пустой текст — экран сейчас без действия (например, агент работает): кнопку прячем, а не показываем пустой.
  // Неактивный верхний (уезжает) — тоже прячем: нажимать на уходящем экране нечего.
  if (top && top.active && top.text.trim()) tg!.MainButton.setParams({ text: top.text, is_active: top.enabled, is_visible: true });
  else tg!.MainButton.hide();
}

/**
 * Главная кнопка Telegram («Сохранить» в формах, «Сделать отчёт» в лабе). Возвращает true, если кнопка системная;
 * вне Telegram экран рисует свою кнопку внизу. Пустой text прячет кнопку.
 */
export function useMainButton(text: string, onClick: () => void, enabled = true) {
  const ref = useRef(onClick);
  ref.current = onClick;
  const active = useScreenActive();
  const depth = useContext(ScreenDepthContext);
  const params = useRef({ text, enabled, active });
  params.current = { text, enabled, active };
  const own = useRef<MainOwner | null>(null);
  useEffect(() => {
    if (!inTelegram) return;
    const o: MainOwner = { id: ++seq, depth, ...params.current };
    own.current = o;
    mainOwners.push(o);
    const handler = () => { if (topOf(mainOwners) === o && o.active) ref.current(); };
    tg!.MainButton.onClick(handler);
    applyMain();
    return () => {
      tg!.MainButton.offClick(handler);
      const i = mainOwners.indexOf(o);
      if (i >= 0) mainOwners.splice(i, 1);
      own.current = null;
      applyMain();
    };
  }, []);
  useEffect(() => {
    const o = own.current;
    if (!o) return;
    o.text = text; o.enabled = enabled; o.active = active;
    if (o === topOf(mainOwners)) applyMain();
  }, [text, enabled, active]);
  return inTelegram;
}
