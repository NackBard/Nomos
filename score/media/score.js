// The score page (D-065): tiles, Martin's diagram, scatter plots, percolation, reach of changes, tables and the key
// problems, drawn as SVG from the data of src/core/dashboard.ts. The page holds no words: texts come in `strings`.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const tip = document.getElementById("tip");
  const SVGNS = "http://www.w3.org/2000/svg";
  const locale = document.documentElement.lang || "en";
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const fine = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  let S = null;
  let state = null;
  /** Sorting of the module table, kept while the page lives. */
  let sort = { key: "overall", dir: 1 };

  // ---- text ---------------------------------------------------------------------------------------------------------

  function russianForm(value) {
    if (!Number.isInteger(value)) return 1;
    const n = Math.abs(value) % 100;
    if (n % 10 === 1 && n !== 11) return 0;
    if (n % 10 >= 2 && n % 10 <= 4 && (n < 12 || n > 14)) return 1;
    return 2;
  }
  /** Fills a template of spec/l10n.md: {n}, {n|one|few|many}; numbers are formatted in the page's locale. */
  function fill(template, ...args) {
    return template.replace(/\{\{|\}\}|\{(\d+)(?:\|([^{}]*))?\}/g, (whole, index, forms) => {
      if (whole === "{{") return "{";
      if (whole === "}}") return "}";
      const value = args[Number(index)];
      if (value === undefined) return whole;
      if (forms !== undefined) return forms.split("|")[locale === "ru" ? russianForm(Number(value)) : Number(value) === 1 ? 0 : 1] ?? "";
      return typeof value === "number" ? number.format(value) : String(value);
    });
  }
  const show = (v) => (v === null || v === undefined ? S.notDefined : number.format(v));
  const show2 = (v) => (v === null || v === undefined ? S.notDefined : fine.format(v));
  const percent = (share) => number.format(share * 100);
  // Tables say "not defined" through a dash, with the word in the tooltip.
  const dash = (v) => (v === null || v === undefined ? "—" : number.format(v));

  // ---- DOM ----------------------------------------------------------------------------------------------------------

  function el(tag, attrs, parent, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function svg(tag, attrs, parent, text) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function hover(target, text) {
    target.addEventListener("mouseenter", () => { tip.textContent = typeof text === "function" ? text() : text; tip.style.display = "block"; });
    target.addEventListener("mousemove", (event) => place(event));
    target.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  }
  function place(event) {
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const x = event.clientX + 14 + w > window.innerWidth ? event.clientX - w - 10 : event.clientX + 14;
    const y = event.clientY + 14 + h > window.innerHeight ? event.clientY - h - 10 : event.clientY + 14;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
  }
  function card(parent, title, about, wide) {
    const c = el("section", { class: wide ? "card wide" : "card" }, parent);
    el("h2", {}, c, title);
    if (about) el("p", { class: "about" }, c, about);
    return c;
  }
  const openModule = (id) => vscode.postMessage({ type: "module", id });
  const openCode = (file, line) => file && vscode.postMessage({ type: "open", file, line: line || 1 });

  // ---- color --------------------------------------------------------------------------------------------------------

  function token(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }
  function rgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return [128, 128, 128];
    const v = parseInt(m[1], 16);
    return [v >> 16, (v >> 8) & 255, v & 255];
  }
  /** Diverging color of a score: low pole, gray midpoint at 50, high pole. */
  function scoreColor(value) {
    if (value === null || value === undefined) return token("--muted");
    const t = Math.max(0, Math.min(1, value / 100));
    const [a, b, k] = t < 0.5 ? [rgb(token("--low")), rgb(token("--mid")), t * 2] : [rgb(token("--mid")), rgb(token("--high")), (t - 0.5) * 2];
    return `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * k)).join(",")})`;
  }
  const classColor = { core: "--series-2", shared: "--series-1", control: "--series-3", periphery: "--muted" };

  function meter(parent, value) {
    const m = el("div", { class: "meter" }, parent);
    const bar = el("div", {}, m);
    bar.style.width = `${Math.max(0, Math.min(100, value ?? 0))}%`;
    bar.style.background = scoreColor(value);
    return m;
  }
  function chip(parent, value) {
    const c = el("span", { class: "chip" }, parent);
    const bar = el("i", {}, c);
    bar.style.width = `${Math.max(0, Math.min(100, value ?? 0))}%`;
    bar.style.background = scoreColor(value);
  }

  // ---- charts -------------------------------------------------------------------------------------------------------

  const W = 460, H = 320, M = { left: 48, right: 16, top: 12, bottom: 40 };
  const plotW = W - M.left - M.right, plotH = H - M.top - M.bottom;

  function frame(parent, xLabel, yLabel) {
    const root = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img" }, parent);
    const g = svg("g", { transform: `translate(${M.left} ${M.top})` }, root);
    svg("text", { x: M.left + plotW / 2, y: H - 6, "text-anchor": "middle" }, root, xLabel);
    svg("text", { transform: `translate(12 ${M.top + plotH / 2}) rotate(-90)`, "text-anchor": "middle" }, root, yLabel);
    return { root, g };
  }
  function linearTicks(max, count) {
    if (max <= 0) return [0];
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((s) => s * mag).find((s) => s >= raw) || raw;
    const ticks = [];
    for (let v = 0; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
    return ticks;
  }
  /** Square-root scale for counts with long tails: zero stays at the origin. */
  function sqrtScale(max, length) {
    const top = Math.max(1, max);
    const f = (v) => (Math.sqrt(Math.max(0, v)) / Math.sqrt(top)) * length;
    const ticks = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter((v) => v <= top);
    return { f, ticks: ticks.length > 6 ? ticks.filter((_, i) => i % 2 === 0 || i === ticks.length - 1) : ticks, max: top };
  }
  function axes(g, xs, ys, xFormat, yFormat) {
    for (const v of ys.ticks) {
      const y = plotH - ys.f(v);
      svg("line", { class: "tick", x1: 0, x2: plotW, y1: y, y2: y }, g);
      svg("text", { x: -6, y: y + 4, "text-anchor": "end" }, g, yFormat(v));
    }
    for (const v of xs.ticks) {
      const x = xs.f(v);
      svg("line", { class: "tick", x1: x, x2: x, y1: 0, y2: plotH }, g);
      svg("text", { x, y: plotH + 16, "text-anchor": "middle" }, g, xFormat(v));
    }
    svg("line", { class: "axis", x1: 0, x2: plotW, y1: plotH, y2: plotH }, g);
    svg("line", { class: "axis", x1: 0, x2: 0, y1: 0, y2: plotH }, g);
  }
  const unitScale = (length) => ({ f: (v) => v * length, ticks: [0, 0.25, 0.5, 0.75, 1] });
  const radius = (loc, maxLoc) => 4 + 10 * Math.sqrt(Math.max(1, loc) / Math.max(1, maxLoc));

  function martin(parent, modules, selected) {
    const c = card(parent, S.cards.martin, S.cards.martinAbout);
    const { g } = frame(c, S.axes.instability, S.axes.abstractness);
    const xs = unitScale(plotW), ys = unitScale(plotH);
    // Zones of spec/score.md: D ≥ 0.5 below the line (pain) and above it (uselessness).
    svg("path", { class: "zone", d: `M0 ${plotH} L${plotW / 2} ${plotH} L0 ${plotH / 2} Z` }, g);
    svg("path", { class: "zone-2", d: `M${plotW} 0 L${plotW / 2} 0 L${plotW} ${plotH / 2} Z` }, g);
    axes(g, xs, ys, show2, show2);
    svg("line", { class: "sequence", x1: 0, y1: 0, x2: plotW, y2: plotH }, g);
    svg("text", { x: plotW * 0.62, y: plotH * 0.62 - 6, transform: `rotate(${(Math.atan2(plotH, plotW) * 180) / Math.PI} ${plotW * 0.62} ${plotH * 0.62 - 6})` }, g, S.axes.mainSequence);
    svg("text", { x: 6, y: plotH / 2 + 16, class: "label-ink" }, g, S.zones.pain);
    svg("text", { x: plotW - 6, y: plotH / 2 - 8, "text-anchor": "end", class: "label-ink" }, g, S.zones.uselessness);
    const drawn = modules.filter((m) => m.instability !== null && m.abstractness !== null);
    const maxLoc = Math.max(1, ...drawn.map((m) => m.loc));
    // Large circles first, so that small ones stay on top and reachable.
    for (const m of [...drawn].sort((a, b) => b.loc - a.loc)) {
      const cls = `dot${selected ? (m.id === selected ? " selected" : " faded") : ""}`;
      const dot = svg("circle", { class: cls, cx: xs.f(m.instability), cy: plotH - ys.f(m.abstractness), r: radius(m.loc, maxLoc), fill: scoreColor(m.overall) }, g);
      hover(dot, `${fill(S.tips.module, m.name, fine.format(m.instability), fine.format(m.abstractness), show2(m.distance), m.loc, show(m.overall))}\n${S.tips.openModule}`);
      dot.addEventListener("click", () => openModule(m.id));
    }
    // The selected module on top of the others.
    const chosen = g.querySelector("circle.selected");
    if (chosen) g.appendChild(chosen);
    const legend = el("div", { class: "legend" }, c);
    el("span", { class: "gradient" }, legend, `0 — 100 ${S.scores.overall.name}`);
    const omitted = modules.length - drawn.length;
    if (omitted) el("span", { style: "--swatch: transparent" }, legend, fill(S.martinOmitted, omitted));
  }

  function couplingChart(parent, modules) {
    const c = card(parent, S.cards.coupling, S.cards.couplingAbout);
    const { g } = frame(c, S.axes.ca, S.axes.ce);
    const drawn = modules.filter((m) => m.ca !== null && m.ce !== null);
    const xs = sqrtScale(Math.max(1, ...drawn.map((m) => m.ca)), plotW);
    const ys = sqrtScale(Math.max(1, ...drawn.map((m) => m.ce)), plotH);
    axes(g, xs, ys, String, String);
    const maxLoc = Math.max(1, ...drawn.map((m) => m.loc));
    for (const m of [...drawn].sort((a, b) => b.loc - a.loc)) {
      const dot = svg("circle", { class: "dot", cx: xs.f(m.ca), cy: plotH - ys.f(m.ce), r: radius(m.loc, maxLoc), fill: scoreColor(m.overall) }, g);
      hover(dot, `${fill(S.tips.coupling, m.name, m.ca, m.ce, m.loc)}\n${S.tips.openModule}`);
      dot.addEventListener("click", () => openModule(m.id));
    }
    const legend = el("div", { class: "legend" }, c);
    el("span", { class: "gradient" }, legend, `0 — 100 ${S.scores.overall.name}`);
  }

  function visibilityChart(parent, data) {
    const c = card(parent, S.cards.visibility, S.cards.visibilityAbout);
    const { g } = frame(c, S.axes.fanIn, S.axes.fanOut);
    const xs = sqrtScale(Math.max(1, ...data.points.map((p) => p.blastRadius)), plotW);
    const ys = sqrtScale(Math.max(1, ...data.points.map((p) => p.fanOut)), plotH);
    axes(g, xs, ys, String, String);
    // Periphery under the rest: the classes that matter stay visible.
    const order = { periphery: 0, control: 1, shared: 2, core: 3 };
    for (const p of [...data.points].sort((a, b) => order[a.cls] - order[b.cls])) {
      const dot = svg("circle", { class: "dot", cx: xs.f(p.blastRadius), cy: plotH - ys.f(p.fanOut), r: 4, fill: token(classColor[p.cls]) }, g);
      hover(dot, `${fill(S.tips.unit, p.name, p.module, p.blastRadius, p.fanOut, S.classes[p.cls])}\n${S.tips.openCode}`);
      dot.addEventListener("click", () => openCode(p.file, p.line));
    }
    const legend = el("div", { class: "legend" }, c);
    for (const cls of ["core", "shared", "control", "periphery"]) {
      const item = el("span", {}, legend, `${S.classes[cls]} ${data.classes[cls]}`);
      item.style.setProperty("--swatch", token(classColor[cls]));
      item.title = S.classHints[cls];
    }
    if (data.pointsOmitted) el("span", { style: "--swatch: transparent" }, legend, fill(S.tips.omitted, data.pointsOmitted));
  }

  function percolationChart(parent, data) {
    const c = card(parent, S.cards.percolation, S.cards.percolationAbout);
    if (!data.percolation) {
      el("div", { class: "empty" }, c, S.cards.noPercolation);
      return;
    }
    const { g } = frame(c, S.axes.removed, S.axes.largest);
    const xs = unitScale(plotW), ys = unitScale(plotH);
    axes(g, xs, ys, (v) => `${percent(v)}%`, (v) => `${percent(v)}%`);
    const series = [
      { points: data.percolation.degree, color: token("--series-1"), name: S.axes.byDegree },
      { points: data.percolation.blast, color: token("--series-2"), name: S.axes.byBlast },
    ];
    for (const s of series) {
      svg("path", { class: "curve", stroke: s.color, d: s.points.map(([x, y], i) => `${i ? "L" : "M"}${xs.f(x).toFixed(1)} ${(plotH - ys.f(y)).toFixed(1)}`).join("") }, g);
    }
    // Direct labels where the curves are still apart: at a tenth of the way.
    const labelAt = (points, share) => points.find(([x]) => x >= share) || points[points.length - 1];
    series.forEach((s, i) => {
      const [x, y] = labelAt(s.points, 0.3 + i * 0.25);
      svg("text", { x: xs.f(x) + 6, y: plotH - ys.f(y) - 6, class: "label-ink" }, g, s.name);
    });
    const critical = data.percolation.critical;
    if (critical !== null) {
      const x = xs.f(critical);
      svg("line", { class: "critical", x1: x, x2: x, y1: 0, y2: plotH }, g);
      svg("text", { x: x + 4, y: 12 }, g, fill(S.axes.critical, critical * 100));
    }
    // Crosshair: the nearest removed share, both curves.
    const cross = svg("line", { class: "cross", y1: 0, y2: plotH, visibility: "hidden" }, g);
    const area = svg("rect", { x: 0, y: 0, width: plotW, height: plotH, fill: "transparent" }, g);
    area.addEventListener("mousemove", (event) => {
      const box = area.getBoundingClientRect();
      const share = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
      const near = (points) => points.reduce((best, p) => (Math.abs(p[0] - share) < Math.abs(best[0] - share) ? p : best));
      const [x] = near(series[0].points);
      cross.setAttribute("x1", xs.f(x));
      cross.setAttribute("x2", xs.f(x));
      cross.setAttribute("visibility", "visible");
      tip.textContent = series.map((s) => fill(S.tips.percolation, percent(near(s.points)[0]), percent(near(s.points)[1]), s.name)).join("\n");
      tip.style.display = "block";
      place(event);
    });
    area.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); tip.style.display = "none"; });
    const legend = el("div", { class: "legend" }, c);
    for (const s of series) el("span", {}, legend, s.name).style.setProperty("--swatch", s.color);
  }

  function histogramChart(parent, data) {
    const c = card(parent, S.cards.histogram, S.cards.histogramAbout);
    const { g } = frame(c, S.axes.reach, S.axes.count);
    const max = Math.max(1, ...data.histogram.map((b) => b.count));
    const ys = { f: (v) => (v / max) * plotH, ticks: linearTicks(max, 4) };
    axes(g, { f: () => 0, ticks: [] }, ys, String, (v) => number.format(v));
    const slot = plotW / data.histogram.length;
    data.histogram.forEach((b, i) => {
      const label = b.to === 0 ? "0" : `${percent(b.from)}–${percent(b.to)}%`;
      const h = ys.f(b.count);
      const x = i * slot + 4;
      const w = slot - 8;
      // Rounded at the data end only, anchored to the baseline.
      const r = Math.min(4, h, w / 2);
      const d = h > 0 ? `M${x} ${plotH} V${plotH - h + r} Q${x} ${plotH - h} ${x + r} ${plotH - h} H${x + w - r} Q${x + w} ${plotH - h} ${x + w} ${plotH - h + r} V${plotH} Z` : "";
      if (d) hover(svg("path", { class: "bar", d }, g), fill(S.tips.bucket, b.count, label));
      svg("text", { x: x + w / 2, y: plotH + 16, "text-anchor": "middle" }, g, label);
      if (b.count) svg("text", { x: x + w / 2, y: plotH - h - 4, "text-anchor": "middle", class: "label-ink" }, g, number.format(b.count));
    });
  }

  // ---- lists and tables ---------------------------------------------------------------------------------------------

  function componentDetail(key, inputs) {
    const c = S.components[key];
    const i = inputs;
    switch (key) {
      case "mainSequence": return fill(c.detail, show2(i.instability), show2(i.abstractness), show2(i.distance));
      case "acyclic": return i.moduleCycle ? c.detailModule : fill(c.detail, i.unitsInCycles, i.units);
      case "containment": return fill(c.detail, i.maxBlastRadius ?? 0, Math.max(0, (i.systemUnits ?? 1) - 1));
      case "coupling": return fill(c.detail, show(i.meanCbo), show(i.maxCbo), i.types);
      case "cohesion": return fill(c.detail, show(i.meanLcom4), show(i.maxLcom4), i.types);
      case "typeSize": return fill(c.detail, show(i.meanWmc), show(i.maxWmc), i.types);
      case "inheritance": return fill(c.detail, show(i.meanDit), show(i.maxDit), i.types);
      case "designFindings": case "codeFindings": return fill(c.detail, i.findings, show(i.penalty), show2(i.kloc));
      case "maintainabilityIndex": return fill(c.detail, show(i.meanMi), i.functions);
      case "complexity": return fill(c.detail, show(i.meanCyclomatic), show(i.maxCyclomatic), i.functions);
      default: return "";
    }
  }
  function componentHint(p) {
    if (p.component === "mainSequence" && p.inputs.distance >= 0.5) {
      return (p.inputs.abstractness ?? 0) + (p.inputs.instability ?? 0) < 1 ? S.zoneHints.pain : S.zoneHints.uselessness;
    }
    return S.components[p.component].hint;
  }

  function problems(parent, list, withModule) {
    const c = card(parent, S.cards.problems, S.cards.problemsAbout, true);
    if (!list.length) {
      el("div", { class: "empty" }, c, S.cards.noProblems);
      return;
    }
    const top = Math.max(...list.map((p) => p.lost));
    const box = el("div", { class: "problems" }, c);
    for (const p of list) {
      const row = el("div", { class: "problem" }, box);
      const lost = el("div", { class: "lost", title: fill(S.tips.lost, fine.format(p.lost)) }, row, `−${fine.format(p.lost)}`);
      const m = el("div", { class: "meter" }, lost);
      const bar = el("div", {}, m);
      bar.style.width = `${(p.lost / top) * 100}%`;
      bar.style.background = token("--low");
      const what = el("div", { class: "what" }, row);
      if (withModule) {
        const a = el("a", { class: "module", title: S.tips.openModule }, what, p.name);
        a.addEventListener("click", () => openModule(p.module));
        what.append(" · ");
      }
      what.append(`${S.components[p.component].name} ${number.format(p.value)} (${S.scores[p.score].name})`);
      el("div", { class: "detail" }, what, componentDetail(p.component, p.inputs));
      el("div", { class: "hint" }, what, componentHint(p));
    }
  }

  /** A table whose rows come from `rows`; a header click sorts by its column, a row click calls `onRow`. */
  function table(parent, columns, rows, onRow, options) {
    const wrap = el("div", { class: "scroll" }, parent);
    const t = el("table", {}, wrap);
    const head = el("tr", {}, el("thead", {}, t));
    const body = el("tbody", {}, t);
    const local = options?.sort ?? { key: null, dir: 1 };
    const render = () => {
      head.textContent = "";
      for (const col of columns) {
        const th = el("th", { "aria-sort": local.key === col.key ? (local.dir > 0 ? "descending" : "ascending") : undefined, title: col.title }, head, col.name);
        th.addEventListener("click", () => {
          local.dir = local.key === col.key ? -local.dir : 1;
          local.key = col.key;
          options?.onSort?.(local);
          render();
        });
      }
      body.textContent = "";
      const sorted = local.key ? [...rows].sort((a, b) => compare(columns.find((c) => c.key === local.key).value(a), columns.find((c) => c.key === local.key).value(b)) * local.dir) : rows;
      for (const r of sorted) {
        const tr = el("tr", { class: `${onRow ? "link" : ""}${options?.selected && options.selected(r) ? " selected" : ""}` }, body);
        for (const col of columns) {
          const td = el("td", {}, tr);
          (col.cell || ((cell, row) => (cell.textContent = col.text ? col.text(row) : String(col.value(row) ?? ""))))(td, r);
        }
        if (onRow) tr.addEventListener("click", () => onRow(r));
        if (options?.title) tr.title = options.title;
      }
    };
    render();
    return t;
  }
  /** Larger first; a missing value sorts last. */
  function compare(a, b) {
    const missing = (v) => v === null || v === undefined;
    if (missing(a) && missing(b)) return 0;
    if (missing(a)) return 1;
    if (missing(b)) return -1;
    if (typeof a === "string") return a.localeCompare(b, locale);
    return b - a;
  }
  const scoreCell = (key) => ({
    key, name: key === "overall" ? S.scores.overall.name : S.scores[key].name,
    value: (r) => (key === "overall" ? r.overall : r.scores[key]),
    cell: (td, r) => { const v = key === "overall" ? r.overall : r.scores[key]; td.textContent = dash(v); if (v === null) td.title = S.notDefined; else chip(td, v); },
  });

  function moduleTable(parent, modules) {
    const c = card(parent, S.cards.modules, S.inspectHint, true);
    const zone = (m) => (m.zone ? S.zones[m.zone] : m.inModuleCycle ? S.cycleMark : "");
    table(c, [
      { key: "name", name: S.columns.module, value: (m) => m.name, cell: (td, m) => { td.textContent = m.name; td.title = m.id; } },
      { key: "loc", name: S.columns.lines, value: (m) => m.loc },
      scoreCell("overall"), scoreCell("stability"), scoreCell("extensibility"), scoreCell("conformance"), scoreCell("maintainability"),
      { key: "instability", name: "I", value: (m) => m.instability, text: (m) => (m.instability === null ? "—" : fine.format(m.instability)) },
      { key: "abstractness", name: "A", value: (m) => m.abstractness, text: (m) => (m.abstractness === null ? "—" : fine.format(m.abstractness)) },
      { key: "distance", name: "D", value: (m) => m.distance, text: (m) => (m.distance === null ? "—" : fine.format(m.distance)) },
      { key: "zone", name: S.columns.zone, value: zone, text: zone },
    ], modules, (m) => openModule(m.id), { sort, onSort: (s) => (sort = s), title: S.tips.openModule });
  }

  function hubList(parent, data) {
    const c = card(parent, S.cards.hubs, S.cards.hubsAbout);
    if (!data.hubs.length) {
      el("div", { class: "empty" }, c, S.cards.noHubs);
      return;
    }
    table(c, [
      { key: "name", name: S.columns.unit, value: (h) => h.name, cell: (td, h) => { td.textContent = h.name; td.title = `${h.id}\n${S.tips.openCode}`; } },
      { key: "module", name: S.columns.module, value: (h) => h.module, cell: (td, h) => { const a = el("a", { class: "module", title: S.tips.openModule }, td, h.module.split("/").pop()); a.addEventListener("click", (e) => { e.stopPropagation(); openModule(h.module); }); } },
      { key: "share", name: S.columns.share, value: (h) => h.share, text: (h) => `${percent(h.share)}%` },
      { key: "fanOut", name: S.columns.fanOut, value: (h) => h.fanOut },
      { key: "cls", name: S.columns.cls, value: (h) => S.classes[h.cls], text: (h) => S.classes[h.cls] },
      { key: "cycle", name: S.columns.cycle, value: (h) => (h.inCycle ? 1 : 0), text: (h) => (h.inCycle ? S.yes : "") },
    ], data.hubs, (h) => openCode(h.file, h.line));
  }

  // ---- tiles --------------------------------------------------------------------------------------------------------

  function tile(parent, name, value, about, parts) {
    const t = el("div", { class: "tile" }, parent);
    el("div", { class: "label" }, t, name);
    const v = el("div", { class: "value" }, t, show(value));
    if (value !== null && value !== undefined) el("small", {}, v, " / 100");
    meter(t, value);
    if (about) el("p", { class: "about" }, t, about);
    if (parts?.length) {
      const list = el("div", { class: "parts" }, t);
      for (const p of parts) {
        const part = el("div", { class: "part" }, list);
        const row = el("div", { class: "row" }, part);
        el("span", {}, row, p.name);
        el("span", {}, row, show(p.value));
        meter(part, p.value);
        if (p.detail) el("div", { class: "detail" }, part, p.detail);
      }
    }
    return t;
  }

  function scalabilityParts(s, units) {
    return [
      { name: S.components.propagation.name, value: s.propagation, detail: s.propagationCost === null ? "" : fill(S.components.propagation.detail, percent(s.propagationCost)) },
      { name: S.components.core.name, value: s.core, detail: fill(S.components.core.detail, s.largestCycle, units) },
      { name: S.components.decomposability.name, value: s.decomposability, detail: s.robustness === null ? "" : fill(S.components.decomposability.detail, fine.format(s.robustness), s.criticalShare === null ? 0 : percent(s.criticalShare)) },
    ];
  }

  // ---- views --------------------------------------------------------------------------------------------------------

  function header(data, title, back) {
    const h = el("header", {}, app);
    if (back) el("button", {}, h, S.back).addEventListener("click", () => vscode.postMessage({ type: "system" }));
    el("h1", {}, h, title);
    if (state.runs.length > 1) {
      const label = el("label", {}, h, `${S.analysis} `);
      const select = el("select", {}, label);
      state.runs.forEach((r, i) => el("option", { value: i, selected: i === state.run ? "selected" : undefined }, select, r));
      select.addEventListener("change", () => vscode.postMessage({ type: "run", index: Number(select.value) }));
    }
    return h;
  }

  function systemView(data) {
    header(data, `${S.title} · ${data.language}`, false);
    el("p", { class: "note" }, app, `${fill(S.summary, data.modules.length, data.units, data.edges, data.loc)}. ${S.note}`);
    const tiles = el("div", { class: "tiles" }, app);
    tile(tiles, S.scores.overall.name, data.overall, S.scores.overall.about);
    for (const s of data.scores) tile(tiles, S.scores[s.key].name, s.value, S.scores[s.key].about);
    tile(tiles, S.scores.scalability.name, data.scalability.value, S.scores.scalability.about, scalabilityParts(data.scalability, data.units));
    const grid = el("div", { class: "grid" }, app);
    problems(grid, data.problems, true);
    martin(grid, data.modules);
    couplingChart(grid, data.modules);
    visibilityChart(grid, data);
    percolationChart(grid, data);
    histogramChart(grid, data);
    hubList(grid, data);
    moduleTable(grid, data.modules);
  }

  function moduleView(data) {
    const m = data.module;
    header(data, `${m.name}`, true);
    el("p", { class: "note" }, app, `${m.id} · ${data.language}. ${fill(S.moduleSummary, m.units, m.loc, m.findings, show(data.systemOverall))}${m.zone ? ` · ${S.zones[m.zone]}` : ""}`);
    const tiles = el("div", { class: "tiles" }, app);
    tile(tiles, S.scores.overall.name, m.overall, S.scores.overall.about);
    for (const s of m.components) {
      tile(tiles, S.scores[s.key].name, s.value, null, s.components.map((c) => ({ name: S.components[c.key].name, value: c.value, detail: c.value === null ? S.notDefined : componentDetail(c.key, c.inputs) })));
    }
    const grid = el("div", { class: "grid" }, app);
    problems(grid, data.problems, false);
    martin(grid, data.modules, m.id);

    const links = card(grid, S.cards.links);
    const box = el("div", { class: "links" }, links);
    for (const [title, list] of [[S.cards.incoming, data.incoming], [S.cards.outgoing, data.outgoing]]) {
      const col = el("div", {}, box);
      el("h2", {}, col, `${title} (${list.length})`);
      const ul = el("ul", {}, col);
      if (!list.length) el("li", { class: "empty" }, ul, S.cards.noLinks);
      for (const l of list.slice(0, 25)) {
        const li = el("li", {}, ul);
        el("a", { class: "module", title: `${l.module}\n${S.tips.openModule}` }, li, l.name).addEventListener("click", () => openModule(l.module));
        el("span", {}, li, number.format(l.count));
      }
    }

    const cats = card(grid, S.cards.categories);
    if (!data.categories.length) el("div", { class: "empty" }, cats, S.cards.noFindings);
    else table(cats, [
      { key: "category", name: S.columns.category, value: (c) => c.category },
      { key: "count", name: S.columns.findings, value: (c) => c.count },
      { key: "penalty", name: S.columns.penalty, value: (c) => c.penalty, text: (c) => number.format(c.penalty) },
    ], data.categories);

    const units = card(grid, S.cards.units, null, true);
    table(units, [
      { key: "name", name: S.columns.unit, value: (u) => u.name, cell: (td, u) => { td.textContent = u.name; td.title = `${u.id} (${u.isType ? S.type : S.function})\n${S.tips.openCode}`; } },
      { key: "blastRadius", name: S.columns.blastRadius, value: (u) => u.blastRadius },
      { key: "fanOut", name: S.columns.fanOut, value: (u) => u.fanOut },
      { key: "cls", name: S.columns.cls, value: (u) => S.classes[u.cls], text: (u) => S.classes[u.cls] },
      { key: "cycle", name: S.columns.cycle, value: (u) => (u.inCycle ? 1 : 0), text: (u) => (u.inCycle ? S.yes : "") },
      { key: "cbo", name: "CBO", value: (u) => u.metrics.cbo, text: (u) => dash(u.metrics.cbo) },
      { key: "lcom4", name: "LCOM4", value: (u) => u.metrics.lcom4, text: (u) => dash(u.metrics.lcom4) },
      { key: "wmc", name: "WMC", value: (u) => u.metrics.wmc, text: (u) => dash(u.metrics.wmc) },
      { key: "dit", name: "DIT", value: (u) => u.metrics.dit, text: (u) => dash(u.metrics.dit) },
      { key: "cyclomatic", name: S.columns.cyclomatic, value: (u) => u.metrics.cyclomatic, text: (u) => dash(u.metrics.cyclomatic) },
      { key: "mi", name: S.columns.mi, value: (u) => u.metrics.maintainabilityIndex, text: (u) => dash(u.metrics.maintainabilityIndex) },
    ], data.units, (u) => openCode(u.file, u.line), { selected: (u) => u.id === data.selected, title: S.tips.openCode });

    const fns = card(grid, S.cards.functions, null, true);
    table(fns, [
      { key: "name", name: S.columns.function, value: (f) => f.name, cell: (td, f) => { td.textContent = f.name; td.title = f.id; } },
      { key: "cyclomatic", name: S.columns.cyclomatic, value: (f) => f.cyclomatic, text: (f) => dash(f.cyclomatic) },
      { key: "mi", name: S.columns.mi, value: (f) => f.maintainabilityIndex, text: (f) => dash(f.maintainabilityIndex) },
      { key: "lines", name: S.columns.lines, value: (f) => f.lines, text: (f) => dash(f.lines) },
    ], data.functions, (f) => openCode(f.file, f.line), { title: S.tips.openCode });

    if (data.selected) app.querySelector("tr.selected")?.scrollIntoView({ block: "nearest" });
  }

  function render() {
    app.textContent = "";
    tip.style.display = "none";
    if (!state || !state.data) {
      el("p", { class: "note" }, app, S ? (state?.missing ? fill(S.noModule, state.missing) : S.noData) : "");
      return;
    }
    if (state.data.view === "module") moduleView(state.data);
    else systemView(state.data);
  }

  window.addEventListener("message", (event) => {
    if (event.data.type !== "score") return;
    S = event.data.strings;
    state = event.data;
    render();
    window.scrollTo(0, 0);
  });
  vscode.postMessage({ type: "ready" });
})();
