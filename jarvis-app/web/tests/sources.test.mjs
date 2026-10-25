// Коды источников словами и ссылка на экран «Вузы» — единственное место подключения (задача C, #22).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sourceError, sourceProblem, universitiesLink } from "../src/lib/sources.ts";

describe("коды ошибок источников", () => {
  it("понятные слова вместо кода; незнакомый код показывается как есть", () => {
    assert.match(sourceError("source_network_restricted"), /сети вуза/);
    assert.match(sourceError("source_identifier_ambiguous"), /несколько/);
    assert.match(sourceError("source_something_new"), /source_something_new/);
    for (const c of ["source_session_expired", "source_login_failed", "source_bot_protection", "source_login_unrecognized", "source_login_form_ambiguous", "mfa_failed", "mfa_expired", "login_credentials_lost", "source_unavailable", "source_timeout", "source_rate_limited", "source_format_changed", "source_recipe_invalid", "source_response_invalid"]) {
      assert.doesNotMatch(sourceError(c), /\(/, c);
    }
  });
  it("короткие подписи для списка источников", () => {
    assert.equal(sourceProblem("source_network_restricted"), "Только из сети вуза");
    assert.equal(sourceProblem("source_session_expired"), "Нужен вход заново");
    assert.equal(sourceProblem(null), null);
  });
});

describe("ссылка на экран «Вузы»", () => {
  it("раздел по вузу; свой вуз — custom; без вуза — общий экран", () => {
    assert.deepEqual(["hse", "misis", "cu", "my-uni"].map(universitiesLink), ["#/universities/hse", "#/universities/misis", "#/universities/cu", "#/universities/custom"]);
    assert.equal(universitiesLink(null), "#/universities");
  });
});
