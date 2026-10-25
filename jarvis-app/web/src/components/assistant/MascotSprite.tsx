import { useId, useMemo } from "react";
import type { Anim } from "./pose";
import { type Eyes, type Sprite, spriteFor } from "./sprites";

/*
 * Отрисовка маскота (DES-005): только то, что пришло в props, — персонаж, глаза, значки, анимация, режим движения,
 * размер и тема. Данных, сторов и запросов здесь нет. Элемент всегда одного размера (size×size), поэтому смена
 * позы не двигает соседей. Для экранного диктора спрайт скрыт: смысл и действие даёт оболочка (MascotCard).
 * При ошибке сборки спрайта рисуется базовая Дуся, а не пустое место.
 */

export type MascotSpriteProps = {
  character: string;
  eyes: Eyes;
  props?: readonly string[];
  anim?: Anim | null;
  motion: "full" | "static" | "paused";
  size: number;
  dark: boolean;
  nightcap?: boolean;
  className?: string;
};

function safeSprite(character: string, dark: boolean, nightcap: boolean, ringId: string): Sprite {
  try {
    return spriteFor(character, { dark, nightcap, ringId });
  } catch {
    return spriteFor("dusya", { dark, nightcap: false });
  }
}

export function MascotSprite({ character, eyes, props = [], anim = null, motion, size, dark, nightcap = false, className = "" }: MascotSpriteProps) {
  const ringId = "mascot-ring-" + useId().replace(/[^\w-]/g, "");
  const sprite = useMemo(() => safeSprite(character, dark, nightcap, ringId), [character, dark, nightcap, ringId]);
  const still = motion !== "full";
  const classes = ["owl", "inline-grid", "shrink-0", "place-items-center", still ? "owl-static" : anim ? `owl-a-${anim}` : "",
    ...props.map((p) => `owl-p-${p}`), className].filter(Boolean).join(" ");
  return (
    <span className={classes} style={{ width: size, height: size }} data-character={sprite.character} aria-hidden>
      <svg viewBox={sprite.viewBox} width={size} height={size} shapeRendering="crispEdges" data-eyes={eyes}
        dangerouslySetInnerHTML={{ __html: sprite.svg }} />
    </span>
  );
}
