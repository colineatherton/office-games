// Flag specs + renderer for Flag Zoom.
// Every flag is drawn on canvas from the declarative layer list below — no
// emoji flags (Windows renders those as letter pairs, which would spoil the
// answer). Only flags renderable faithfully with these primitives are included;
// crest/emblem flags (Spain, Portugal, Mexico, Brazil, ...) are deliberately out.
//
// Layer types: bg, hstripes, hstripesW, vstripes, vband, canton, nordic, cross,
// freecross, disc, ring, crescent, star, starOutline, tri, diag, rays, quad.

export function drawFlag(ctx, layers, W, H) {
  for (const L of layers) {
    switch (L.t) {
      case "bg":
        ctx.fillStyle = L.color;
        ctx.fillRect(0, 0, W, H);
        break;
      case "hstripes": {
        const n = L.colors.length, h = H / n;
        L.colors.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(0, i * h, W, h + 1); });
        break;
      }
      case "hstripesW": {
        const total = L.stripes.reduce((s, [, w]) => s + w, 0);
        let y = 0;
        for (const [c, w] of L.stripes) {
          const h = (w / total) * H;
          ctx.fillStyle = c; ctx.fillRect(0, y, W, h + 1); y += h;
        }
        break;
      }
      case "vstripes": {
        const n = L.colors.length, w = W / n;
        L.colors.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(i * w, 0, w + 1, H); });
        break;
      }
      case "vband":
        ctx.fillStyle = L.color;
        ctx.fillRect(L.x * W, 0, L.w * W, H);
        break;
      case "canton":
        ctx.fillStyle = L.color;
        ctx.fillRect(0, 0, L.w * W, L.h * H);
        break;
      case "nordic": { // cross centered on the hoist-offset point, bars span the flag
        const w = L.w * H, cx = 0.36 * W;
        ctx.fillStyle = L.color;
        ctx.fillRect(cx - w / 2, 0, w, H);
        ctx.fillRect(0, H / 2 - w / 2, W, w);
        break;
      }
      case "cross": { // centered cross spanning a box (default: whole flag)
        const b = L.box || { x: 0, y: 0, w: 1, h: 1 };
        const bx = b.x * W, by = b.y * H, bw = b.w * W, bh = b.h * H;
        const w = L.w * bh;
        ctx.fillStyle = L.color;
        ctx.fillRect(bx + bw / 2 - w / 2, by, w, bh);
        ctx.fillRect(bx, by + bh / 2 - w / 2, bw, w);
        break;
      }
      case "freecross": { // floating cross (Switzerland)
        const w = L.w * H, l = L.l * H, cx = W / 2, cy = H / 2;
        ctx.fillStyle = L.color;
        ctx.fillRect(cx - w / 2, cy - l / 2, w, l);
        ctx.fillRect(cx - l / 2, cy - w / 2, l, w);
        break;
      }
      case "disc":
        ctx.fillStyle = L.color;
        ctx.beginPath();
        ctx.arc((L.cx ?? 0.5) * W, (L.cy ?? 0.5) * H, L.r * H, 0, Math.PI * 2);
        ctx.fill();
        break;
      case "ring":
        ctx.strokeStyle = L.color;
        ctx.lineWidth = L.lw * H;
        ctx.beginPath();
        ctx.arc((L.cx ?? 0.5) * W, (L.cy ?? 0.5) * H, L.r * H, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "crescent": { // solid disc with an offset bite of the background color
        const cx = L.cx * W, cy = (L.cy ?? 0.5) * H, r = L.r * H;
        ctx.fillStyle = L.color;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = L.bg;
        ctx.beginPath(); ctx.arc(cx + r * 0.38, cy, r * 0.82, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case "star":
        starPath(ctx, (L.cx ?? 0.5) * W, (L.cy ?? 0.5) * H, L.r * H, L.rot ?? -Math.PI / 2);
        ctx.fillStyle = L.color;
        ctx.fill();
        break;
      case "starOutline":
        starPath(ctx, (L.cx ?? 0.5) * W, (L.cy ?? 0.5) * H, L.r * H, L.rot ?? -Math.PI / 2);
        ctx.strokeStyle = L.color;
        ctx.lineWidth = L.lw * H;
        ctx.stroke();
        break;
      case "tri": { // triangle filling a corner against the main diagonal, or from the hoist
        ctx.fillStyle = L.color;
        ctx.beginPath();
        if (L.corner === "hoist") {
          ctx.moveTo(0, 0); ctx.lineTo((L.w ?? 0.45) * W, H / 2); ctx.lineTo(0, H);
        } else if (L.corner === "br") {
          ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.lineTo(W, H);
        } else if (L.corner === "tl") {
          ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.lineTo(0, 0);
        } else if (L.corner === "tr") {
          ctx.moveTo(0, 0); ctx.lineTo(W, H); ctx.lineTo(W, 0);
        } else { // bl
          ctx.moveTo(0, 0); ctx.lineTo(W, H); ctx.lineTo(0, H);
        }
        ctx.closePath(); ctx.fill();
        break;
      }
      case "diag": { // thick band corner-to-corner; dir "up" = (0,H)->(W,0)
        ctx.strokeStyle = L.color;
        ctx.lineWidth = L.w * H;
        ctx.lineCap = "square";
        ctx.beginPath();
        if (L.dir === "up") { ctx.moveTo(-10, H + 10); ctx.lineTo(W + 10, -10); }
        else { ctx.moveTo(-10, -10); ctx.lineTo(W + 10, H + 10); }
        ctx.stroke();
        break;
      }
      case "rays": { // simple sun rays (Argentina)
        const cx = (L.cx ?? 0.5) * W, cy = (L.cy ?? 0.5) * H;
        const r1 = L.r1 * H, r2 = L.r2 * H, n = L.n ?? 16;
        ctx.fillStyle = L.color;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2, s = 0.35 / n * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a - s) * r1, cy + Math.sin(a - s) * r1);
          ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
          ctx.lineTo(cx + Math.cos(a + s) * r1, cy + Math.sin(a + s) * r1);
          ctx.closePath(); ctx.fill();
        }
        break;
      }
      case "quad": { // four quarters [TL, TR, BL, BR]
        const [tl, tr, bl, br] = L.colors;
        ctx.fillStyle = tl; ctx.fillRect(0, 0, W / 2, H / 2);
        ctx.fillStyle = tr; ctx.fillRect(W / 2, 0, W / 2, H / 2);
        ctx.fillStyle = bl; ctx.fillRect(0, H / 2, W / 2, H / 2);
        ctx.fillStyle = br; ctx.fillRect(W / 2, H / 2, W / 2, H / 2);
        break;
      }
    }
  }
}

function starPath(ctx, cx, cy, r, rot) {
  const inner = r * 0.382;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : inner;
    const a = rot + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// name: shown on reveal; aliases: extra accepted answers (the name itself is
// always accepted). Spec = ordered layer list (painter's algorithm).
export const FLAGS = [
  // ── horizontal tricolors / bicolors ──
  { name: "Germany", aliases: [], spec: [{ t: "hstripes", colors: ["#000000", "#DD0000", "#FFCE00"] }] },
  { name: "Netherlands", aliases: ["Holland"], spec: [{ t: "hstripes", colors: ["#AE1C28", "#FFFFFF", "#21468B"] }] },
  { name: "Luxembourg", aliases: [], spec: [{ t: "hstripes", colors: ["#EF3340", "#FFFFFF", "#00A3E0"] }] },
  { name: "Russia", aliases: [], spec: [{ t: "hstripes", colors: ["#FFFFFF", "#0039A6", "#D52B1E"] }] },
  { name: "Austria", aliases: [], spec: [{ t: "hstripes", colors: ["#ED2939", "#FFFFFF", "#ED2939"] }] },
  { name: "Hungary", aliases: [], spec: [{ t: "hstripes", colors: ["#CE2939", "#FFFFFF", "#477050"] }] },
  { name: "Bulgaria", aliases: [], spec: [{ t: "hstripes", colors: ["#FFFFFF", "#00966E", "#D62612"] }] },
  { name: "Estonia", aliases: [], spec: [{ t: "hstripes", colors: ["#0072CE", "#000000", "#FFFFFF"] }] },
  { name: "Lithuania", aliases: [], spec: [{ t: "hstripes", colors: ["#FDB913", "#006A44", "#C1272D"] }] },
  { name: "Ukraine", aliases: [], spec: [{ t: "hstripes", colors: ["#0057B7", "#FFD700"] }] },
  { name: "Poland", aliases: [], spec: [{ t: "hstripes", colors: ["#FFFFFF", "#DC143C"] }] },
  { name: "Yemen", aliases: [], spec: [{ t: "hstripes", colors: ["#CE1126", "#FFFFFF", "#000000"] }] },
  { name: "Armenia", aliases: [], spec: [{ t: "hstripes", colors: ["#D90012", "#0033A0", "#F2A800"] }] },
  { name: "Sierra Leone", aliases: [], spec: [{ t: "hstripes", colors: ["#1EB53A", "#FFFFFF", "#0072C6"] }] },
  { name: "Gabon", aliases: [], spec: [{ t: "hstripes", colors: ["#009E60", "#FCD116", "#3A75C4"] }] },
  { name: "Indonesia", aliases: ["Monaco"], note: "also accepted: Monaco", spec: [{ t: "hstripes", colors: ["#CE1126", "#FFFFFF"] }] },
  // ── weighted horizontal stripes ──
  { name: "Latvia", aliases: [], spec: [{ t: "hstripesW", stripes: [["#9E3039", 2], ["#FFFFFF", 1], ["#9E3039", 2]] }] },
  { name: "Colombia", aliases: [], spec: [{ t: "hstripesW", stripes: [["#FCD116", 2], ["#003893", 1], ["#CE1126", 1]] }] },
  { name: "Thailand", aliases: [], spec: [{ t: "hstripesW", stripes: [["#A51931", 1], ["#F4F5F8", 1], ["#2D2A4A", 2], ["#F4F5F8", 1], ["#A51931", 1]] }] },
  { name: "Costa Rica", aliases: [], spec: [{ t: "hstripesW", stripes: [["#002B7F", 1], ["#FFFFFF", 1], ["#CE1126", 2], ["#FFFFFF", 1], ["#002B7F", 1]] }] },
  { name: "Botswana", aliases: [], spec: [{ t: "hstripesW", stripes: [["#6DA9D2", 9], ["#FFFFFF", 1], ["#000000", 4], ["#FFFFFF", 1], ["#6DA9D2", 9]] }] },
  // ── vertical tricolors ──
  { name: "France", aliases: [], spec: [{ t: "vstripes", colors: ["#0055A4", "#FFFFFF", "#EF4135"] }] },
  { name: "Italy", aliases: [], spec: [{ t: "vstripes", colors: ["#009246", "#FFFFFF", "#CE2B37"] }] },
  { name: "Ireland", aliases: [], spec: [{ t: "vstripes", colors: ["#169B62", "#FFFFFF", "#FF883E"] }] },
  { name: "Belgium", aliases: [], spec: [{ t: "vstripes", colors: ["#000000", "#FDDA24", "#EF3340"] }] },
  { name: "Mali", aliases: [], spec: [{ t: "vstripes", colors: ["#14B53A", "#FCD116", "#CE1126"] }] },
  { name: "Guinea", aliases: [], spec: [{ t: "vstripes", colors: ["#CE1126", "#FCD116", "#009460"] }] },
  { name: "Ivory Coast", aliases: ["Cote d'Ivoire", "Côte d'Ivoire"], spec: [{ t: "vstripes", colors: ["#F77F00", "#FFFFFF", "#009A44"] }] },
  { name: "Nigeria", aliases: [], spec: [{ t: "vstripes", colors: ["#008751", "#FFFFFF", "#008751"] }] },
  { name: "Peru", aliases: [], spec: [{ t: "vstripes", colors: ["#D91023", "#FFFFFF", "#D91023"] }] },
  { name: "Romania", aliases: ["Chad"], note: "also accepted: Chad", spec: [{ t: "vstripes", colors: ["#002B7F", "#FCD116", "#CE1126"] }] },
  // ── stars & emblems (simple) ──
  { name: "Senegal", aliases: [], spec: [{ t: "vstripes", colors: ["#00853F", "#FDEF42", "#E31B23"] }, { t: "star", color: "#00853F", r: 0.11 }] },
  { name: "Ghana", aliases: [], spec: [{ t: "hstripes", colors: ["#CE1126", "#FCD116", "#006B3F"] }, { t: "star", color: "#000000", r: 0.12 }] },
  { name: "Benin", aliases: [], spec: [{ t: "hstripes", colors: ["#FCD116", "#E8112D"] }, { t: "vband", color: "#008751", x: 0, w: 0.4 }] },
  { name: "Vietnam", aliases: [], spec: [{ t: "bg", color: "#DA251D" }, { t: "star", color: "#FFFF00", r: 0.2 }] },
  { name: "Somalia", aliases: [], spec: [{ t: "bg", color: "#4189DD" }, { t: "star", color: "#FFFFFF", r: 0.2 }] },
  { name: "Morocco", aliases: [], spec: [{ t: "bg", color: "#C1272D" }, { t: "starOutline", color: "#006233", r: 0.18, lw: 0.028 }] },
  { name: "Turkey", aliases: ["Turkiye", "Türkiye"], spec: [{ t: "bg", color: "#E30A17" }, { t: "crescent", color: "#FFFFFF", bg: "#E30A17", cx: 0.38, r: 0.2 }, { t: "star", color: "#FFFFFF", cx: 0.55, r: 0.08, rot: Math.PI / 2 + 0.3 }] },
  { name: "Japan", aliases: [], spec: [{ t: "bg", color: "#FFFFFF" }, { t: "disc", color: "#BC002D", r: 0.2 }] },
  { name: "Bangladesh", aliases: [], spec: [{ t: "bg", color: "#006A4E" }, { t: "disc", color: "#F42A41", cx: 0.45, r: 0.2 }] },
  { name: "Niger", aliases: [], spec: [{ t: "hstripes", colors: ["#E05206", "#FFFFFF", "#0DB02B"] }, { t: "disc", color: "#E05206", r: 0.12 }] },
  { name: "Laos", aliases: [], spec: [{ t: "hstripesW", stripes: [["#CE1126", 1], ["#002868", 2], ["#CE1126", 1]] }, { t: "disc", color: "#FFFFFF", r: 0.16 }] },
  { name: "India", aliases: [], note: "chakra simplified to a ring", spec: [{ t: "hstripes", colors: ["#FF9933", "#FFFFFF", "#138808"] }, { t: "ring", color: "#000080", r: 0.12, lw: 0.02 }] },
  { name: "Palau", aliases: [], spec: [{ t: "bg", color: "#4AADD6" }, { t: "disc", color: "#FFDE00", cx: 0.45, r: 0.17 }] },
  { name: "Argentina", aliases: [], spec: [{ t: "hstripes", colors: ["#75AADB", "#FFFFFF", "#75AADB"] }, { t: "rays", color: "#F6B40E", r1: 0.08, r2: 0.14, n: 16 }, { t: "disc", color: "#F6B40E", r: 0.09 }] },
  // ── Nordic crosses ──
  { name: "Denmark", aliases: [], spec: [{ t: "bg", color: "#C8102E" }, { t: "nordic", color: "#FFFFFF", w: 0.14 }] },
  { name: "Sweden", aliases: [], spec: [{ t: "bg", color: "#006AA7" }, { t: "nordic", color: "#FECC02", w: 0.14 }] },
  { name: "Norway", aliases: [], spec: [{ t: "bg", color: "#BA0C2F" }, { t: "nordic", color: "#FFFFFF", w: 0.2 }, { t: "nordic", color: "#00205B", w: 0.1 }] },
  { name: "Finland", aliases: [], spec: [{ t: "bg", color: "#FFFFFF" }, { t: "nordic", color: "#002F6C", w: 0.16 }] },
  { name: "Iceland", aliases: [], spec: [{ t: "bg", color: "#02529C" }, { t: "nordic", color: "#FFFFFF", w: 0.2 }, { t: "nordic", color: "#DC1E35", w: 0.1 }] },
  // ── crosses ──
  { name: "Switzerland", aliases: [], spec: [{ t: "bg", color: "#DA291C" }, { t: "freecross", color: "#FFFFFF", w: 0.16, l: 0.52 }] },
  { name: "England", aliases: [], spec: [{ t: "bg", color: "#FFFFFF" }, { t: "cross", color: "#CE1124", w: 0.18 }] },
  { name: "Scotland", aliases: [], spec: [{ t: "bg", color: "#005EB8" }, { t: "diag", color: "#FFFFFF", dir: "up", w: 0.16 }, { t: "diag", color: "#FFFFFF", dir: "down", w: 0.16 }] },
  { name: "United Kingdom", aliases: ["UK", "Britain", "Great Britain"], spec: [
    { t: "bg", color: "#012169" },
    { t: "diag", color: "#FFFFFF", dir: "up", w: 0.2 }, { t: "diag", color: "#FFFFFF", dir: "down", w: 0.2 },
    { t: "diag", color: "#C8102E", dir: "up", w: 0.08 }, { t: "diag", color: "#C8102E", dir: "down", w: 0.08 },
    { t: "cross", color: "#FFFFFF", w: 0.32 }, { t: "cross", color: "#C8102E", w: 0.18 },
  ] },
  { name: "Greece", aliases: [], spec: [
    { t: "hstripes", colors: ["#0D5EAF", "#FFFFFF", "#0D5EAF", "#FFFFFF", "#0D5EAF", "#FFFFFF", "#0D5EAF", "#FFFFFF", "#0D5EAF"] },
    { t: "canton", color: "#0D5EAF", w: 0.37, h: 0.556 },
    { t: "cross", color: "#FFFFFF", w: 0.2, box: { x: 0, y: 0, w: 0.37, h: 0.556 } },
  ] },
  // ── cantons, triangles, diagonals ──
  { name: "United States", aliases: ["USA", "America", "United States of America", "US"], note: "canton stars omitted", spec: [
    { t: "hstripes", colors: ["#B22234", "#FFFFFF", "#B22234", "#FFFFFF", "#B22234", "#FFFFFF", "#B22234", "#FFFFFF", "#B22234", "#FFFFFF", "#B22234", "#FFFFFF", "#B22234"] },
    { t: "canton", color: "#3C3B6E", w: 0.4, h: 0.538 },
  ] },
  { name: "Chile", aliases: [], spec: [
    { t: "hstripes", colors: ["#FFFFFF", "#D52B1E"] },
    { t: "canton", color: "#0039A6", w: 0.333, h: 0.5 },
    { t: "star", color: "#FFFFFF", cx: 0.167, cy: 0.25, r: 0.1 },
  ] },
  { name: "Czechia", aliases: ["Czech Republic"], spec: [
    { t: "hstripes", colors: ["#FFFFFF", "#D7141A"] },
    { t: "tri", color: "#11457E", corner: "hoist", w: 0.45 },
  ] },
  { name: "Philippines", aliases: [], note: "sun & stars simplified away", spec: [
    { t: "hstripes", colors: ["#0038A8", "#CE1126"] },
    { t: "tri", color: "#FFFFFF", corner: "hoist", w: 0.42 },
  ] },
  { name: "Cuba", aliases: [], spec: [
    { t: "hstripes", colors: ["#002A8F", "#FFFFFF", "#002A8F", "#FFFFFF", "#002A8F"] },
    { t: "tri", color: "#CF142B", corner: "hoist", w: 0.42 },
    { t: "star", color: "#FFFFFF", cx: 0.14, cy: 0.5, r: 0.1 },
  ] },
  { name: "Tanzania", aliases: [], spec: [
    { t: "tri", color: "#1EB53A", corner: "tl" },
    { t: "tri", color: "#00A3DD", corner: "br" },
    { t: "diag", color: "#FCD116", dir: "up", w: 0.3 },
    { t: "diag", color: "#000000", dir: "up", w: 0.17 },
  ] },
  { name: "Panama", aliases: [], spec: [
    { t: "quad", colors: ["#FFFFFF", "#D21034", "#005293", "#FFFFFF"] },
    { t: "star", color: "#005293", cx: 0.25, cy: 0.25, r: 0.1 },
    { t: "star", color: "#D21034", cx: 0.75, cy: 0.75, r: 0.1 },
  ] },
  { name: "United Arab Emirates", aliases: ["UAE", "Emirates"], spec: [
    { t: "hstripes", colors: ["#00732F", "#FFFFFF", "#000000"] },
    { t: "vband", color: "#FF0000", x: 0, w: 0.28 },
  ] },
  { name: "Madagascar", aliases: [], spec: [
    { t: "hstripes", colors: ["#FC3D32", "#007E3A"] },
    { t: "vband", color: "#FFFFFF", x: 0, w: 0.33 },
  ] },
];
