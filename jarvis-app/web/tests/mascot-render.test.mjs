// DES-005: поза по состоянию и спрайты Дуси и Вари — без браузера, на синтетических состояниях.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { poseFor } from "../src/components/assistant/pose.ts";
import { EYES, spriteFor } from "../src/components/assistant/sprites.ts";
import { resolveAssistantPresentation } from "../src/theme/assistant-state.ts";

const STATUSES = ["reauth", "error", "offline", "connecting", "syncing", "thinking", "urgent", "overdue", "completed", "soon", "ready", "empty", "unknown"];
const LEVELS = ["urgent", "overdue", "soon", "calm", "unknown", "none"];

describe("спрайты", () => {
  for (const character of ["dusya", "varya"]) {
    for (const dark of [false, true]) for (const nightcap of [false, true]) {
      it(`${character}, ${dark ? "тёмная" : "светлая"}${nightcap ? ", колпак" : ""}: все кадры глаз на месте`, () => {
        const s = spriteFor(character, { dark, nightcap });
        assert.equal(s.character, character);
        for (const e of EYES) assert.ok(s.svg.includes(`data-eye="${e}"`), e);
        assert.ok(s.svg.includes('class="owl-rig"'));
      });
    }
  }
  it("неизвестный персонаж — базовая Дуся, а не пустое место", () => {
    const s = spriteFor("penguin", { dark: false, nightcap: false });
    assert.equal(s.character, "dusya");
    assert.ok(s.svg.length > 1000);
  });
  it("у Вари свой id фильтра обводки — несколько ворон на странице не мешают друг другу", () => {
    const a = spriteFor("varya", { dark: false, nightcap: false, ringId: "r1" }).svg;
    assert.ok(a.includes('id="r1"') && a.includes("url(#r1)"));
  });
  it("в спрайтах нет внешних ресурсов и скриптов", () => {
    for (const c of ["dusya", "varya"]) {
      const svg = spriteFor(c, { dark: true, nightcap: true }).svg;
      assert.doesNotMatch(svg, /<script|href=|https?:/);
    }
  });
});

describe("поза по состоянию", () => {
  for (const character of ["dusya", "varya"]) {
    const available = new Set(spriteFor(character, { dark: false, nightcap: false }).props);
    for (const status of STATUSES) for (const level of LEVELS) {
      it(`${character} ${status}/${level}: кадры глаз и значки есть у персонажа`, () => {
        const pose = poseFor({ status, character, urgency: { level } });
        for (const e of [...pose.frames, pose.rest]) assert.ok(EYES.includes(e), e);
        for (const p of [...pose.props, ...pose.props2]) assert.ok(available.has(p), `${character} не умеет значок ${p}`);
      });
    }
  }
  it("мысль у Дуси — лампочка, у Вари — пузырьки", () => {
    assert.deepEqual(poseFor({ status: "thinking", character: "dusya", urgency: null }).props2, ["idea"]);
    assert.deepEqual(poseFor({ status: "thinking", character: "varya", urgency: null }).props2, ["bubbles"]);
  });
  it("срочно — паника с восклицательным знаком; просрочено — без паники", () => {
    assert.equal(poseFor({ status: "urgent", character: "varya", urgency: null }).anim, "panic");
    assert.notEqual(poseFor({ status: "overdue", character: "varya", urgency: null }).anim, "panic");
  });
  it("представление из DES-004 целиком подходит рендереру", () => {
    const now = Date.UTC(2026, 9, 25, 9, 0);
    const p = resolveAssistantPresentation({
      spaceId: "hse", nowMs: now, timeZone: "Europe/Moscow", availability: "ready", activity: "idle",
      snapshot: { spaceId: "hse", updatedAt: now, stale: false, deadlines: [{ id: "a", title: "Отчёт", dueMs: now + 3600e3, done: false }] },
      recentEvent: null, preferences: { seasonal: true, motion: "system" }, reducedMotion: false, lite: false, visible: true,
    });
    const pose = poseFor(p);
    assert.equal(p.character, "varya");
    assert.deepEqual(pose.props2, ["excl", "sweat"]);
  });
});
