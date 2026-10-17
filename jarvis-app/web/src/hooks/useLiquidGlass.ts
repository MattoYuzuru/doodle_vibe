import { useEffect, useId, useRef } from "react";
import { lite } from "../lib/perf";

// Преломление Liquid Glass: для элемента строим карту смещений (у края стекла содержимое под ним
// «затягивается» внутрь, как в линзе) и подключаем её SVG-фильтром в backdrop-filter.
// Работает только в Chromium (Telegram на Android и ПК). WebKit (iPhone) не умеет url() в backdrop-filter,
// там остаётся обычное матовое стекло из .glass.
const ua = navigator.userAgent;
export const refractionSupported = !lite && /Chrome\/\d+/.test(ua) && !/iPhone|iPad|iPod/.test(ua);
if (refractionSupported) document.documentElement.classList.add("refract");

const SVG_NS = "http://www.w3.org/2000/svg";
let holder: SVGSVGElement | null = null;
function svgHolder() {
  if (!holder) {
    holder = document.createElementNS(SVG_NS, "svg");
    holder.setAttribute("width", "0");
    holder.setAttribute("height", "0");
    holder.setAttribute("aria-hidden", "true");
    holder.style.position = "absolute";
    document.body.appendChild(holder);
  }
  return holder;
}

/** Карта смещений для скруглённого прямоугольника: R/G = направление внутрь, сила растёт к краю. */
function displacementMap(w: number, h: number, radius: number, band: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const r = Math.min(radius, w / 2, h / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5, py = y + 0.5;
      const qx = Math.min(Math.max(px, r), w - r);
      const qy = Math.min(Math.max(py, r), h - r);
      const dx = px - qx, dy = py - qy;
      const len = Math.hypot(dx, dy);
      let vx = 0, vy = 0;
      if (len > 0) {
        const dist = r - len; // расстояние до края стекла
        const t = Math.min(Math.max(1 - dist / band, 0), 1);
        const k = t * t;
        vx = (-dx / len) * k;
        vy = (-dy / len) * k;
      }
      const i = (y * w + x) * 4;
      img.data[i] = 128 + vx * 127;
      img.data[i + 1] = 128 + vy * 127;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

/** Подключает преломление к элементу. radius — скругление в px (Infinity = капсула). */
export function useLiquidGlass<T extends HTMLElement>(options: { radius?: number; band?: number; strength?: number } = {}) {
  const ref = useRef<T>(null);
  const id = "lg" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const { radius = Infinity, band = 14, strength = 26 } = options;

  useEffect(() => {
    const el = ref.current;
    if (!el || !refractionSupported) return;
    const filter = document.createElementNS(SVG_NS, "filter");
    filter.setAttribute("id", id);
    filter.setAttribute("x", "0");
    filter.setAttribute("y", "0");
    filter.setAttribute("width", "100%");
    filter.setAttribute("height", "100%");
    filter.setAttribute("color-interpolation-filters", "sRGB");
    const image = document.createElementNS(SVG_NS, "feImage");
    image.setAttribute("x", "0");
    image.setAttribute("y", "0");
    image.setAttribute("preserveAspectRatio", "none");
    image.setAttribute("result", "map");
    const disp = document.createElementNS(SVG_NS, "feDisplacementMap");
    disp.setAttribute("in", "SourceGraphic");
    disp.setAttribute("in2", "map");
    disp.setAttribute("scale", String(strength));
    disp.setAttribute("xChannelSelector", "R");
    disp.setAttribute("yChannelSelector", "G");
    filter.append(image, disp);
    svgHolder().appendChild(filter);

    let raf = 0, lastW = 0, lastH = 0;
    const update = () => {
      raf = 0;
      const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
      if (!w || !h || (w === lastW && h === lastH)) return;
      lastW = w;
      lastH = h;
      image.setAttribute("width", String(w));
      image.setAttribute("height", String(h));
      image.setAttribute("href", displacementMap(w, h, radius, band));
      el.style.setProperty("--refract-filter", `url(#${id})`);
      el.dataset.refract = "";
    };
    const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(update); });
    ro.observe(el);
    update();
    return () => { ro.disconnect(); cancelAnimationFrame(raf); filter.remove(); };
  }, [id, radius, band, strength]);

  return ref;
}
