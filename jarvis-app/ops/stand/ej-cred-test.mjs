// Проверка «пароль журнала хранится» (16 окт 2026, решение владельца: «войти в журнал один раз и всё»): ej.mjs и users.mjs
// на поддельном MISIS ID, журнале и Moodle — без сети и без живых файлов: копия модулей во временной папке (свои users/ и
// users.key). Что проверяется: пароль лежит только зашифрованным и наружу (состояние, журналы сервера) не выходит; вход
// MISIS ID жив — пароль не шлётся; истёк (48 ч) — сервер входит сохранённым паролем сам, и параллельные запросы шлют его
// один раз; MISIS ID пароль не принял — пароль забывается и повторно не шлётся; MISIS ID лежит (5xx) — пароль не
// забывается, повтор с паузой; сбой до формы входа паузы не ставит; вход в бот при неответившем журнале запоминает пароль,
// а неверный — нет; выход и вход другой учётной записью стирают пароль; пароль из чужого файла не открывается.
// Запуск: node ops\stand\ej-cred-test.mjs
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let fails = 0;
const check = (name, ok, info = "") => { fails += ok ? 0 : 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  | ${info}` : ""}`); };
const APP = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");
const PORT = 9933, FAKE = `http://127.0.0.1:${PORT}`;
const TMP = mkdtempSync(join(tmpdir(), "ej-cred-test-"));
const patch = { "https://ej.misis.ru": `${FAKE}/ej`, "https://newlms.misis.ru": `${FAKE}/moodle` };
for (const f of ["ej.mjs", "users.mjs", "moodle-pace.mjs", "state-file.mjs"]) {
  let src = readFileSync(join(APP, f), "utf8");
  for (const [a, b] of Object.entries(patch)) src = src.split(a).join(b);
  // Вход в журнал хранится только для *.misis.ru — поддельный журнал на 127.0.0.1, его cookies тоже оставляем (как ui-sim).
  if (f === "ej.mjs") src = src.split(String.raw`/(^|\.)misis\.ru$/`).join(String.raw`/(^|\.)misis\.ru$|^127\.0\.0\.1$/`);
  writeFileSync(join(TMP, f), src);
}
symlinkSync(join(APP, "node_modules"), join(TMP, "node_modules"), "junction");
Object.assign(process.env, { MOODLE_DIRECT: "0", MOODLE_PACE: "0", MOODLE_PACE_DIR: TMP, EJ_PASS_RETRY_MS: "600" });

// Всё, что модули пишут в журнал сервера, — чтобы проверить, что пароль туда не попадает.
const logged = [];
for (const k of ["log", "error", "warn", "info"]) { const orig = console[k].bind(console); console[k] = (...a) => { logged.push(a.map(String).join(" ")); orig(...a); }; }

/* ---------- поддельные MISIS ID, журнал и Moodle ---------- */
// hydraGen — «вход MISIS ID»: cookie idps=<поколение>; S.hydraGen++ — вход истёк для всех (48 ч прошли). ejGen — то же для
// входа в сам журнал (cookie ejs). posts — все пароли, пришедшие в форму входа.
const S = { pass: "Pw-secret-1", hydraGen: 1, ejGen: 1, posts: [], signinStatus: 0, startBroken: 0, callbackBroken: false, moodle: { u1: "Pw-secret-1", u2: "Pw-other-2" } };
const cookie = (req, name) => (new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.cookie || "") || [])[1];
const STUD = 777;
const fake = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    const url = new URL(req.url, FAKE), p = url.pathname;
    const json = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const html = (code, s) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(s); };
    const go = (loc, set) => { res.writeHead(302, { location: loc, ...(set ? { "set-cookie": set } : {}) }); res.end(); };
    if (p === "/moodle/login/token.php") {
      const f = Object.fromEntries(new URLSearchParams(body));
      return json(S.moodle[f.username] && S.moodle[f.username] === f.password ? { token: `tok-${f.username}` } : { error: "Неверный логин или пароль" });
    }
    if (p === "/moodle/webservice/rest/server.php") {
      const t = new URLSearchParams(body).get("wstoken") || "";
      const who = t.replace(/^tok-/, "");
      return json(S.moodle[who] ? { userid: who === "u1" ? 1 : 2, fullname: `Студент ${who}`, username: who } : { exception: "invalidtoken" });
    }
    if (!p.startsWith("/ej/")) return json({ message: "not found" }, 404);
    const q = p.slice(3);
    const ejOk = cookie(req, "ejs") === String(S.ejGen), idOk = cookie(req, "idps") === String(S.hydraGen);
    if (q === "/auth/signin/misis_id" && req.method === "POST") {
      if (S.startBroken > 0) { S.startBroken--; return go(`${FAKE}/ej/auth/error?error=Configuration`); }
      return go(`${FAKE}/ej/idp/oauth2/auth?client_id=EJ&scope=openid+profile+email`);
    }
    if (q === "/idp/oauth2/auth") {
      if (!idOk) return go(`${FAKE}/ej/idp/auth/signin?login_challenge=abc`);
      if (cookie(req, "consent") !== "1") return go(`${FAKE}/ej/idp/auth/consent?consent_challenge=c1`);
      return go(`${FAKE}/ej/auth/callback/misis_id`);
    }
    if (q === "/idp/auth/signin" && req.method === "GET" && S.formStatus) return html(S.formStatus, "<p>Bad gateway</p>"); // вместо формы — страница ошибки
    if (q === "/idp/auth/signin" && req.method === "GET")
      return html(200, '<form method="POST"><input type="hidden" name="loginChallenge" value="abc"><input value="" type="email" name="email"><input value="" type="password" name="password"><input class="checkbox" type="checkbox" name="remember" value="1" checked><button formaction="/ej/idp/auth/signin?/signin">Войти</button></form>');
    // медленный MISIS ID: S.slow мс на POST формы (S.slowFor — только для этого пароля)
    if (q === "/idp/auth/signin" && req.method === "POST" && S.slow && !req.delayed && (!S.slowFor || new URLSearchParams(body).get("password") === S.slowFor)) { req.delayed = true; S.seen?.push(new URLSearchParams(body).get("password")); return setTimeout(() => req.emit("end"), S.slow); }
    if (q === "/idp/auth/signin" && req.method === "POST") {
      const f = Object.fromEntries(new URLSearchParams(body));
      S.posts.push(f.password);
      if (S.signinStatus) { res.writeHead(S.signinStatus, { "content-type": "text/html; charset=utf-8", ...(S.retryAfter ? { "retry-after": S.retryAfter } : {}) }); return res.end(S.signinBody || "<p>Bad gateway</p>"); }
      if (url.search !== "?/signin" || f.loginChallenge !== "abc") return html(400, '<p class="text-error">Не передан запрос входа</p>');
      // отказ перенаправлением на форму (S.wrongRedirect = "error" — с параметром ошибки перед login_challenge)
      if ((f.email !== "u1" || f.password !== S.pass) && S.wrongRedirect) return go(`${FAKE}/ej/idp/auth/signin?${S.wrongRedirect === "error" ? "error=invalid&" : ""}login_challenge=abc`);
      if (f.email !== "u1" || f.password !== S.pass) return html(400, '<form><p class="text-error">Неверный логин или пароль</p></form>');
      return go(`${FAKE}/ej/idp/oauth2/auth?login_verifier=1`, `idps=${S.hydraGen}; Path=/; HttpOnly`);
    }
    if (q === "/idp/auth/consent" && req.method === "GET")
      return html(200, '<form method="POST"><input type="hidden" name="consentChallenge" value="c1">' + ["openid", "profile", "email"].map((s) => `<input type="checkbox" class="checkbox" name="grantScope" value="${s}">`).join("") + '<button formaction="/ej/idp/auth/consent?/allow">Разрешить</button></form>');
    if (q === "/idp/auth/consent" && req.method === "POST") return go(`${FAKE}/ej/idp/oauth2/auth?consent_verifier=1`, "consent=1; Path=/; HttpOnly");
    if (q === "/auth/callback/misis_id") return S.callbackBroken ? go(`${FAKE}/ej/oops`) : go(`${FAKE}/ej/`, `ejs=${S.ejGen}; Path=/; HttpOnly`);
    if (q === "/" || q === "/oops") return html(200, "<html>журнал</html>");
    if (q === "/auth/session" && S.sessionSlow && !req.delayed) { req.delayed = true; return setTimeout(() => req.emit("end"), S.sessionSlow); } // медленный журнал
    if (q === "/auth/session") return json(ejOk ? { user: { name: "Студент u1" } } : {});
    if (!ejOk) return json({ message: "unauthorized" }, 401);
    if (q === "/student/__data.json") return json({ type: "redirect", location: "/student/osenniy_388" });
    if (q === "/student/osenniy_388/__data.json") {
      // devalue в миниатюре: корневой узел — роль и семестр (как у настоящего журнала, NOTES.md п. 70)
      const root = [{ session: 1, semester: 4, academic_year_id: 5 }, { currentRole: 2 }, { role: 3, studId: 6, groupName: 7 }, "student", "osenniy", 388, STUD, "ГР-1"];
      return json({ type: "data", nodes: [{ type: "data", data: root }] });
    }
    if (q === `/api/v2/student/${STUD}/journals`) return json([{ id: 100, subject_name: "Базы данных", workers: [], statistic: { attendance: 80, final_rating: 50, completion_track: 60, completion_track_in_date: 60 } }]);
    if (q === `/api/v2/student/${STUD}/journals/100`) return json({ subject_name: "Базы данных", control_form: 1, attendance_slots: [], attendance_students: [], performance_works: [], performance_students: [], students: [{ stud_id: STUD }] });
    json({ message: "not found" }, 404);
  });
});
await new Promise((r) => fake.listen(PORT, "127.0.0.1", r));

const users = await import(pathToFileURL(join(TMP, "users.mjs")).href);
const ej = await import(pathToFileURL(join(TMP, "ej.mjs")).href);
const userFile = (id) => readFileSync(join(TMP, "users", `${id}.json`), "utf8");
const err = (p) => p.then(() => null, (e) => e);
const A = 1001, B = 1002, C = 1003, D = 1004;

try {
  // 1. Подключение паролем: вход и пароль запомнены; в файле пароля и почты открытым текстом нет; наружу — только признак.
  {
    await ej.connect(A, "u1", S.pass);
    const st = await users.ejState(A), raw = userFile(A);
    check("подключение: журнал подключён, пароль сохранён", st.connected && st.saved && !st.error, JSON.stringify(st));
    check("в файле пользователя пароль только зашифрованным", /"ejCred":\s*"[^"]+"/.test(raw) && !raw.includes(S.pass));
    check("состояние журнала (ответ API) пароля не содержит", !JSON.stringify(st).includes(S.pass) && !("password" in st));
    check("ejCred отдаёт почту и пароль для входа", JSON.stringify(await users.ejCred(A)) === JSON.stringify({ email: "u1", password: S.pass }));
    check("профиль: журнал подключён, пароля нет", (await users.profile(A)).ej === true && !JSON.stringify(await users.profile(A)).includes(S.pass));
  }
  // 2. Вход в журнал истёк, вход MISIS ID жив — тихий вход по cookies, пароль не шлётся.
  {
    S.ejGen++; S.posts.length = 0; ej.forget(A);
    const d = await ej.journal(A);
    check("вход журнала истёк, MISIS ID жив: журнал загружен без пароля", d?.subjects?.length === 1 && S.posts.length === 0, `posts=${S.posts.length}`);
  }
  // 3. Истёк и вход MISIS ID (48 ч) — сервер входит сохранённым паролем сам; параллельные запросы — один вход.
  {
    S.ejGen++; S.hydraGen++; S.posts.length = 0; ej.forget(A);
    const [a, b, c] = await Promise.all([ej.session(A), ej.session(A, { fresh: true }), ej.session(A)]);
    check("вход MISIS ID истёк: сервер вошёл сохранённым паролем сам", !!a && a === b && b === c && S.posts.length === 1 && S.posts[0] === S.pass, `posts=${S.posts.length}`);
    const st = await users.ejState(A);
    check("после такого входа нет просьбы о пароле и ошибки", st.connected && st.saved && !st.error, JSON.stringify(st));
    S.posts.length = 0;
    check("новый вход сохранён: следующий запрос — без входа", !!(await ej.session(A)) && S.posts.length === 0);
    S.ejGen++; S.hydraGen++; S.posts.length = 0; ej.forget(A);
    const d = await ej.journal(A);
    check("journal(): через «48 ч» данные грузятся сами, без need_password", d?.subjects?.length === 1 && S.posts.length === 1);
  }
  // 4. Пароль сменили в МИСИС: MISIS ID не принял сохранённый — он забыт, нужен пароль; повторно неверный не шлётся.
  {
    S.pass = "Pw-secret-NEW"; S.ejGen++; S.hydraGen++; S.posts.length = 0; ej.forget(A);
    const e1 = await err(ej.session(A));
    const st = await users.ejState(A);
    check("пароль не подошёл: need_password, пароль забыт", e1?.code === "need_password" && !st.saved && (await users.ejCred(A)) === null, `${e1?.code} ${JSON.stringify(st)}`);
    check("причина видна во вкладке («сохранённый пароль»)", /сохранённый пароль/.test(st.error || ""), st.error);
    check("журнал по-прежнему считается подключённым (банка есть)", st.connected === true);
    const e2 = await err(ej.session(A)), e3 = await err(ej.journal(A, { force: true }));
    check("неверный пароль повторно не шлётся (2 запроса — 0 новых попыток)", e2?.code === "need_password" && e3?.code === "need_password" && S.posts.length === 1, `posts=${S.posts.length}`);
    await ej.connect(A, "u1", S.pass); ej.forget(A);
    check("новый пароль во вкладке — снова сохранён", (await users.ejState(A)).saved && (await users.ejCred(A))?.password === S.pass);
  }
  // 5. MISIS ID лежит (502 на форму входа): пароль не забывается, следующая попытка с паролем — через паузу.
  {
    S.ejGen++; S.hydraGen++; S.posts.length = 0; S.signinStatus = 502; ej.forget(A);
    const e1 = await err(ej.session(A));
    check("MISIS ID 502: ошибка не про пароль, пароль сохранён", e1 && e1.code !== "need_password" && e1.code !== "bad_credentials" && (await users.ejState(A)).saved, `${e1?.code} ${e1?.message}`);
    const e2 = await err(ej.session(A));
    check("сразу после сбоя пароль не шлётся снова (пауза)", e2 && e2.code !== "need_password" && S.posts.length === 1, `posts=${S.posts.length}`);
    S.signinStatus = 0;
    await new Promise((r) => setTimeout(r, 700));
    check("после паузы — вход сохранённым паролем", !!(await ej.session(A)) && S.posts.length === 2, `posts=${S.posts.length}`);
  }
  // 6. Пароль принят, но вход не завершился (журнал вернул не туда) — пароль не забыт, пауза; сбой до формы — без паузы.
  {
    S.ejGen++; S.hydraGen++; S.posts.length = 0; S.callbackBroken = true; ej.forget(A);
    const e1 = await err(ej.session(A));
    check("вход не завершился: пароль сохранён, это не need_password", e1 && e1.code !== "need_password" && (await users.ejState(A)).saved, e1?.message);
    S.callbackBroken = false;
    await new Promise((r) => setTimeout(r, 700));
    S.hydraGen++; S.ejGen++; S.startBroken = 1; S.posts.length = 0;
    const e2 = await err(ej.session(A));
    check("журнал не начал вход (до формы): пароль не ушёл", e2 && S.posts.length === 0, e2?.message);
    check("…и паузы нет: следующий запрос сразу входит паролем", !!(await ej.session(A)) && S.posts.length === 1, `posts=${S.posts.length}`);
  }
  // 7. Вход в бот (users.login + connect trusted) при неответившем журнале: пароль запомнен, журнал подключится сам.
  {
    await users.login(B, "u1", S.moodle.u1 = S.pass);
    S.startBroken = 3;
    const e = await err(ej.connect(B, "u1", S.pass, { trusted: true }));
    const st = await users.ejState(B);
    check("вход в бот, журнал не ответил: пароль запомнен, банки нет", !!e && st.saved && st.connected && (await users.ejJar(B)) === null, JSON.stringify(st));
    S.startBroken = 0; S.posts.length = 0;
    const d = await ej.journal(B);
    check("журнал подключился сам при первом запросе", d?.subjects?.length === 1 && !!(await users.ejJar(B)) && S.posts.length === 1);
  }
  // 8. Вход в бот, а MISIS ID пароль не принял (Moodle принял) — такой пароль не запоминается.
  {
    S.moodle.u1 = "Moodle-only-pass";
    await users.login(C, "u1", S.moodle.u1);
    const e = await err(ej.connect(C, "u1", S.moodle.u1, { trusted: true }));
    check("неверный для MISIS ID пароль не запоминается", e?.code === "bad_credentials" && !(await users.ejState(C)).saved && !(await users.ejState(C)).connected);
    S.moodle.u1 = S.pass;
  }
  // 9. Ручное подключение с неверным паролем — не запоминается и прежний (если был) не трогает.
  {
    const e = await err(ej.connect(A, "u1", "wrong"));
    check("ручное подключение с неверным паролем: прежний пароль остался", e?.code === "bad_credentials" && (await users.ejCred(A))?.password === S.pass);
  }
  // 10. Вход другой учётной записью под тем же Telegram — журнал и пароль прежней стираются; тот же человек — нет.
  {
    await users.login(A, "u1", S.pass);
    check("повторный вход той же учётной записью: пароль журнала на месте", (await users.ejState(A)).saved);
    await users.login(A, "u2", S.moodle.u2);
    const st = await users.ejState(A);
    check("вход другой учётной записью: журнал и пароль прежней удалены", !st.connected && !st.saved && (await users.ejJar(A)) === null && (await users.ejCred(A)) === null, JSON.stringify(st));
  }
  // 11. Выход стирает пароль.
  {
    await users.login(D, "u1", S.pass);
    await ej.connect(D, "u1", S.pass);
    await users.logout(D);
    const st = await users.ejState(D);
    check("выход: пароль и вход в журнал удалены", !st.connected && !st.saved && !userFile(D).includes("ejCred"));
    const e = await err(ej.session(D));
    check("после выхода журнал — need_connect, без попыток входа", e?.code === "need_connect");
  }
  // 11а. Гонки: человек вышел или вошёл другой учётной записью, пока фоновое подключение журнала ещё шло, — оно ничего
  // не записывает (ни вход, ни пароль).
  {
    const E = 1005, F = 1006;
    await users.login(E, "u1", S.pass);
    S.slow = 300;
    const p = err(ej.connect(E, "u1", S.pass, { trusted: true }));
    await new Promise((r) => setTimeout(r, 80));
    await users.logout(E);
    await p;
    const st = await users.ejState(E);
    check("выход во время подключения журнала: пароль и вход не записаны", !st.connected && !st.saved && !userFile(E).includes("ejCred"), JSON.stringify(st));
    await users.login(F, "u1", S.pass);
    const q = err(ej.connect(F, "u1", S.pass, { trusted: true }));
    await new Promise((r) => setTimeout(r, 80));
    await users.login(F, "u2", S.moodle.u2);
    await q;
    const st2 = await users.ejState(F);
    check("вход другой учётной записью во время подключения: пароль прежней не записан", !st2.saved && !st2.connected, JSON.stringify(st2));
    S.slow = 0;
  }
  // 11б. Находки ревью 16 окт: ответы MISIS ID, гонки повторного входа, ожидание фонового подключения.
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const expire = () => { S.ejGen++; S.hydraGen++; };
    const G = 1007;
    await users.login(G, "u1", S.pass); await ej.connect(G, "u1", S.pass);
    // 429 на форму входа: пароль не забыт, повтор — не сразу.
    expire(); S.posts.length = 0; S.signinStatus = 429; ej.forget(G);
    const e429 = await err(ej.session(G)), e429b = await err(ej.session(G));
    check("429 от MISIS ID: не «неверный пароль», пароль сохранён, сразу не повторяется", e429?.code === "rate_limited" && (await users.ejState(G)).saved && e429b && S.posts.length === 1, `${e429?.code} posts=${S.posts.length}`);
    await sleep(900); // больше обычной паузы (600 мс), меньше тройной (1800 мс)
    await err(ej.session(G));
    check("после 429 пауза втрое длиннее обычной", S.posts.length === 1, `posts=${S.posts.length}`);
    S.signinStatus = 0; ej.forget(G);
    // Вход в бот (connect trusted) получил 429: пароль сохранён, и запрос журнала сразу после этого (GET /api/ej ждёт
    // подключение) пароль второй раз не шлёт.
    {
      const H = 1010;
      await users.login(H, "u1", S.pass); expire(); S.posts.length = 0; S.signinStatus = 429;
      const eh = await err(ej.connect(H, "u1", S.pass, { trusted: true }));
      const ej2 = await err(ej.journal(H));
      check("вход в бот получил 429: пароль сохранён, журнал сразу после — без второй отправки", eh?.code === "rate_limited" && (await users.ejState(H)).saved && !!ej2 && S.posts.length === 1, `posts=${S.posts.length}`);
      S.signinStatus = 0;
    }
    // Ответ 500 с блоком ошибки формы («неверный пароль») — это отказ, а не сбой: пароль забыт.
    {
      const J = 1011;
      await users.login(J, "u1", S.pass); await ej.connect(J, "u1", S.pass);
      expire(); ej.forget(J); S.signinStatus = 500; S.signinBody = '<form><p class="text-error">Неверный логин или пароль</p></form>';
      const ej5 = await err(ej.session(J));
      check("500 со словами «неверный пароль» — отказ: need_password, пароль забыт", ej5?.code === "need_password" && !(await users.ejState(J)).saved, `${ej5?.code} ${ej5?.message}`);
      S.signinStatus = 0; S.signinBody = "";
    }
    // Пароль принят, а вход трижды подряд не завершается (неузнанный отказ) — пароль забывается, а не шлётся бесконечно;
    // счётчик на диске.
    {
      const L = 1012;
      await users.login(L, "u1", S.pass); await ej.connect(L, "u1", S.pass);
      S.callbackBroken = true; S.posts.length = 0;
      const codes = [];
      for (let i = 0; i < 3; i++) { expire(); ej.forget(L); codes.push((await err(ej.session(L)))?.code ?? "ok"); await sleep(700); }
      S.callbackBroken = false;
      const stL = await users.ejState(L);
      check("трижды «пароль принят, вход не завершился» — пароль забыт, просьба о пароле", codes[2] === "need_password" && codes[0] !== "need_password" && !stL.saved && stL.rejected && S.posts.length === 3, `${codes.join("/")} posts=${S.posts.length} ${JSON.stringify(stL)}`);
      check("счётчик неудач хранится в файле и сбрасывается вместе с паролем", !/ejCredFails/.test(userFile(L)));
    }
    // Вместо формы входа — страница ошибки (502): пароль не уходит вовсе и не забывается.
    expire(); S.posts.length = 0; S.formStatus = 502;
    const eForm = await err(ej.session(G));
    check("страница ошибки вместо формы входа: пароль не отправлен и не забыт", eForm && eForm.code !== "need_password" && S.posts.length === 0 && (await users.ejState(G)).saved, eForm?.message);
    S.formStatus = 0;
    check("…и паузы нет: следующий запрос входит паролем", !!(await ej.session(G)) && S.posts.length === 1, `posts=${S.posts.length}`);
    // Неверный пароль, отвергнутый перенаправлением обратно на форму, — тоже отказ: забыт, больше не шлётся.
    S.pass = "Pw-redirect-NEW"; S.wrongRedirect = true; expire(); S.posts.length = 0; ej.forget(G);
    const eR = await err(ej.session(G));
    await sleep(700); expire(); ej.forget(G);
    const eR2 = await err(ej.session(G));
    check("отказ перенаправлением на форму: need_password, пароль забыт, повторно не шлётся", eR?.code === "need_password" && eR2?.code === "need_password" && !(await users.ejState(G)).saved && S.posts.length === 1, `${eR?.code}/${eR2?.code} posts=${S.posts.length}`);
    const stR = await users.ejState(G);
    check("после отказа и повторного запроса причина — «сохранённый пароль», rejected", stR.rejected === true && /сохранённый пароль/.test(stR.error || ""), JSON.stringify(stR));
    S.wrongRedirect = false;
    await ej.connect(G, "u1", S.pass);
    check("новый пароль снимает rejected", !(await users.ejState(G)).rejected && (await users.ejState(G)).saved);
    // То же, когда на форму возвращают с параметром ошибки перед login_challenge.
    S.pass = "Pw-redirect-2"; S.wrongRedirect = "error"; expire(); S.posts.length = 0; ej.forget(G);
    const eR3 = await err(ej.session(G));
    check("отказ перенаправлением на форму с ?error=…: тоже need_password, пароль забыт", eR3?.code === "need_password" && !(await users.ejState(G)).saved && S.posts.length === 1, `${eR3?.code} posts=${S.posts.length}`);
    S.wrongRedirect = false;
    await ej.connect(G, "u1", S.pass);
    // Гонка фон + человек: второй запрос прочитал пароль до того, как первый вход его забыл, — неверный пароль уходит один раз.
    S.pass = "Pw-race-NEW"; expire(); S.posts.length = 0; ej.forget(G); S.slow = 300;
    const pa = err(ej.session(G));
    await sleep(60); S.sessionSlow = 700;
    const pb = err(ej.session(G));
    const [ea, eb] = await Promise.all([pa, pb]);
    S.slow = 0; S.sessionSlow = 0;
    check("гонка двух запросов: отвергнутый пароль ушёл в MISIS ID один раз", ea?.code === "need_password" && eb?.code === "need_password" && S.posts.length === 1, `posts=${S.posts.length} ${ea?.code}/${eb?.code}`);
    // Новый пароль введён, пока повторный вход ещё шёл со старым (неверным): новый не забывается.
    // Задерживается только POST со старым паролем; новый подключается, когда старый уже точно в пути (S.seen), а не по таймеру.
    await ej.connect(G, "u1", "Pw-race-NEW"); S.pass = "Pw-race-NEWER"; expire(); ej.forget(G); S.slow = 300; S.slowFor = "Pw-race-NEW"; S.seen = [];
    const pr = err(ej.session(G));
    for (let i = 0; i < 100 && !S.seen.includes("Pw-race-NEW"); i++) await sleep(10);
    await ej.connect(G, "u1", "Pw-race-NEWER");
    const er = await pr;
    S.slow = 0; S.slowFor = null;
    check("новый пароль во время входа со старым: новый сохранён, просьбы о пароле нет", (await users.ejCred(G))?.password === "Pw-race-NEWER" && er?.code !== "need_password", `${er?.code} ${er?.message}`);
    // Выход во время повторного входа: ничего не записано.
    const K = 1008;
    S.moodle.u1 = S.pass; await users.login(K, "u1", S.pass); await ej.connect(K, "u1", S.pass); expire(); ej.forget(K); S.slow = 300;
    const pk = err(ej.session(K));
    await sleep(80); ej.forget(K); await users.logout(K);
    const ek = await pk; S.slow = 0;
    const stK = await users.ejState(K);
    check("выход во время повторного входа: need_connect, ни банки, ни пароля", ek?.code === "need_connect" && !stK.connected && !stK.saved, `${ek?.code} ${JSON.stringify(stK)}`);
    // Ручное подключение (не вход в бот) при неответившем журнале: пароль не запоминается.
    const M = 1009;
    S.startBroken = 1;
    const em = await err(ej.connect(M, "u1", S.pass));
    check("ручное подключение, журнал не ответил: пароль не запомнен", !!em && !(await users.ejState(M)).saved);
    // Пока идёт фоновое подключение — connectingOf отдаёт его (GET /api/ej ждёт), потом — null.
    S.slow = 300;
    const pc = err(ej.connect(M, "u1", S.pass, { trusted: true }));
    await sleep(30);
    const waiting = ej.connectingOf(M);
    await pc; S.slow = 0;
    check("connectingOf: обещание во время подключения, null после", !!waiting && typeof waiting.then === "function" && ej.connectingOf(M) === null && (await users.ejState(M)).connected);
    // Загрузка журнала шла (по живому входу), а человек вышел: её ответ в память не попадает (lastGood пуст).
    ej.forget(M); S.sessionSlow = 400;
    const pj = err(ej.journal(M));
    await sleep(60); ej.forget(M); await users.logout(M);
    await pj; S.sessionSlow = 0;
    check("выход во время загрузки журнала: прежний журнал в памяти не остаётся", ej.lastGood(M) === null);
  }
  // 12. Зашифрованный пароль привязан к своему пользователю: перенос в чужой файл не открывается.
  {
    await ej.connect(B, "u1", S.pass);
    const blob = JSON.parse(userFile(B)).ejCred;
    const f = join(TMP, "users", `${C}.json`);
    const u = JSON.parse(readFileSync(f, "utf8")); u.ejCred = blob; writeFileSync(f, JSON.stringify(u));
    // кэш users.mjs держит прежний объект — читаем свежим модулем
    const fresh = await import(pathToFileURL(join(TMP, "users.mjs")).href + "?fresh");
    check("пароль из чужого файла не расшифровывается", (await fresh.ejCred(C)) === null && (await fresh.ejCred(B))?.password === S.pass);
  }
  // 13. Пароль не попал ни в одну строку журнала сервера.
  {
    const leaks = logged.filter((l) => [S.pass, "Pw-secret-1", "Pw-other-2", "Moodle-only-pass"].some((p) => l.includes(p)));
    check("пароли не попали в журнал сервера", leaks.length === 0, leaks[0] || "");
  }
} catch (e) {
  fails++; console.log("FAIL  исключение:", e?.stack || e);
}

fake.close();
try { rmdirSync(join(TMP, "node_modules")); } catch { /* ссылку снимаем отдельно — папку пакетов приложения не трогаем */ }
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* занято — оставим */ }
console.log(fails ? `\n${fails} проверок не прошло` : "\nвсё прошло");
process.exit(fails ? 1 : 0);
