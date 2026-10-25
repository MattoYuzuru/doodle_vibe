// Вход через удалённый браузер (ADR-0005, задача C): адрес потока, координаты, клавиши и тексты — без сети и DOM.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MFA_CODE, STATUS_TEXT, clipText, isSpecialKey, isTerminal, mmss, mouseButton, secondsLeft, streamUrl, toFramePoint } from "../src/lib/remote-login.ts";
import { sourceError, sourceProblem } from "../src/lib/sources.ts";

describe("адрес потока", () => {
  it("https → wss, тот же сервер, тикет параметром", () => {
    assert.equal(streamUrl("https://doodle.example.test/", { path: "/api/v1/login/L1/stream", ticket: "t-1" }), "wss://doodle.example.test/api/v1/login/L1/stream?ticket=t-1");
  });
  it("http → ws и приложение в подкаталоге", () => {
    assert.equal(streamUrl("http://127.0.0.1:5173/app/", { path: "/api/v1/login/L1/stream", ticket: "a b" }), "ws://127.0.0.1:5173/app/api/v1/login/L1/stream?ticket=a+b");
  });
});

describe("координаты и ввод", () => {
  const rect = { left: 10, top: 20, width: 240, height: 450 };
  const frame = { width: 480, height: 900 };
  it("показанная картинка вдвое меньше кадра — координаты умножаются", () => {
    assert.deepEqual(toFramePoint(130, 245, rect, frame), { x: 240, y: 450 });
  });
  it("за краем картинки — прижимаются к кадру", () => {
    assert.deepEqual(toFramePoint(-50, 9999, rect, frame), { x: 0, y: 899 });
  });
  it("управляющие клавиши — key, печатные — text", () => {
    assert.equal(isSpecialKey("Enter"), true);
    assert.equal(isSpecialKey("Backspace"), true);
    assert.equal(isSpecialKey("a"), false);
    assert.equal(isSpecialKey("Ж"), false);
  });
  it("кнопки мыши", () => assert.deepEqual([0, 1, 2].map(mouseButton), ["left", "middle", "right"]));
  it("вставка не длиннее 4 КБ и не режет символ пополам", () => {
    const t = clipText("ж".repeat(3000));
    assert.equal(new TextEncoder().encode(t).length, 4096);
    assert.equal(clipText("abc"), "abc");
  });
});

describe("состояния и коды", () => {
  it("терминальные состояния", () => {
    assert.deepEqual(["succeeded", "failed", "cancelled", "expired", "awaiting_user"].map(isTerminal), [true, true, true, true, false]);
  });
  it("у каждого состояния есть текст", () => {
    for (const s of ["starting", "awaiting_user", "filling", "awaiting_mfa", "capturing", "succeeded", "failed", "cancelled", "expired"]) assert.ok(STATUS_TEXT[s], s);
  });
  it("код MFA по контракту", () => {
    assert.ok(MFA_CODE.test("123456"));
    assert.ok(MFA_CODE.test("AB-12 34"));
    assert.ok(!MFA_CODE.test("12"));
    assert.ok(!MFA_CODE.test("123456;DROP"));
  });
  it("таймер", () => {
    assert.equal(secondsLeft(new Date(10_000 + 270_000).toISOString(), 10_000), 270);
    assert.equal(mmss(270), "4:30");
    assert.equal(secondsLeft(new Date(0).toISOString(), 10_000), 0);
  });
  it("коды входа понятными словами", () => {
    for (const c of ["source_session_expired", "source_login_failed", "source_bot_protection", "source_login_unrecognized", "source_login_form_ambiguous", "mfa_failed", "mfa_expired", "login_credentials_lost"]) {
      assert.doesNotMatch(sourceError(c), /\(/, c);
    }
    assert.equal(sourceProblem("source_session_expired"), "Нужен вход заново");
  });
});
