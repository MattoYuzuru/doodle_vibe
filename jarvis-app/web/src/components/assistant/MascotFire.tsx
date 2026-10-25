/*
 * «Горит дедлайн» (DES-006): огонь за маскотом — отдельный декоративный слой, а не часть спрайта, поэтому он одинаков
 * для Дуси и Вари и не меняет размер элемента. Два кадра языков пламени меняются CSS-шагами (owl-fire-a/b); в спокойном
 * режиме остаётся первый кадр — статичный огненный знак с тем же смыслом. «Скоро» — только тёплое неподвижное свечение.
 * Смысл (срок и действие) передаёт текст карточки; слой скрыт от экранного диктора.
 */

const RED = "#ff4d3d", ORANGE = "#f5a524", YELLOW = "#ffd46b";
// Высота языка пламени по столбцам сетки 24×24; по краям выше — середину закрывает маскот.
const A = [6, 9, 12, 9, 6, 8, 5, 4, 3, 4, 3, 2, 3, 2, 3, 4, 3, 4, 5, 8, 6, 10, 12, 8];
const B = [8, 12, 9, 7, 9, 6, 4, 3, 4, 3, 2, 3, 2, 3, 4, 3, 4, 5, 7, 6, 9, 12, 9, 6];

function tongues(heights: number[]) {
  let out = "";
  heights.forEach((h, x) => {
    for (let d = 0; d < h; d++) {
      const color = d < 1 ? RED : d < 3 ? ORANGE : YELLOW; // d — расстояние от кончика языка вниз
      out += `<rect x="${x}" y="${24 - h + d}" width="1.02" height="1.02" fill="${color}"/>`;
    }
  });
  return out;
}
const FIRE_A = tongues(A), FIRE_B = tongues(B);

export function MascotFire({ accent }: { accent: "fire" | "warm" }) {
  if (accent === "warm") {
    return <span className="owl-warm pointer-events-none absolute inset-0 rounded-full" aria-hidden data-accent-layer="warm" />;
  }
  return (
    <svg className="owl-fire pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 24 24" shapeRendering="crispEdges"
      aria-hidden data-accent-layer="fire">
      <g className="owl-fire-a" dangerouslySetInnerHTML={{ __html: FIRE_A }} />
      <g className="owl-fire-b" dangerouslySetInnerHTML={{ __html: FIRE_B }} />
    </svg>
  );
}
