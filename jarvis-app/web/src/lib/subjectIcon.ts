import {
  Atom, BookOpen, ChartLine, Code, Cpu, Database, Dumbbell, FlaskConical, Landmark, Languages, Network, Shield, Sigma, Terminal, Workflow,
  type LucideIcon,
} from "lucide-react";

/**
 * Иконка дисциплины для фона карточки ближайшего дедлайна (18 окт 2026).
 * Ищем по ключевым словам в полном названии, затем в коротком. Порядок важен: «иностранный язык» проверяем раньше,
 * чем «язык программирования». Не нашли — книга, чтобы карточка никогда не оставалась пустой.
 */
const RULES: [RegExp, LucideIcon][] = [
  [/иностран|английск|немецк|французск|english/, Languages],
  [/физическ.*культур|физкульт|спорт|элективн/, Dumbbell],
  [/баз[аы]? данных|субд|sql/, Database],
  [/сет(и|ей|ев)|network|телекоммуник|протокол/, Network],
  [/операционн|linux|unix|\bос\b|оси\b/, Terminal],
  [/безопасн|защит[аы] информ|криптограф/, Shield],
  [/архитектур.*(эвм|компьют|вычисл)|схемотех|электрон|микропроцесс/, Cpu],
  [/программ|язык|алгоритм|python|java|веб|web|разработк/, Code],
  [/моделир|оптимизац|исследован.*операц|имитац/, ChartLine],
  [/математ|анализ|алгебр|геометр|дискретн|вероятн|статист|логик/, Sigma],
  [/физик/, Atom],
  [/хими|биолог|эколог/, FlaskConical],
  [/информационн.*(систем|процесс)|проектирован|систем/, Workflow],
  [/истор|философ|эконом|прав[оа]|социолог|менеджмент/, Landmark],
];

export function subjectIcon(name?: string, short?: string): LucideIcon {
  const text = `${name ?? ""} ${short ?? ""}`.toLowerCase().replace(/ё/g, "е");
  for (const [re, Icon] of RULES) if (re.test(text)) return Icon;
  return BookOpen;
}
