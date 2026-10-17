import { Construction } from "lucide-react";
import { EmptyState } from "../components/ui";

/** Временная заглушка для экранов, которые сделаем на следующих шагах. */
export function Placeholder({ title }: { title: string }) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="pt-2 text-l font-bold">{title}</h1>
      <EmptyState icon={Construction} title="Экран на следующем шаге" text="Сейчас готова Главная. Этот экран появится после вашего подтверждения." />
    </div>
  );
}
