import { cloudStorage, type TgCloudStorage } from "../telegram/webapp";
import type { Repository } from "./repository";
import type { AppData, Collection } from "./types";

// CloudStorage Telegram: до 1024 ключей, значение до 4096 символов. Каждую коллекцию храним
// одной JSON-строкой, порезанной на куски: "<name>_n" = число кусков, "<name>_0", "<name>_1", …
// localStorage — копия для мгновенного старта и работа вне Telegram.
const CHUNK = 4000;
const COLLECTIONS: Collection[] = ["subjects", "deadlines", "tasks", "notes", "settings"];
const LS_PREFIX = "jarvis.";
/** Отметка «хранилище этого бота сверено с копией на сервере» (см. useAppStore.loadAll). */
export const CHECKED = "backup_checked";
const empty = (c: Collection) => (c === "settings" ? { hiddenMoodleIds: [] } : []);

const ls = {
  get: (k: string) => { try { return localStorage.getItem(LS_PREFIX + k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(LS_PREFIX + k, v); } catch { /* приватный режим */ } },
};

const cloud = (cs: TgCloudStorage) => ({
  get: (keys: string[]) => new Promise<Record<string, string>>((res, rej) =>
    cs.getItems(keys, (e, v) => (e ? rej(new Error(e)) : res(v ?? {})))),
  set: (k: string, v: string) => new Promise<void>((res, rej) => cs.setItem(k, v, (e) => (e ? rej(new Error(e)) : res()))),
  remove: (keys: string[]) => new Promise<void>((res) => (keys.length ? cs.removeItems(keys, () => res()) : res())),
});

function parse(text: string | null): AppData | null {
  if (!text) return null;
  try { return JSON.parse(text) as AppData; } catch { return null; }
}

export function createCloudRepository(): Repository {
  const cs = cloudStorage ? cloud(cloudStorage) : null;
  const chunksCount: Partial<Record<Collection, number>> = {};
  const queues: Partial<Record<Collection, Promise<void>>> = {};

  const readLocal = (): AppData | null => {
    const parts = COLLECTIONS.map((c) => [c, ls.get(c)] as const);
    if (parts.every(([, v]) => v === null)) return null;
    return Object.fromEntries(parts.map(([c, v]) => [c, parse(v) ?? empty(c)])) as unknown as AppData;
  };

  return {
    loadCached: readLocal,

    // Отметка в хранилище: в Telegram — только в облаке (у каждого бота своё), вне Telegram — в браузере.
    async flag(name) {
      if (!cs) return ls.get(name) === "1";
      return (await cs.get([name]))[name] === "1";
    },
    async setFlag(name) {
      if (cs) await cs.set(name, "1"); else ls.set(name, "1");
    },

    async load() {
      if (!cs) return readLocal();
      const counts = await cs.get([...COLLECTIONS.map((c) => `${c}_n`), CHECKED]);
      // Облако пусто. Если оно уже сверялось с копией на сервере — берём локальную копию, как раньше. Если нет (первый
      // запуск в этом боте) — локальной не доверяем: она могла остаться от другого аккаунта Telegram на этом телефоне
      // или устареть; данные придут из копии на сервере.
      if (COLLECTIONS.every((c) => !counts[`${c}_n`])) return counts[CHECKED] === "1" ? readLocal() : null;
      // Все куски всех коллекций — одним запросом (раньше было пять последовательных, это заметно тормозило старт).
      const keys: string[] = [];
      for (const c of COLLECTIONS) {
        const n = Number(counts[`${c}_n`] || 0);
        chunksCount[c] = n;
        for (let i = 0; i < n; i++) keys.push(`${c}_${i}`);
      }
      const chunks = keys.length ? await cs.get(keys) : {};
      const out: Partial<AppData> = {};
      for (const c of COLLECTIONS) {
        const text = Array.from({ length: chunksCount[c] ?? 0 }, (_, i) => chunks[`${c}_${i}`] ?? "").join("");
        // Куски в облаке могли не сойтись (чтение между записями) — тогда берём локальную копию, а не пустой список:
        // иначе пустая коллекция тут же сохранилась бы обратно, и задачи с заметками пропали бы.
        const parsed = parse(text);
        (out as Record<string, unknown>)[c] = parsed ?? parse(ls.get(c)) ?? empty(c);
        if (parsed) ls.set(c, text);
      }
      return out as AppData;
    },

    async save(collection, items) {
      const text = JSON.stringify(items);
      ls.set(collection, text);
      if (!cs) return;
      // Записи одной коллекции — по очереди: два одновременных сохранения перемешивали куски, и облако переставало читаться.
      const run = async () => {
        const n = Math.ceil(text.length / CHUNK) || 1;
        for (let i = 0; i < n; i++) await cs.set(`${collection}_${i}`, text.slice(i * CHUNK, (i + 1) * CHUNK));
        await cs.set(`${collection}_n`, String(n));
        const old = chunksCount[collection] ?? 0;
        if (old > n) await cs.remove(Array.from({ length: old - n }, (_, i) => `${collection}_${n + i}`));
        chunksCount[collection] = n;
      };
      const q = (queues[collection] ?? Promise.resolve()).catch(() => {}).then(run);
      queues[collection] = q;
      return q;
    },
  };
}
