import { BookOpen, ClipboardCheck, Flag, FlaskConical, GraduationCap, type LucideIcon } from "lucide-react";
import type { DeadlineKind } from "../store/types";

/** Подписи и иконки типов работ. Порядок — для фильтров и формы. */
export const KINDS: { value: DeadlineKind; label: string; plural: string; Icon: LucideIcon }[] = [
  { value: "lab", label: "Лабораторная", plural: "Лабы", Icon: FlaskConical },
  { value: "test", label: "Тест", plural: "Тесты", Icon: ClipboardCheck },
  { value: "coursework", label: "Курсовая", plural: "Курсовая", Icon: BookOpen },
  { value: "exam", label: "Зачёт / экзамен", plural: "Зачёты", Icon: GraduationCap },
  { value: "other", label: "Другое", plural: "Другое", Icon: Flag },
];

export const kindOf = (k: DeadlineKind) => KINDS.find((x) => x.value === k) ?? KINDS[KINDS.length - 1];
