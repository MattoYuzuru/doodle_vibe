// Подключение источников: готовые адреса вузов совпадают с backend, тело входа — ровно одна форма, коды → слова.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UNIVERSITY_PRESETS, describeAuthMethods } from "../../../backend/src/sources/presets.mjs";
import { AUTH_NOTES, SOURCE_PRESETS, authBody, authReady, sourceError, sourceProblem } from "../src/lib/sources.ts";

describe("готовые источники вузов", () => {
  it("адреса frontend совпадают с пресетами backend (presets.mjs)", () => {
    for (const u of UNIVERSITY_PRESETS) {
      const ours = (SOURCE_PRESETS[u.id] ?? []).map((p) => new URL(p.url).origin).sort();
      assert.deepEqual(ours, u.sources.map((s) => s.origin).sort(), u.id);
    }
  });
  it("у каждого кода пояснения из пресетов backend есть слова в интерфейсе", () => {
    for (const u of UNIVERSITY_PRESETS) for (const s of u.sources) {
      for (const m of describeAuthMethods(s.origin)) for (const code of [...(m.notes ?? []), ...(m.note ? [m.note] : [])]) {
        assert.ok(AUTH_NOTES[code], `${s.origin}: нет текста для ${code}`);
      }
    }
  });
  it("для Smart LMS первой идёт ссылка календаря, для РУЗ — идентификатор", () => {
    assert.equal(describeAuthMethods("https://edu.hse.ru")[0].id, "calendar_url");
    assert.equal(describeAuthMethods("https://ruz.hse.ru")[0].id, "ruz_identifier");
  });
});

describe("тело входа", () => {
  const cal = { id: "calendar_url", type: "calendar_url", label: "", fields: ["calendarUrl"] };
  const pwd = { id: "moodle_password", type: "password", label: "", fields: ["username", "password"] };
  it("ровно поля выбранного способа и origin; лишнее не уходит", () => {
    assert.deepEqual(authBody("https://edu.hse.ru", cal, { calendarUrl: "  https://edu.hse.ru/calendar/export_execute.php?x=1  ", password: "лишнее" }),
      { origin: "https://edu.hse.ru", calendarUrl: "https://edu.hse.ru/calendar/export_execute.php?x=1" });
  });
  it("пароль не обрезается, логин — обрезается", () => {
    assert.deepEqual(authBody("https://x.test", pwd, { username: " ivanov ", password: " p@ss " }), { origin: "https://x.test", username: "ivanov", password: " p@ss " });
  });
  it("кнопка доступна, только когда все поля заполнены", () => {
    assert.equal(authReady(pwd, { username: "a" }), false);
    assert.equal(authReady(pwd, { username: "a", password: " " }), true);
    assert.equal(authReady(cal, { calendarUrl: "   " }), false);
  });
});

describe("коды ошибок источников", () => {
  it("понятные слова вместо кода", () => {
    assert.match(sourceError("source_network_restricted"), /сети вуза/);
    assert.match(sourceError("source_identifier_ambiguous"), /несколько/);
    assert.match(sourceError("source_something_new"), /source_something_new/);
    assert.equal(sourceProblem("source_network_restricted"), "Только из сети вуза");
    assert.equal(sourceProblem(null), null);
  });
});
