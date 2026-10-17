import { useEffect, useRef } from "react";
import { inTelegram, tg } from "../telegram/webapp";

/*
 * Экраны сменяются с анимацией ухода (AnimatePresence): старый экран размонтируется позже, чем смонтировался новый,
 * и его очистка прятала кнопку, которую только что показал новый экран (в Telegram пропадали и «Назад», и главная кнопка).
 * Поэтому кнопкой владеет стопка экземпляров хука: показывает и получает нажатия только верхний, очистка убирает
 * свой экземпляр и возвращает кнопку предыдущему (например, экрану под закрывшейся шторкой) или прячет, если никого нет.
 */
let seq = 0;

const backOwners: number[] = [];
function applyBack() {
  if (backOwners.length) tg!.BackButton.show(); else tg!.BackButton.hide();
}

/** Системная кнопка «Назад» Telegram, пока экран (или шторка) открыт. */
export function useBackButton(onBack: () => void) {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!inTelegram) return;
    const id = ++seq;
    backOwners.push(id);
    const handler = () => { if (backOwners[backOwners.length - 1] === id) ref.current(); };
    tg!.BackButton.onClick(handler);
    applyBack();
    return () => {
      tg!.BackButton.offClick(handler);
      const i = backOwners.indexOf(id);
      if (i >= 0) backOwners.splice(i, 1);
      applyBack();
    };
  }, []);
}

interface MainOwner { id: number; text: string; enabled: boolean }
const mainOwners: MainOwner[] = [];
function applyMain() {
  const top = mainOwners[mainOwners.length - 1];
  // Пустой текст — экран сейчас без действия (например, агент работает): кнопку прячем, а не показываем пустой.
  if (top && top.text.trim()) tg!.MainButton.setParams({ text: top.text, is_active: top.enabled, is_visible: true });
  else tg!.MainButton.hide();
}

/**
 * Главная кнопка Telegram («Сохранить» в формах, «Сделать отчёт» в лабе). Возвращает true, если кнопка системная;
 * вне Telegram экран рисует свою кнопку внизу. Пустой text прячет кнопку.
 */
export function useMainButton(text: string, onClick: () => void, enabled = true) {
  const ref = useRef(onClick);
  ref.current = onClick;
  const params = useRef({ text, enabled });
  params.current = { text, enabled };
  const idRef = useRef(0);
  useEffect(() => {
    if (!inTelegram) return;
    const id = ++seq;
    idRef.current = id;
    mainOwners.push({ id, ...params.current });
    const handler = () => { if (mainOwners[mainOwners.length - 1]?.id === id) ref.current(); };
    tg!.MainButton.onClick(handler);
    applyMain();
    return () => {
      tg!.MainButton.offClick(handler);
      const i = mainOwners.findIndex((o) => o.id === id);
      if (i >= 0) mainOwners.splice(i, 1);
      applyMain();
    };
  }, []);
  useEffect(() => {
    if (!inTelegram) return;
    const own = mainOwners.find((o) => o.id === idRef.current);
    if (!own) return;
    own.text = text; own.enabled = enabled;
    if (own === mainOwners[mainOwners.length - 1]) applyMain();
  }, [text, enabled]);
  return inTelegram;
}
