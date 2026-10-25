import type { CharacterId } from "../../theme/assistant-state";

/*
 * Спрайты маскотов (DES-005, 25 окт 2026): пиксельная сова Дуся (МИСИС) и ворона Варя (ВШЭ). Чистые функции —
 * возвращают строку SVG и viewBox; не читают данные, сторы и сеть. Кадры глаз — группы data-eye, значки над головой —
 * data-prop, части тела — классы owl-rig / owl-wing-l / owl-wing-r / owl-tufts: анимации общие, в index.css (owl-*).
 * Дуся перенесена из OwlAssistant без изменений. Неизвестный персонаж рисуется Дусей — пустого места не бывает.
 */

export type Eyes = "open" | "up" | "closed" | "half" | "happy" | "wide" | "stern";
export const EYES: readonly Eyes[] = ["open", "up", "closed", "half", "happy", "wide", "stern"];
export type SpriteOptions = { dark: boolean; nightcap: boolean; /** Уникальный id фильтра обводки Вари на странице. */ ringId?: string };
export type Sprite = { character: CharacterId; viewBox: string; svg: string; props: readonly string[] };

// ---------- Дуся (сетка 24×24) ----------
const N = 24;
type Px = [number, number, string];
function layer() {
  const g: Px[] = [];
  const api = {
    set(x: number, y: number, c: string) { if (x >= 0 && y >= 0 && x < N && y < N) g.push([x, y, c]); return api; },
    rect(x: number, y: number, w: number, h: number, c: string) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) api.set(x + i, y + j, c); return api; },
    ell(cx: number, cy: number, rx: number, ry: number, c: string) {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry; if (dx * dx + dy * dy <= 1) api.set(x, y, c); }
      return api;
    },
    pts(a: [number, number][], c: string) { a.forEach(([x, y]) => api.set(x, y, c)); return api; },
    svg() { return g.map(([x, y, c]) => `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${c}"/>`).join(""); },
  };
  return api;
}
const B = "#2f7bf6", BD = "#1f66e0", L = "#6aa2ff", S = "#a9cbff", W = "#ffffff", K = "#0a1a4a", BEAK = "#ffc23d", BEAK2 = "#e09a12";
const g = (attrs: string, inner: string) => `<g ${attrs}>${inner}</g>`;

function dusyaSvg(dark: boolean, nightcap: boolean) {
  const ink = dark ? W : K, cap = dark ? W : K, tas = dark ? S : BD, feet = dark ? W : K;
  const disc = (l: ReturnType<typeof layer>, x: number, y = 11, h = 4) => l.rect(x, y, 4, h, W);
  const eyes: Record<Eyes, () => ReturnType<typeof layer>> = {
    open: () => { const l = layer(); disc(l, 7); disc(l, 13); return l.rect(8, 12, 2, 2, K).rect(14, 12, 2, 2, K); },
    up: () => { const l = layer(); disc(l, 7); disc(l, 13); return l.rect(8, 11, 2, 2, K).rect(14, 11, 2, 2, K); },
    half: () => { const l = layer(); disc(l, 7, 13, 2); disc(l, 13, 13, 2); return l.rect(7, 12, 4, 1, K).rect(13, 12, 4, 1, K).rect(8, 13, 2, 1, K).rect(14, 13, 2, 1, K); },
    closed: () => layer().rect(7, 13, 4, 1, K).rect(13, 13, 4, 1, K),
    happy: () => layer().pts([[7, 13], [8, 12], [9, 12], [10, 13]], K).pts([[13, 13], [14, 12], [15, 12], [16, 13]], K),
    wide: () => { const l = layer(); disc(l, 7, 10, 5); disc(l, 13, 10, 5); return l.set(8, 12, K).set(15, 12, K); },
    stern: () => { const l = layer(); disc(l, 7, 12, 3); disc(l, 13, 12, 3); return l.rect(8, 13, 2, 2, K).rect(14, 13, 2, 2, K).pts([[7, 10], [8, 10], [9, 11], [10, 11]], K).pts([[13, 11], [14, 11], [15, 10], [16, 10]], K); },
  };
  const props: Record<string, ReturnType<typeof layer>> = {
    excl: layer().rect(20, 2, 2, 4, ink).rect(20, 7, 2, 1, ink),
    sweat: layer().set(19, 9, tas).rect(19, 10, 2, 2, tas).set(20, 12, tas),
    zzz: layer().pts([[18, 1], [19, 1], [20, 1], [19, 2], [18, 3], [19, 3], [20, 3]], tas).pts([[21, 4], [22, 4], [22, 5], [21, 6], [22, 6]], tas),
    idea: layer().rect(19, 1, 3, 3, ink).set(20, 4, tas).pts([[18, 0], [22, 0], [17, 2], [23, 2]], tas),
    q: layer().rect(19, 1, 3, 1, ink).set(22, 2, ink).rect(20, 3, 2, 1, ink).set(20, 4, ink).set(20, 6, ink),
    spark: layer().pts([[2, 6], [1, 7], [2, 7], [3, 7], [2, 8]], tas).pts([[21, 9], [20, 10], [21, 10], [22, 10], [21, 11]], tas).pts([[3, 18], [2, 19], [3, 19], [4, 19], [3, 20]], tas),
    clock: layer().rect(19, 1, 4, 4, ink).rect(20, 2, 2, 2, BD).set(21, 2, ink),
    feather: layer().pts([[2, 11], [3, 12]], S).pts([[21, 12], [20, 13]], S).pts([[1, 17], [2, 18]], L).pts([[22, 18], [21, 19]], L),
  };
  const hat = nightcap
    ? layer().rect(9, 7, 7, 1, W).rect(10, 5, 5, 2, S).rect(11, 4, 4, 1, S).rect(12, 3, 3, 1, S).rect(14, 2, 2, 1, S).set(16, 2, S).set(17, 3, S).rect(18, 3, 2, 2, W)
    : layer().rect(9, 3, 6, 1, cap).rect(7, 4, 10, 1, cap).rect(9, 5, 6, 1, cap).rect(10, 6, 4, 2, cap).set(16, 5, tas).set(16, 6, tas).rect(15, 7, 2, 2, tas);
  return (
    g('class="owl-rig"',
      g('class="owl-wing-l"', layer().rect(4, 14, 2, 5, BD).set(5, 19, BD).svg()) +
      g('class="owl-wing-r"', layer().rect(18, 14, 2, 5, BD).set(18, 19, BD).svg()) +
      g('class="owl-tufts"', layer().rect(6, 7, 2, 2, B).rect(16, 7, 2, 2, B).set(6, 6, B).set(17, 6, B).svg()) +
      layer().ell(12, 15, 7.5, 7, B).svg() +
      layer().ell(12, 19, 4, 2.8, L).pts([[10, 18], [12, 19], [14, 18]], S).svg() +
      layer().rect(11, 15, 2, 1, BEAK).set(11, 16, BEAK).set(12, 16, BEAK2).svg() +
      layer().rect(9, 22, 2, 1, feet).rect(13, 22, 2, 1, feet).svg() +
      (Object.keys(eyes) as Eyes[]).map((k) => g(`data-eye="${k}"`, eyes[k]().svg())).join("") +
      hat.svg()
    ) + Object.entries(props).map(([k, l]) => g(`data-prop="${k}"`, l.svg())).join("")
  );
}

// ---------- Варя (сетка 32×32, рамка шире — для значков над головой) ----------
type VPx = [number, number, string];
type Pred = (x: number, y: number) => boolean;
const VN = 32, VMIN = -8;
function vlayer() {
  const px: VPx[] = [];
  const api = {
    set(x: number, y: number, c: string) { if (x >= VMIN && y >= VMIN && x < VN + 4 && y < VN) px.push([x, y, c]); return api; },
    rect(x: number, y: number, w: number, h: number, c: string) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) api.set(x + i, y + j, c); return api; },
    pts(a: [number, number][], c: string) { a.forEach(([x, y]) => api.set(x, y, c)); return api; },
    fill(fn: Pred, c: string) { for (let y = VMIN; y < VN; y++) for (let x = VMIN; x < VN + 4; x++) if (fn(x, y)) api.set(x, y, c); return api; },
    // Контур: каждая пустая клетка рядом с фигурой (8 соседей), если её не закрывает другая часть (skip).
    outline(fn: Pred, c: string, skip: Pred = () => false) {
      for (let y = VMIN - 1; y <= VN; y++) for (let x = VMIN - 1; x <= VN + 4; x++) {
        if (fn(x, y) || skip(x, y)) continue;
        let hit = false;
        for (let j = -1; j <= 1 && !hit; j++) for (let i = -1; i <= 1; i++) if (fn(x + i, y + j)) { hit = true; break; }
        if (hit) api.set(x, y, c);
      }
      return api;
    },
    svg() { return px.map(([x, y, c]) => `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${c}"/>`).join(""); },
  };
  return api;
}
const R = (x: number, y: number, w: number, h: number): Pred => (px, py) => px >= x && px < x + w && py >= y && py < y + h;
const OR = (...fs: Pred[]): Pred => (x, y) => fs.some((f) => f(x, y));
// Цвета Вышки: синий #0F2D69 / #234B9B и серые, жёлтый клюв, розовые щёки.
const V = { B: "#234B9B", BD: "#0F2D69", L: "#4E78CF", BELLY: "#3A64B8", S: "#9CC3FF", W: "#ffffff", K: "#0A1838",
  Y: "#F6BC32", YD: "#E8A51C", YL: "#FFE39A", G: "#C6C6C6", P: "#F59AB8", RED: "#E5484D", COFFEE: "#5B3A22" };

const inBody: Pred = (x, y) => { const px = x + 0.5, py = y + 0.5; if (py > 25) return false; const dx = (px - 17) / 8.5, dy = (py - 16) / 10; return dx * dx + dy * dy <= 1; };
const inBelly: Pred = (x, y) => { const dx = (x + 0.5 - 16) / 4.6, dy = (y + 0.5 - 20.5) / 3.6; return dx * dx + dy * dy <= 1; };
const inBeakU: Pred = (x, y) => (y === 16 && x >= 9 && x <= 13) || (y === 17 && x >= 6 && x <= 13);
const inBeakL: Pred = (x, y) => y === 18 && x >= 8 && x <= 13;
const inWingR = OR(R(26, 16, 3, 5), R(29, 18, 1, 2));
const inWingL = OR(R(5, 18, 3, 4), R(4, 19, 1, 2));

function varyaSvg(nightcap: boolean, ringId: string) {
  const { B, BD, L, S, W, K, Y, YD, YL, P } = V;
  const wingL = vlayer().fill(inWingL, BD).outline(inWingL, K, inBody);
  const wingR = vlayer().fill(inWingR, BD).outline(inWingR, K, inBody);
  const tuft = vlayer().pts([[16, 4], [16, 3], [17, 2], [17, 3], [18, 3], [19, 2], [15, 4], [14, 3]], K);
  const body = vlayer().fill(inBody, B).fill((x, y) => inBody(x, y) && x >= 23, BD).fill(inBelly, V.BELLY)
    .pts([[14, 20], [17, 22], [15, 23]], L).pts([[10, 18], [10, 19], [10, 20]], L).outline(inBody, K);
  const blush = vlayer().rect(10, 14, 3, 1, P).rect(18, 14, 3, 1, P);
  const beakU = vlayer().fill(inBeakU, Y).rect(10, 16, 3, 1, YL).outline(inBeakU, K, (x, y) => inBeakL(x, y) || (inBody(x, y) && x > 14));
  const mouth = vlayer().rect(7, 18, 7, 1, K);
  const beakL = vlayer().fill(inBeakL, YD).outline(inBeakL, K, (x, y) => inBeakU(x, y) || y < 18 || (inBody(x, y) && x > 14));
  const legs = vlayer().pts([[14, 26], [14, 27], [13, 28], [12, 29], [13, 29], [14, 29]], K).pts([[19, 26], [19, 27], [20, 28], [19, 29], [20, 29], [21, 29]], K);
  // Ночью — колпак парит над головой, рядом сама по себе висит кружка кофе.
  const night = nightcap
    ? vlayer().rect(13, 3, 8, 1, W).rect(14, 2, 7, 1, S).rect(16, 1, 6, 1, S).set(17, 2, W).set(19, 1, W).rect(19, 0, 4, 1, S).set(22, 1, S).rect(23, 1, 2, 2, W)
        .rect(27, 8, 4, 5, K).rect(28, 9, 2, 3, B).set(28, 10, W).set(29, 11, W).rect(31, 9, 1, 3, K).rect(28, 8, 2, 1, V.COFFEE)
        .pts([[28, 6], [29, 5], [28, 4], [30, 5], [29, 3]], S)
    : vlayer();
  // Глаза мультяшные, с бликом; блик сдвигается туда, куда она смотрит.
  type L = ReturnType<typeof vlayer>;
  const eye = (l: L, x: number, y: number, hx: number, hy: number) => l.rect(x, y, 4, 5, K).pts([[x, y], [x + 3, y], [x, y + 4], [x + 3, y + 4]], B)
    .rect(x + hx, y + hy, 2, 1, W).set(x + hx, y + hy + 1, W).set(x + 2, y + 3, S);
  const pair = (hx: number, hy: number) => eye(eye(vlayer(), 11, 9, hx, hy), 16, 9, hx, hy);
  const eyes: Record<Eyes, () => L> = {
    open: () => pair(1, 1),
    up: () => pair(1, 0),
    wide: () => vlayer().rect(11, 9, 4, 5, W).pts([[11, 9], [14, 9], [11, 13], [14, 13]], B).set(12, 11, K)
      .rect(16, 9, 4, 5, W).pts([[16, 9], [19, 9], [16, 13], [19, 13]], B).set(17, 11, K)
      .pts([[11, 7], [12, 6], [13, 6], [14, 7]], K).pts([[16, 7], [17, 6], [18, 6], [19, 7]], K),
    half: () => vlayer().rect(11, 11, 4, 3, K).pts([[11, 13], [14, 13]], B).set(12, 12, W).rect(16, 11, 4, 3, K).pts([[16, 13], [19, 13]], B).set(17, 12, W),
    closed: () => vlayer().pts([[11, 11], [12, 12], [13, 12], [14, 11]], K).pts([[16, 11], [17, 12], [18, 12], [19, 11]], K),
    happy: () => vlayer().pts([[11, 12], [12, 11], [13, 11], [14, 12]], K).pts([[16, 12], [17, 11], [18, 11], [19, 12]], K),
    // Злая: брови резко вниз к клюву, глаза — щёлочки.
    stern: () => vlayer().rect(11, 11, 4, 3, K).pts([[14, 11], [11, 13], [14, 13]], B).set(12, 12, W).pts([[10, 8], [11, 8], [12, 9], [13, 9], [14, 10]], K)
      .rect(16, 11, 4, 3, K).pts([[16, 11], [16, 13], [19, 13]], B).set(18, 12, W).pts([[21, 8], [20, 8], [19, 9], [18, 9], [17, 10]], K),
  };
  const cloud = OR(R(-1, -7, 5, 1), R(-2, -6, 7, 2), R(-1, -4, 5, 1)), mid = R(3, 0, 2, 2), tiny = R(7, 5, 1, 1);
  const ox = -1, oy = -5;
  const face: Pred = (x, y) => { const dx = x + 0.5 - (ox + 5), dy = y + 0.5 - (oy + 5.5); return dx * dx + dy * dy <= 3.6 * 3.6; };
  const bells = OR(R(ox, oy, 3, 1), R(ox - 1, oy + 1, 3, 1), R(ox + 7, oy, 3, 1), R(ox + 8, oy + 1, 3, 1));
  const props: Record<string, string> = {
    excl: vlayer().rect(4, 1, 2, 5, Y).outline(R(4, 1, 2, 5), K).rect(4, 8, 2, 2, Y).outline(R(4, 8, 2, 2), K).svg(),
    sweat: vlayer().pts([[24, 6], [23, 7], [24, 7], [23, 8], [24, 8]], S).svg(),
    zzz: vlayer().rect(2, 2, 4, 1, S).set(4, 3, S).set(3, 4, S).rect(2, 5, 4, 1, S).rect(6, 7, 3, 1, S).set(7, 8, S).rect(6, 9, 3, 1, S).svg(),
    q: vlayer().pts([[3, 2], [4, 2], [5, 2], [6, 3], [6, 4], [5, 5], [4, 6], [4, 8]], K).svg(),
    // Пузырьки мысли: точка, кружок побольше и облачко с тремя точками.
    bubbles: g('class="b1"', vlayer().fill(tiny, W).outline(tiny, K).svg()) + g('class="b2"', vlayer().fill(mid, W).outline(mid, K).svg())
      + g('class="b3"', vlayer().fill(cloud, W).outline(cloud, K).pts([[-1, -5], [1, -5], [3, -5]], K).svg()),
    anger: vlayer().pts([[24, 0], [26, 0], [23, 1], [24, 1], [26, 1], [27, 1], [23, 3], [24, 3], [26, 3], [27, 3], [24, 4], [26, 4]], V.RED).svg(),
    spark: vlayer().pts([[3, 3], [2, 4], [3, 4], [4, 4], [3, 5]], Y).pts([[4, 22], [3, 23], [4, 23], [5, 23], [4, 24]], S)
      .pts([[27, 22], [26, 23], [27, 23], [28, 23], [27, 24]], Y).pts([[25, 1], [24, 2], [25, 2], [26, 2], [25, 3]], Y).svg(),
    // Будильник: белый циферблат, жёлтые звонки, стрелки, ножки и линии звона.
    clock: vlayer().fill(bells, Y).outline(bells, K, face).fill(face, W).outline(face, K)
      .set(ox + 5, oy + 2, S).set(ox + 8, oy + 5, S).set(ox + 5, oy + 8, S).set(ox + 2, oy + 5, S)
      .pts([[ox + 5, oy + 3], [ox + 5, oy + 4], [ox + 5, oy + 5], [ox + 4, oy + 5], [ox + 3, oy + 5]], K).set(ox + 5, oy + 5, V.RED)
      .rect(ox + 4, oy, 2, 1, K).pts([[ox + 2, oy + 10], [ox + 8, oy + 10]], K).pts([[ox - 2, oy + 4], [ox - 3, oy + 5], [ox + 12, oy + 4], [ox + 13, oy + 5]], S).svg(),
  };
  // Белая обводка в одну клетку, как у стикеров с вороной Вышки: на тёмной теме она отделяет синюю ворону от фона.
  const defs = `<defs><filter id="${ringId}" x="-10%" y="-10%" width="120%" height="120%"><feMorphology in="SourceAlpha" operator="dilate" radius="1" result="d"/>`
    + `<feFlood flood-color="#ffffff"/><feComposite in2="d" operator="in" result="w"/><feMerge><feMergeNode in="w"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
  const svg = defs + g(`filter="url(#${ringId})"`,
    g('class="owl-rig"',
      g('class="owl-wing-l"', wingL.svg()) + g('class="owl-wing-r"', wingR.svg()) +
      (nightcap ? "" : g('class="owl-tufts"', tuft.svg())) + body.svg() +
      EYES.map((k) => g(`data-eye="${k}"`, eyes[k]().svg())).join("") +
      blush.svg() + mouth.svg() + g('class="varya-beak-l"', beakL.svg()) + beakU.svg() + night.svg()
    ) + legs.svg() + Object.entries(props).map(([k, s]) => g(`data-prop="${k}"`, s)).join(""));
  return { svg, props: Object.keys(props) };
}

const DUSYA_PROPS = ["excl", "sweat", "zzz", "idea", "q", "spark", "clock", "feather"] as const;

/** Спрайт персонажа; неизвестный id — базовая Дуся. */
export function spriteFor(character: string, opts: SpriteOptions): Sprite {
  if (character === "varya") {
    const v = varyaSvg(opts.nightcap, opts.ringId ?? "varya-ring");
    return { character: "varya", viewBox: "-4 -8 40 40", svg: v.svg, props: v.props };
  }
  return { character: "dusya", viewBox: "0 0 24 24", svg: dusyaSvg(opts.dark, opts.nightcap), props: DUSYA_PROPS };
}
