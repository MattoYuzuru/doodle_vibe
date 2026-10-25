// DES-010: адаптер «ответ /api/v1 → экраны и маскот» на синтетических ответах и фиксированных часах.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assistantConfig, characterFor, freshness, toAssistantContext, toDeadlines, toLessons, toSubjects } from "../src/lib/space-adapter.ts";
import { resolveAssistantPresentation } from "../src/theme/assistant-state.ts";

const NOW = Date.UTC(2026, 9, 25, 9, 0); // 12:00 МСК
const iso = (t) => new Date(t).toISOString();
const HOUR = 3600e3;
const hse = { id: "s-hse", universityId: "hse", name: "ВШЭ", createdAt: iso(NOW) };
const misis = { id: "s-misis", universityId: "misis", name: "МИСИС", createdAt: iso(NOW) };
const conn = (status = "ready", id = "c1") => ({ id, spaceId: hse.id, sourceUrl: "https://lms.example.test/", kind: "lms", label: "LMS", status, errorCode: null, adapterId: null, createdAt: iso(NOW), updatedAt: iso(NOW) });
const section = (items, { stale = false, connections = [conn()] } = {}) => ({ items, sources: [{ connectionId: "c1", fetchedAt: iso(NOW - HOUR), stale }], connections });
const item = (id, extra) => ({ id, externalId: id, connectionId: "c1", title: "Работа " + id, url: "https://lms.example.test/" + id, sourceUrl: "https://lms.example.test/", fetchedAt: iso(NOW - HOUR), ...extra });
const data = (over = {}) => ({ spaceId: hse.id, status: "ready", error: null, deadlines: section([item("a", { dueAt: iso(NOW + 3 * HOUR) })]), schedule: section([]), courses: section([]), loadedAt: NOW, ...over });
const env = { nowMs: NOW, reducedMotion: false, lite: false, visible: true, acknowledged: [] };
const present = (space, d) => resolveAssistantPresentation(toAssistantContext(space, d, env), assistantConfig([hse, misis]));

describe("персонаж по вузу", () => {
  it("ВШЭ — Варя, МИСИС и другие — Дуся", () => {
    assert.equal(characterFor(hse), "varya");
    assert.equal(characterFor({ universityId: "x", name: "Высшая школа экономики" }), "varya");
    assert.equal(characterFor(misis), "dusya");
    assert.equal(characterFor({ universityId: "cu", name: "ЦУ" }), "dusya");
  });
});

describe("данные для экранов", () => {
  it("работы со сроком становятся дедлайнами с префиксом вуза; без срока — нет", () => {
    const d = toDeadlines(hse.id, section([item("a", { dueAt: iso(NOW + HOUR) }), item("b", {}), item("c", { dueAt: "не дата" })]));
    assert.equal(d.length, 1);
    assert.equal(d[0].id, "space:s-hse:c1:a");
    assert.equal(d[0].url, "https://lms.example.test/a");
  });
  it("одинаковый внешний ID в двух вузах не совпадает", () => {
    const a = toDeadlines(hse.id, section([item("same", { dueAt: iso(NOW) })]));
    const b = toDeadlines(misis.id, section([item("same", { dueAt: iso(NOW) })]));
    assert.notEqual(a[0].id, b[0].id);
  });
  it("пары — по московскому времени, отсортированы", () => {
    const l = toLessons(section([
      item("2", { startsAt: "2026-10-26T07:30:00Z", endsAt: "2026-10-26T08:50:00Z", location: "R205" }),
      item("1", { startsAt: "2026-10-25T21:00:00Z", endsAt: "2026-10-25T22:20:00Z" }),
    ]));
    assert.deepEqual(l.map((x) => [x.date, x.start, x.end]), [["2026-10-26", "00:00", "01:20"], ["2026-10-26", "10:30", "11:50"]]);
    assert.equal(l[1].place, "R205");
  });
  it("курсы — предметы с коротким именем", () => {
    const s = toSubjects(hse.id, section([item("m", { title: "Математический анализ", courseId: "42" })]));
    assert.equal(s[0].short, "МА");
    assert.equal(s[0].id, "space:s-hse:c1:course:42");
  });
  it("свежесть — по времени снимков; устаревший источник помечается", () => {
    assert.deepEqual(freshness(data()), { updatedAt: NOW - HOUR, stale: false });
    assert.equal(freshness(data({ deadlines: section([], { stale: true }) })).stale, true);
  });
});

describe("состояние маскота из данных вуза", () => {
  it("срочная работа ВШЭ — Варя с огнём и ссылкой на работу", () => {
    const p = present(hse, data());
    assert.equal(p.character, "varya");
    assert.equal(p.status, "urgent");
    assert.equal(p.accent, "fire");
    assert.equal(p.action.deadlineId, "space:s-hse:c1:a");
  });
  it("пока грузится — бег, не «всё сдано» и не данные прежнего вуза", () => {
    const loading = { spaceId: hse.id, status: "loading", error: null, deadlines: null, schedule: null, courses: null, loadedAt: null };
    assert.equal(present(hse, loading).status, "syncing");
    const p = present(hse, data({ spaceId: misis.id }));
    assert.equal(p.urgency, null);
    assert.notEqual(p.status, "urgent");
  });
  it("нет подключений — empty с кнопкой подключения", () => {
    const p = present(hse, data({ deadlines: section([], { connections: [] }) }));
    assert.equal(p.status, "empty");
    assert.equal(p.action.intent, "connect");
  });
  it("нужен вход — reauth, срок остаётся в сводке", () => {
    const p = present(hse, data({ deadlines: section([item("a", { dueAt: iso(NOW + 2 * HOUR) })], { connections: [conn("user_action_required")] }) }));
    assert.equal(p.status, "reauth");
    assert.equal(p.urgency.level, "urgent");
  });
  it("ошибка обновления — старые данные видны как устаревшие", () => {
    const p = present(hse, data({ status: "error", error: { kind: "error", code: "INTERNAL_ERROR" } }));
    assert.equal(p.status, "error");
    assert.equal(p.urgency.stale, true);
    assert.equal(p.urgency.level, "urgent");
  });
  it("нет связи — offline", () => {
    assert.equal(present(hse, data({ status: "error", error: { kind: "offline", code: "OFFLINE" } })).status, "offline");
  });
  it("подключение ещё проверяется — бег, срок в сводке", () => {
    const p = present(hse, data({ deadlines: section([item("a", { dueAt: iso(NOW + 2 * HOUR) })], { connections: [conn("ready"), conn("pending", "c2")] }) }));
    assert.equal(p.status, "syncing");
    assert.equal(p.urgency.level, "urgent");
  });
});

describe("движение (DES-009)", () => {
  const ctx = (over) => resolveAssistantPresentation(toAssistantContext(hse, data(), { ...env, ...over }), assistantConfig([hse]));
  it("спокойный маскот — static, огонь-знак и действие остаются", () => {
    const p = ctx({ calm: true });
    assert.equal(p.motion, "static");
    assert.equal(p.accent, "fire");
    assert.equal(p.action.intent, "open-deadline");
  });
  it("скрытая вкладка — paused, «уменьшить движение» и облегчённый режим — static", () => {
    assert.equal(ctx({ visible: false }).motion, "paused");
    assert.equal(ctx({ reducedMotion: true }).motion, "static");
    assert.equal(ctx({ lite: true }).motion, "static");
    assert.equal(ctx({}).motion, "full");
  });
});
