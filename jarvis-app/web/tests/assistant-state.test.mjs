// DES-004: поведение маскота на фиксированных часах и синтетических данных (без браузера и backend).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REACTION_WINDOW_MS, resolveAssistantPresentation } from "../src/theme/assistant-state.ts";

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
// 25 октября 2026, 12:00 по Москве.
const NOW = Date.UTC(2026, 9, 25, 9, 0);

function ctx(over = {}) {
  const spaceId = over.spaceId ?? "hse";
  return {
    spaceId,
    nowMs: NOW,
    timeZone: "Europe/Moscow",
    availability: "ready",
    activity: "idle",
    snapshot: { spaceId, updatedAt: NOW - 5 * MIN, stale: false, deadlines: [] },
    recentEvent: null,
    preferences: { seasonal: true, motion: "system" },
    reducedMotion: false,
    lite: false,
    visible: true,
    ...over,
  };
}
const withDeadlines = (deadlines, over = {}) => {
  const c = ctx(over);
  return { ...c, snapshot: { ...c.snapshot, deadlines, ...(over.snapshotOver ?? {}) } };
};
const dl = (id, leftMs, extra = {}) => ({ id, title: "Работа " + id, dueMs: leftMs === null ? null : NOW + leftMs, done: false, ...extra });
const resolve = (c) => resolveAssistantPresentation(c);

describe("маскот зависит от вуза", () => {
  it("ВШЭ — ворона Варя, МИСИС — сова Дуся, неизвестный вуз — Дуся", () => {
    assert.equal(resolve(ctx({ spaceId: "hse" })).character, "varya");
    assert.equal(resolve(ctx({ spaceId: "misis" })).character, "dusya");
    assert.equal(resolve(ctx({ spaceId: "cu" })).character, "dusya");
  });
  it("реплики у персонажей свои", () => {
    const hse = resolve(withDeadlines([dl("a", 2 * HOUR)], { spaceId: "hse" }));
    const misis = resolve(withDeadlines([dl("a", 2 * HOUR)], { spaceId: "misis" }));
    assert.match(hse.text, /^Кар!/);
    assert.doesNotMatch(misis.text, /Кар/);
  });
});

describe("срочность и границы", () => {
  it("ровно 24 ч — urgent, на минуту больше — soon", () => {
    assert.equal(resolve(withDeadlines([dl("a", DAY)])).status, "urgent");
    assert.equal(resolve(withDeadlines([dl("a", DAY + MIN)])).status, "soon");
  });
  it("ровно 72 ч — soon, на минуту больше — ready (спокойно)", () => {
    assert.equal(resolve(withDeadlines([dl("a", 3 * DAY)])).status, "soon");
    const calm = resolve(withDeadlines([dl("a", 3 * DAY + MIN)]));
    assert.equal(calm.status, "ready");
    assert.equal(calm.urgency.level, "calm");
  });
  it("срок в полночь по Москве считается как 23:59 накануне", () => {
    // 27 октября 00:00 МСК = 26 октября 21:00 UTC; до него 24 ч 30 с — но фактически 23:59, то есть меньше суток.
    const midnight = Date.UTC(2026, 9, 26, 21, 0);
    const c = withDeadlines([{ id: "m", title: "Отчёт", dueMs: midnight, done: false }], { nowMs: midnight - DAY - 30e3 });
    assert.equal(resolve(c).status, "urgent");
  });
  it("срок наступил — overdue, без огня", () => {
    const p = resolve(withDeadlines([dl("a", 0)]));
    assert.equal(p.status, "overdue");
    assert.equal(p.accent, "none");
    assert.doesNotMatch(p.text, /виноват|опять/i);
  });
  it("urgent включает огонь, soon — тёплый акцент", () => {
    assert.equal(resolve(withDeadlines([dl("a", HOUR)])).accent, "fire");
    assert.equal(resolve(withDeadlines([dl("a", 2 * DAY)])).accent, "warm");
  });
  it("сданная работа огонь не включает", () => {
    const p = resolve(withDeadlines([dl("a", HOUR, { done: true })]));
    assert.equal(p.accent, "none");
    assert.equal(p.urgency.level, "none");
  });
  it("срочная важнее просроченной", () => {
    const p = resolve(withDeadlines([dl("late", -HOUR), dl("hot", 5 * HOUR)]));
    assert.equal(p.status, "urgent");
    assert.equal(p.action.deadlineId, "hot");
  });
});

describe("несколько работ", () => {
  it("одна выбранная работа и счётчик, ближайшая по сроку", () => {
    const p = resolve(withDeadlines([dl("b", 10 * HOUR), dl("a", 3 * HOUR), dl("c", 20 * HOUR)]));
    assert.equal(p.urgency.deadlineId, "a");
    assert.equal(p.urgency.count, 3);
    assert.match(p.text, /ещё 2/);
  });
  it("одинаковые сроки выбираются стабильно по ID, независимо от порядка", () => {
    const one = resolve(withDeadlines([dl("z", 5 * HOUR), dl("k", 5 * HOUR)]));
    const two = resolve(withDeadlines([dl("k", 5 * HOUR), dl("z", 5 * HOUR)]));
    assert.equal(one.urgency.deadlineId, "k");
    assert.deepEqual(one, two);
  });
  it("среди просроченных — самая свежая просрочка", () => {
    const p = resolve(withDeadlines([dl("old", -10 * DAY), dl("recent", -2 * HOUR)]));
    assert.equal(p.urgency.deadlineId, "recent");
  });
});

describe("нет данных — не значит «всё сдано»", () => {
  it("неизвестный срок: без выдуманного countdown", () => {
    const p = resolve(withDeadlines([dl("x", null), dl("y", Number.NaN)]));
    assert.equal(p.status, "ready");
    assert.equal(p.urgency.level, "unknown");
    assert.equal(p.urgency.dueMs, null);
    assert.match(p.text, /не указан срок/);
  });
  it("снимка нет — unknown, без действия", () => {
    const p = resolve(ctx({ snapshot: null }));
    assert.equal(p.status, "unknown");
    assert.equal(p.action, null);
    assert.equal(p.urgency, null);
  });
  it("ничего не подключено — empty и кнопка подключения", () => {
    const p = resolve(ctx({ availability: "empty", snapshot: null }));
    assert.equal(p.status, "empty");
    assert.equal(p.action.intent, "connect");
  });
  it("все работы сданы — отдельный текст, не empty", () => {
    const p = resolve(withDeadlines([dl("a", HOUR, { done: true })]));
    assert.equal(p.status, "ready");
    assert.match(p.text, /Открытых работ нет/);
  });
});

describe("ошибки и операции первичны", () => {
  it("reauth + срочная работа: просьба войти, срок остаётся бейджем и помечен устаревшим", () => {
    const p = resolve(withDeadlines([dl("a", 2 * HOUR)], { availability: "reauth", snapshotOver: { stale: true } }));
    assert.equal(p.status, "reauth");
    assert.equal(p.action.intent, "reauth");
    assert.equal(p.accent, "none");
    assert.equal(p.urgency.level, "urgent");
    assert.equal(p.urgency.stale, true);
  });
  it("ошибка обновления со старым снимком: retry и stale, без «всё сделано»", () => {
    const p = resolve(withDeadlines([], { availability: "error", snapshotOver: { stale: true } }));
    assert.equal(p.status, "error");
    assert.equal(p.action.intent, "retry");
    assert.doesNotMatch(p.text, /нет|сдано/i);
  });
  it("offline различим с error", () => {
    assert.equal(resolve(ctx({ availability: "offline" })).status, "offline");
  });
  it("операции: connecting, syncing, thinking различимы; поиск называет вуз", () => {
    assert.equal(resolve(ctx({ activity: "connecting" })).status, "connecting");
    assert.equal(resolve(ctx({ activity: "syncing" })).status, "syncing");
    const t = resolve(ctx({ activity: "thinking" }));
    assert.equal(t.status, "thinking");
    assert.equal(t.text, "Ищу в ВШЭ…");
    assert.equal(t.action.intent, "open-chat");
  });
  it("операция важнее срочной работы, но срок виден в сводке", () => {
    const p = resolve(withDeadlines([dl("a", HOUR)], { activity: "syncing" }));
    assert.equal(p.status, "syncing");
    assert.equal(p.urgency.level, "urgent");
  });
  it("устаревший снимок помечается в тексте срочной работы", () => {
    const p = resolve(withDeadlines([dl("a", HOUR)], { snapshotOver: { stale: true } }));
    assert.equal(p.status, "urgent");
    assert.match(p.text, /устареть/);
  });
});

describe("реакция на сдачу", () => {
  const done = (at, over = {}) => ({ recentEvent: { id: "ev1", spaceId: "hse", kind: "deadline-completed", at }, ...over });
  it("свежее событие — один раз, статус completed и следующая работа", () => {
    const p = resolve(withDeadlines([dl("next", 5 * DAY)], done(NOW - 500)));
    assert.equal(p.status, "completed");
    assert.deepEqual(p.reaction, { eventId: "ev1" });
    assert.equal(p.action.deadlineId, "next");
  });
  it("после окна реакции (например, после reload) не проигрывается", () => {
    const p = resolve(withDeadlines([], done(NOW - REACTION_WINDOW_MS - 1)));
    assert.equal(p.reaction, null);
    assert.notEqual(p.status, "completed");
  });
  it("уже показанное событие не повторяется", () => {
    const p = resolve(withDeadlines([], done(NOW - 100, { acknowledgedEventIds: ["ev1"] })));
    assert.equal(p.reaction, null);
  });
  it("событие из будущего не проигрывается", () => {
    assert.equal(resolve(withDeadlines([], done(NOW + 1000))).reaction, null);
  });
  it("не перекрывает reauth/offline/error", () => {
    for (const availability of ["reauth", "offline", "error"]) {
      const p = resolve(withDeadlines([], done(NOW - 100, { availability })));
      assert.equal(p.reaction, null, availability);
      assert.equal(p.status, availability);
    }
  });
  it("рядом со срочной работой: первичен срок, реакция второстепенная", () => {
    const p = resolve(withDeadlines([dl("hot", HOUR)], done(NOW - 100)));
    assert.equal(p.status, "urgent");
    assert.deepEqual(p.reaction, { eventId: "ev1" });
  });
});

describe("смена вуза", () => {
  it("снимок другого вуза отбрасывается: unknown, без старого названия и действия", () => {
    const c = withDeadlines([dl("misis-lab", HOUR)], { spaceId: "misis" });
    const switched = { ...c, spaceId: "hse" }; // ВШЭ выбран, а снимок ещё от МИСИС
    const p = resolve(switched);
    assert.equal(p.status, "unknown");
    assert.equal(p.urgency, null);
    assert.equal(p.action, null);
    assert.doesNotMatch(p.text, /misis-lab|Работа/);
    assert.equal(p.character, "varya");
  });
  it("событие сдачи из другого вуза не проигрывается", () => {
    const p = resolve(withDeadlines([], { recentEvent: { id: "e", spaceId: "misis", kind: "deadline-completed", at: NOW - 100 } }));
    assert.equal(p.reaction, null);
  });
});

describe("движение", () => {
  it("обычный режим — full", () => assert.equal(resolve(ctx()).motion, "full"));
  it("reduced, облегчённый и спокойный режимы — static с тем же смыслом", () => {
    const base = resolve(withDeadlines([dl("a", HOUR)]));
    for (const over of [{ reducedMotion: true }, { lite: true }, { preferences: { seasonal: true, motion: "calm" } }]) {
      const p = resolve(withDeadlines([dl("a", HOUR)], over));
      assert.equal(p.motion, "static");
      assert.equal(p.text, base.text);
      assert.equal(p.accent, "fire");
      assert.deepEqual(p.action, base.action);
    }
  });
  it("скрытая вкладка — paused", () => assert.equal(resolve(ctx({ visible: false })).motion, "paused"));
});

describe("детерминированность", () => {
  it("одни входы — один результат, входы не меняются", () => {
    const c = withDeadlines([dl("b", HOUR), dl("a", 2 * DAY)]);
    const frozen = JSON.stringify(c);
    assert.deepEqual(resolve(c), resolve(structuredClone(c)));
    assert.equal(JSON.stringify(c), frozen);
  });
});
