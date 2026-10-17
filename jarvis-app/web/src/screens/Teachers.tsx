import { GraduationCap } from "lucide-react";
import { Teachers } from "../components/Teachers";
import { EmptyState } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { useAppStore } from "../store/useAppStore";

/** Преподаватели по дисциплинам: все активные курсы Moodle, у каждого — контакты и оценки из «Кампуса». */
export function TeachersScreen() {
  const subjects = useAppStore((s) => s.subjects);
  const pop = useNav((s) => s.pop);
  const courses = subjects.filter((s) => /^course:\d+$/.test(s.id)).sort((a, b) => a.name.localeCompare(b.name, "ru"));

  if (!courses.length) {
    return <EmptyState icon={GraduationCap} title="Курсов пока нет" text="Преподаватели появятся после загрузки курсов из Moodle." action="Назад" onAction={pop} />;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="px-1">
        <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Преподаватели</h1>
        <p className="mt-0.5 text-s font-semibold text-hint">По дисциплинам · контакты из Moodle, оценки из «Кампуса»</p>
      </div>
      {courses.map((c, i) => <Teachers key={c.id} courseId={Number(c.id.slice(7))} title={c.name} index={i} showEmpty reviews={false} />)}
    </div>
  );
}
