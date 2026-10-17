// Цвета предметов: без зелёного, жёлтого и красного, чтобы не путать со срочностью и «сдано».
export const SUBJECT_COLORS = ["#8e7cff", "#4da3ff", "#2ec4d6", "#ff7ab6", "#c77dff", "#c8a27a"] as const;

export const nextSubjectColor = (used: string[]) =>
  SUBJECT_COLORS.find((c) => !used.includes(c)) ?? SUBJECT_COLORS[used.length % SUBJECT_COLORS.length];
