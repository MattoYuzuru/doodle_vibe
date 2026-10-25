// DES-006: «горит дедлайн», реакция на сдачу во времени и бег на месте при загрузке — на фиксированных часах.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { poseFor } from "../src/components/assistant/pose.ts";
import { spriteFor } from "../src/components/assistant/sprites.ts";
import { REACTION_WINDOW_MS, resolveAssistantPresentation } from "../src/theme/assistant-state.ts";

const MIN = 60e3, HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 25, 9, 0);
const base = (over = {}) => ({
  spaceId: "hse", nowMs: T0, timeZone: "Europe/Moscow", availability: "ready", activity: "idle",
  snapshot: { spaceId: "hse", updatedAt: T0, stale: false, deadlines: [] }, recentEvent: null,
  preferences: { seasonal: true, motion: "system" }, reducedMotion: false, lite: false, visible: true, ...over,
});
const snap = (deadlines, spaceId = "hse") => ({ snapshot: { spaceId, updatedAt: T0, stale: false, deadlines } });
const work = (id, left, done = false) => ({ id, title: "Работа " + id, dueMs: T0 + left, done });
const show = (c) => resolveAssistantPresentation(c);

describe("огонь", () => {
  it("urgent включает огонь, после сдачи огня нет", () => {
    assert.equal(show(base(snap([work("a", 3 * HOUR)]))).accent, "fire");
    assert.equal(show(base(snap([work("a", 3 * HOUR, true)]))).accent, "none");
  });
  it("просрочено подписано отдельно и без огня", () => {
    const p = show(base(snap([work("a", -HOUR)])));
    assert.equal(p.status, "overdue");
    assert.equal(p.accent, "none");
    assert.equal(p.urgency.level, "overdue");
  });
  it("несколько срочных работ — один маскот: одна выбранная работа и счётчик", () => {
    const p = show(base(snap([work("a", 2 * HOUR), work("b", 3 * HOUR), work("c", 4 * HOUR)])));
    assert.equal(p.accent, "fire");
    assert.equal(p.urgency.count, 3);
    assert.equal(p.action.deadlineId, "a");
  });
  it("при ошибке огня нет, но срочная работа остаётся в сводке для бейджа", () => {
    const p = show(base({ availability: "error", ...snap([work("a", 2 * HOUR)]) }));
    assert.equal(p.accent, "none");
    assert.equal(p.urgency.level, "urgent");
  });
  it("в спокойном режиме огонь остаётся (статичный знак)", () => {
    for (const over of [{ reducedMotion: true }, { lite: true }, { preferences: { seasonal: true, motion: "calm" } }]) {
      const p = show(base({ ...over, ...snap([work("a", 2 * HOUR)]) }));
      assert.equal(p.accent, "fire");
      assert.equal(p.motion, "static");
    }
  });
});

describe("реакция на сдачу во времени", () => {
  // Открытая срочная работа a и спокойная b; в момент T0 студент сдал a.
  const after = (ms, extra = {}) => base({
    nowMs: T0 + ms, ...snap([work("a", 2 * HOUR, true), work("b", 5 * 24 * HOUR)]),
    recentEvent: { id: "done-a", spaceId: "hse", kind: "deadline-completed", at: T0 }, ...extra,
  });
  it("сразу после сдачи — одна реакция, огонь погас", () => {
    const p = show(after(200));
    assert.equal(p.status, "completed");
    assert.deepEqual(p.reaction, { eventId: "done-a" });
    assert.equal(p.accent, "none");
  });
  it("показанная реакция больше не проигрывается", () => {
    assert.equal(show(after(400, { acknowledgedEventIds: ["done-a"] })).reaction, null);
  });
  it("reload после окна реакции — без повтора", () => {
    const p = show(after(REACTION_WINDOW_MS + 1));
    assert.equal(p.reaction, null);
    assert.equal(p.status, "ready");
  });
  it("смена вуза сразу убирает реакцию прежнего", () => {
    const p = show(after(200, { spaceId: "misis" }));
    assert.equal(p.reaction, null);
    assert.equal(p.status, "unknown");
    assert.equal(p.character, "dusya");
  });
  it("рядом с другой срочной работой улыбка в первом кадре, дальше снова срочность", () => {
    const p = show(base({ ...snap([work("a", 2 * HOUR)]), recentEvent: { id: "x", spaceId: "hse", kind: "deadline-completed", at: T0 - 100 } }));
    const pose = poseFor(p);
    assert.equal(p.status, "urgent");
    assert.equal(pose.frames[0], "happy");
    assert.deepEqual(pose.props2, ["excl", "sweat"]);
  });
});

describe("загрузка: бег на месте", () => {
  it("подключение, обновление и загрузка — бег; поиск ответа — нет", () => {
    for (const over of [{ activity: "connecting" }, { activity: "syncing" }, { snapshot: null }]) {
      assert.equal(poseFor(show(base(over))).running, true, JSON.stringify(over));
    }
    assert.equal(poseFor(show(base({ activity: "thinking" }))).running, false);
    assert.equal(poseFor(show(base(snap([work("a", HOUR)])))).running, false);
  });
  it("у обоих персонажей есть два кадра бега, а без бега спрайт прежний", () => {
    for (const c of ["dusya", "varya"]) {
      const run = spriteFor(c, { dark: false, nightcap: false, running: true }).svg;
      assert.ok(run.includes('class="owl-run-a"') && run.includes('class="owl-run-b"'), c);
      const still = spriteFor(c, { dark: false, nightcap: false }).svg;
      assert.ok(!still.includes("owl-run-"), c);
    }
  });
});
