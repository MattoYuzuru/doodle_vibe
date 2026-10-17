import type { AppData, Collection } from "./types";

/**
 * Слой данных. Экранам всё равно, где лежат данные: сейчас это CloudStorage Telegram
 * (с копией в localStorage), позже дедлайны из Moodle придут через ApiRepository с server.mjs.
 */
export interface Repository {
  /** Быстрое чтение для первого кадра (локальная копия), может вернуть null. */
  loadCached(): AppData | null;
  /** Актуальные данные (облако или сервер). null — данных ещё нет. */
  load(): Promise<AppData | null>;
  save(collection: Collection, items: AppData[Collection]): Promise<void>;
}
