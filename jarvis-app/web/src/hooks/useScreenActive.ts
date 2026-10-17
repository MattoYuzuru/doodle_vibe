import { createContext, useContext } from "react";

/**
 * Активен ли экран, в котором рендерится компонент: false — экран стека лежит под другим экраном или уже уезжает
 * (анимация закрытия). Вкладки и всё вне стека — всегда true. Опросы (usePolling) на неактивном экране стоят на паузе,
 * а уезжающий экран не принимает нажатий и не держит кнопки Telegram.
 */
export const ScreenActiveContext = createContext(true);
export const useScreenActive = () => useContext(ScreenActiveContext);

/**
 * Глубина экрана в стеке: 0 — вкладки, 1 — первый экран поверх, 2 — следующий… Кнопки Telegram (useTelegramButtons)
 * отдаются самому глубокому владельцу, а не последнему зарегистрированному: весь стек теперь в DOM, и часть нижнего
 * экрана, смонтированная позже (догрузилась, раскрылась), иначе забрала бы кнопку у верхнего (проверка 15 окт).
 */
export const ScreenDepthContext = createContext(0);
