import { Bell, BookOpen, CalendarPlus, ChevronRight, Download, Gauge, GraduationCap, LogOut, MessageSquareText, ShieldCheck, Sparkles, Users } from "lucide-react";
import { useState } from "react";
import { GroupPicker } from "../components/GroupPicker";
import { Tile, TileLabel } from "../components/Tile";
import { toast } from "../components/Toast";
import { useNav } from "../hooks/useNav";
import { shortName, useAuth } from "../store/auth";
import { useSchedule } from "../store/schedule";
import { useUi } from "../hooks/useUi";
import { confirmDialog, haptic, telegramUser } from "../telegram/webapp";

const NOTIFY: { key: "news" | "journal"; title: string; text: string }[] = [
  { key: "news", title: "Объявления и новые материалы", text: "Преподаватель написал в «Объявлениях» курса или выложил файл." },
  { key: "journal", title: "Пропуски и посещаемость", text: "В журнале отметили пропуск, посещаемость упала ниже 75 % или работа оценена ниже порога." },
];
/**
 * «Уведомления бота»: что из необязательного присылать в Telegram. О новых работах, сроках, оценках и замечаниях
 * преподавателя бот пишет всегда; здесь — объявления с материалами и журнал (просьба владельца, 4 окт 2026).
 */
function NotifyPrefs() {
  const { profile, setNotifyPref } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const prefs = profile?.notify ?? { news: true, journal: true };
  const toggle = async (key: "news" | "journal") => {
    if (busy) return;
    haptic.select();
    setBusy(key);
    try { await setNotifyPref(key, !prefs[key]); }
    catch (e) { haptic.warning(); toast((e as Error).message); }
    finally { setBusy(null); }
  };
  return (
    <Tile index={3} className="!min-h-0 py-3">
      <TileLabel className="flex items-center gap-1.5"><Bell size={13} strokeWidth={2.5} />Уведомления бота</TileLabel>
      {NOTIFY.map((n, i) => (
        <div key={n.key} className={`flex items-start justify-between gap-3 ${i ? "mt-3 border-t border-separator pt-3" : "mt-2"}`}>
          <span className="min-w-0">
            <span className="block text-m font-bold">{n.title}</span>
            <span className="mt-0.5 block text-s leading-[18px] text-hint">{n.text}</span>
          </span>
          <button onClick={() => void toggle(n.key)} disabled={busy === n.key} role="switch" aria-checked={prefs[n.key]} aria-label={n.title}
            className={`relative mt-0.5 h-8 w-14 shrink-0 rounded-full transition-colors disabled:opacity-50 ${prefs[n.key] ? "bg-accent" : "bg-raised"}`}>
            <span className={`absolute top-1 size-6 rounded-full bg-white shadow transition-[left] ${prefs[n.key] ? "left-7" : "left-1"}`} />
          </button>
        </div>
      ))}
      <p className="mt-3 text-s leading-[18px] text-hint">О новых работах, сроках, оценках и замечаниях преподавателя бот пишет всегда.</p>
    </Tile>
  );
}

/** Профиль: кто вошёл в Moodle, группа расписания, выход. */
/** Что значит процент лимита для студента (уровни — usage.mjs own). */
const QUOTA_TEXT = {
  ok: "Сколько работы агента израсходовано в этом месяце. Счёт обнуляется 1-го числа.",
  start: "Лимит на этот месяц израсходован: новый отчёт, исправление по замечаниям и проверка отчёта откроются 1-го числа — или попросите владельца бота увеличить лимит. Начатую работу пока можно дописать.",
  all: "Лимит на этот месяц израсходован: работа с агентом откроется 1-го числа — или попросите владельца бота увеличить лимит. Готовый отчёт можно прикрепить и отправить и сейчас.",
  closed: "Работа агента для вас сейчас закрыта владельцем бота.",
} as const;

export function ProfileScreen() {
  const { profile, logout, setVariant, setShareRemarks } = useAuth();
  const pop = useNav((s) => s.pop);
  const push = useNav((s) => s.push);
  const user = telegramUser();
  const [pick, setPick] = useState(false);
  const { subgroup, setSubgroup } = useSchedule();
  const [variant, setVariantText] = useState(profile?.variant ?? "");
  const saveVariant = async () => {
    const v = variant.trim();
    if (v === (profile?.variant ?? "")) return;
    try { await setVariant(v); haptic.success(); toast(v ? `Вариант ${v} сохранён` : "Вариант очищен"); }
    catch (e) { haptic.warning(); toast((e as Error).message); }
  };

  // Согласие делиться замечаниями преподавателя: выключение сразу убирает их из общей базы на сервере.
  const [sharing, setSharing] = useState(false);
  const toggleShare = async () => {
    if (!profile || sharing) return;
    const on = !profile.shareRemarks;
    haptic.select();
    setSharing(true);
    try { await setShareRemarks(on); toast(on ? "Спасибо! Замечания помогут отчётам одногруппников" : "Ваши замечания убраны из общей базы"); }
    catch (e) { haptic.warning(); toast((e as Error).message); }
    finally { setSharing(false); }
  };

  const doLogout = async () => {
    haptic.warning();
    if (!(await confirmDialog("Выйти из Moodle? Дедлайны, расписание и журнал перестанут обновляться, задачи останутся."))) return;
    await logout();
    toast("Вы вышли из Moodle");
    useUi.setState({ exitDir: 1 }); pop();
  };

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-display px-1 text-l font-extrabold tracking-[-0.03em]">Профиль</h1>
      <Tile index={0} className="!min-h-0 py-1">
        <div className="flex min-h-12 items-center justify-between border-b border-separator"><TileLabel>Telegram</TileLabel>
          <span className="text-m font-semibold">{user.firstName} {user.lastName}{profile?.tgId ? <span className="pl-2 font-medium text-hint">id {profile.tgId}</span> : null}</span></div>
        <div className="flex min-h-12 items-center justify-between border-b border-separator"><TileLabel>Moodle</TileLabel><span className="truncate pl-3 text-m font-semibold">{profile?.moodle?.fullName ?? "не вошли"}</span></div>
        <div className="flex min-h-12 items-center justify-between gap-3"><TileLabel>Группа</TileLabel>
          <button onClick={() => setPick((p) => !p)} className="flex items-center gap-1.5 text-m font-semibold text-accent"><Users size={16} strokeWidth={2.5} />{profile?.group ?? "не выбрана"}</button></div>
      </Tile>
      {(pick || !profile?.group) && <GroupPicker />}
      <button onClick={() => { haptic.select(); push({ name: "courses" }); }} className="glass flex min-h-12 items-center gap-3 rounded-2xl px-4 text-m font-bold">
        <BookOpen size={20} strokeWidth={2.25} className="text-accent" /><span className="flex-1 text-left">Курсы</span><ChevronRight size={18} className="text-hint" />
      </button>
      <button onClick={() => { haptic.select(); push({ name: "teachers" }); }} className="glass flex min-h-12 items-center gap-3 rounded-2xl px-4 text-m font-bold">
        <GraduationCap size={20} strokeWidth={2.25} className="text-accent" /><span className="flex-1 text-left">Преподаватели</span><ChevronRight size={18} className="text-hint" />
      </button>
      <button onClick={() => { haptic.select(); push({ name: "calendar" }); }} className="glass flex min-h-12 items-center gap-3 rounded-2xl px-4 text-m font-bold">
        <CalendarPlus size={20} strokeWidth={2.25} className="text-accent" /><span className="flex-1 text-left">Календарь в телефоне</span><ChevronRight size={18} className="text-hint" />
      </button>
      {profile?.isOwner && (
        <button onClick={() => { haptic.select(); push({ name: "access" }); }} className="glass flex min-h-12 items-center gap-3 rounded-2xl px-4 text-m font-bold">
          <ShieldCheck size={20} strokeWidth={2.25} className="text-accent" /><span className="flex-1 text-left">Доступ к отчётам</span><ChevronRight size={18} className="text-hint" />
        </button>
      )}
      {profile?.isOwner && (
        <button onClick={() => { haptic.select(); push({ name: "env" }); }} className="glass flex min-h-12 items-center gap-3 rounded-2xl px-4 text-m font-bold">
          <Download size={20} strokeWidth={2.25} className="text-accent" /><span className="flex-1 text-left">Запросы на установку</span><ChevronRight size={18} className="text-hint" />
        </button>
      )}
      {profile?.isOwner && (
        <button onClick={() => { haptic.select(); push({ name: "usage" }); }} className="glass flex min-h-12 items-center gap-3 rounded-2xl px-4 text-m font-bold">
          <Gauge size={20} strokeWidth={2.25} className="text-accent" /><span className="flex-1 text-left">Расход и лимиты</span><ChevronRight size={18} className="text-hint" />
        </button>
      )}
      {profile?.group && (
        <Tile index={1} className="!min-h-0 py-3">
          <div className="flex items-center justify-between">
            <TileLabel>Подгруппа</TileLabel>
            <div className="flex gap-1">
              {(["1", "2"] as const).map((s) => (
                <button key={s} onClick={() => { haptic.select(); setSubgroup(s); }} aria-pressed={subgroup === s}
                  className={`min-h-9 rounded-full px-3.5 text-s font-bold ${subgroup === s ? "bg-accent text-on-accent" : "bg-raised text-hint"}`}>{s}</button>
              ))}
            </div>
          </div>
        </Tile>
      )}
      {profile?.labsAllowed && (
        <Tile index={2} className="!min-h-0 py-3">
          <div className="flex items-center justify-between gap-3">
            <TileLabel className="shrink-0">Вариант</TileLabel>
            <input value={variant} onChange={(e) => setVariantText(e.target.value.slice(0, 12))} onBlur={saveVariant}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} placeholder="например, 04" inputMode="numeric"
              className="min-h-9 w-28 rounded-xl bg-raised px-3 text-right text-m font-semibold outline-none placeholder:text-hint" />
          </div>
          <p className="mt-2 flex items-start gap-2 text-s text-hint"><Sparkles size={14} strokeWidth={2.5} className="mt-0.5 shrink-0 text-accent" />
            <span>Титульный лист отчётов: {shortName(profile.moodle?.fullName) || "ФИО из Moodle"}, {profile.group ?? "группа"}, вариант {profile.variant ?? "—"}. Агент покажет это перед работой и спросит, если чего-то не хватает.</span></p>
        </Tile>
      )}
      {profile?.labsAllowed && profile.quota && (
        <Tile index={2} className="!min-h-0 py-3">
          <div className="flex items-center justify-between gap-3">
            <TileLabel className="flex items-center gap-1.5"><Gauge size={13} strokeWidth={2.5} />Лимит отчётов на месяц</TileLabel>
            {profile.quota.level !== "closed" && <span className={`text-m font-bold tabular ${profile.quota.percent >= 100 ? "text-red" : profile.quota.percent >= 80 ? "text-yellow" : ""}`}>{profile.quota.percent} %</span>}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, profile.quota.percent)}%`, background: profile.quota.percent >= 100 ? "var(--c-red)" : profile.quota.percent >= 80 ? "var(--c-yellow)" : "var(--c-accent)" }} />
          </div>
          <p className="mt-2 text-s text-hint">{QUOTA_TEXT[profile.quota.level ?? (profile.quota.percent >= 100 ? "start" : "ok")]}</p>
        </Tile>
      )}
      {profile?.loggedIn && <NotifyPrefs />}
      {profile?.loggedIn && (
        <Tile index={3} className="!min-h-0 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-m font-bold"><MessageSquareText size={18} strokeWidth={2.25} className="shrink-0 text-accent" />Делиться замечаниями преподавателя</span>
            <button onClick={toggleShare} disabled={sharing} role="switch" aria-checked={!!profile.shareRemarks} aria-label="Делиться замечаниями преподавателя"
              className={`relative h-8 w-14 shrink-0 rounded-full transition-colors disabled:opacity-50 ${profile.shareRemarks ? "bg-accent" : "bg-raised"}`}>
              <span className={`absolute top-1 size-6 rounded-full bg-white shadow transition-[left] ${profile.shareRemarks ? "left-7" : "left-1"}`} />
            </button>
          </div>
          <p className="mt-2 text-s leading-[18px] text-hint">Тексты замечаний к вашим проверенным работам — без имени, оценок и файлов — помогут агенту не повторять эти ошибки в отчётах одногруппников. Выключите — и они удалятся из общей базы.</p>
        </Tile>
      )}
      <button onClick={doLogout} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-red/15 text-m font-bold text-red">
        <LogOut size={18} strokeWidth={2.5} /> Выйти из Moodle
      </button>
    </div>
  );
}
