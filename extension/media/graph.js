// Draws the dependency graph in columns by dependency depth. Everything shown comes from facts.
(function () {
  const vscode = acquireVsCodeApi();
  const svg = document.getElementById("graph");
  const info = document.getElementById("info");
  const ns = "http://www.w3.org/2000/svg";
  const bar = document.getElementById("bar");
  const legend = document.getElementById("legend");
  const colors = Number(legend.dataset.colors);
  const buttons = [...document.querySelectorAll("button[data-level]")];
  let view = { x: 0, y: 0, k: 1 };
  let root;
  let marks = [];
  let focused = false;
  // Above this many nodes labels appear only near the pointer until the view is zoomed in.
  const CROWDED = 60;
  // Distance between columns and rows of the layout; a node never grows past half a row, so nodes cannot touch.
  const COLUMN = 210;
  const ROW = 34;
  const LARGEST = ROW / 2 - 2;
  const LABELS = 300;

  function element(name, attributes, parent) {
    const node = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    parent.appendChild(node);
    return node;
  }

  // Parts of the graph that share no edge, largest first; lone nodes are returned apart, they have no order to show.
  function components(nodes, around) {
    const seen = new Set();
    const groups = [];
    const lone = [];
    for (const start of nodes) {
      if (seen.has(start.id)) continue;
      seen.add(start.id);
      const members = [start];
      for (const member of members) {
        for (const next of around.get(member.id)) {
          if (!seen.has(next.id)) { seen.add(next.id); members.push(next); }
        }
      }
      if (members.length === 1) lone.push(start);
      else groups.push(members);
    }
    groups.sort((a, b) => b.length - a.length);
    return { groups, lone };
  }

  // Orders each column by the mean position of the neighbours, which removes most crossings.
  function orderColumns(columns, around) {
    const place = new Map();
    const remember = (column) => column.forEach((n, i) => place.set(n.id, i - (column.length - 1) / 2));
    columns.forEach(remember);
    const score = (node) => {
      const known = around.get(node.id).map((n) => place.get(n.id));
      return known.length ? known.reduce((sum, p) => sum + p, 0) / known.length : place.get(node.id);
    };
    for (let sweep = 0; sweep < 12; sweep++) {
      const order = sweep % 2 ? [...columns].reverse() : columns;
      for (const column of order) {
        const scores = new Map(column.map((n) => [n.id, score(n)]));
        column.sort((a, b) => scores.get(a.id) - scores.get(b.id));
        remember(column);
      }
    }
  }

  // Dependencies on the left, dependents on the right, as in the legend. A column taller than rows is folded sideways, keeping its order.
  function placeGroup(members, around, rows, top) {
    const columns = [];
    for (const node of members) (columns[node.layer] ??= []).push(node);
    const filled = columns.filter(Boolean);
    orderColumns(filled, around);
    let left = 0;
    let height = 0;
    for (const column of filled) {
      const wide = Math.ceil(column.length / rows);
      height = Math.max(height, Math.ceil(column.length / wide));
    }
    for (const column of filled) {
      const wide = Math.ceil(column.length / rows);
      const tall = Math.ceil(column.length / wide);
      column.forEach((node, i) => {
        node.x = left + (i % wide) * COLUMN;
        node.y = top + ((height - tall) / 2 + Math.floor(i / wide)) * ROW;
      });
      left += wide * COLUMN;
    }
    return { width: left, height };
  }

  function layout(nodes, edges, aspect) {
    const index = new Map(nodes.map((n) => [n.id, n]));
    const around = new Map(nodes.map((n) => [n.id, []]));
    for (const edge of edges) {
      const a = index.get(edge.from), b = index.get(edge.to);
      around.get(a.id).push(b);
      around.get(b.id).push(a);
    }
    const { groups, lone } = components(nodes, around);
    const rows = Math.max(6, Math.round(Math.sqrt(nodes.length * COLUMN / (ROW * aspect))));
    let top = 0;
    let width = COLUMN * 4;
    for (const group of groups) {
      const size = placeGroup(group, around, rows, top);
      top += (size.height + 1) * ROW;
      width = Math.max(width, size.width);
    }
    const perRow = Math.max(1, Math.floor(width / COLUMN));
    lone.forEach((node, i) => {
      node.x = (i % perRow) * COLUMN;
      node.y = top + Math.floor(i / perRow) * ROW;
    });
    // Columns are wider than rows are tall, so a short graph is stretched to use the height of the page.
    const ys = nodes.map((n) => n.y);
    const tall = Math.max(...ys) - Math.min(...ys) + ROW;
    const stretch = Math.min(3, (Math.max(...nodes.map((n) => n.x)) + LABELS) / aspect / tall);
    if (stretch > 1) for (const node of nodes) node.y *= stretch;
    return index;
  }

  function polygon(x, y, r, corners, turn) {
    const points = [];
    for (let i = 0; i < corners; i++) {
      const angle = turn + (i * 2 * Math.PI) / corners;
      points.push(`${x + r * Math.cos(angle)} ${y + r * Math.sin(angle)}`);
    }
    return `M${points.join("L")}Z`;
  }

  function roundSquare(x, y, r) {
    const side = r * 0.9, corner = r * 0.4;
    return `M${x - side + corner} ${y - side}H${x + side - corner}Q${x + side} ${y - side} ${x + side} ${y - side + corner}V${y + side - corner}Q${x + side} ${y + side} ${x + side - corner} ${y + side}H${x - side + corner}Q${x - side} ${y + side} ${x - side} ${y + side - corner}V${y - side + corner}Q${x - side} ${y - side} ${x - side + corner} ${y - side}Z`;
  }

  function shapePath(shape, x, y, r) {
    switch (shape) {
      case "triangle": return polygon(x, y, r * 1.2, 3, -Math.PI / 2);
      case "diamond": return polygon(x, y, r * 1.25, 4, 0);
      case "square": return polygon(x, y, r * 1.2, 4, Math.PI / 4);
      case "rounded": return roundSquare(x, y, r);
      case "hexagon": return polygon(x, y, r * 1.1, 6, 0);
      case "pentagon": return polygon(x, y, r * 1.1, 5, -Math.PI / 2);
      case "dot": return `M${x - r / 2} ${y}a${r / 2} ${r / 2} 0 1 0 ${r} 0a${r / 2} ${r / 2} 0 1 0 ${-r} 0Z`;
      default: return `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
    }
  }

  function radius(node) {
    return 5 + Math.min(6, Math.sqrt(Math.max(node.size, 1)) / 3);
  }

  function apply() {
    root.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.k})`);
    // Zooming out moves nodes closer but keeps them and their labels readable.
    const size = 1 / Math.min(view.k, 1);
    root.classList.toggle("quiet", marks.length > CROWDED && view.k < 1);
    for (const { node, circle, label } of marks) {
      const r = node.role === "module" && focused ? LARGEST : Math.min(radius(node) * size, LARGEST);
      circle.setAttribute("d", shapePath(node.shape, node.x, node.y, r));
      circle.setAttribute("data-r", r);
      circle.setAttribute("stroke-width", (node.cycle ? 3 : 1) * size);
      label.setAttribute("x", node.x + r + 3 * size);
      label.setAttribute("y", node.y + 4 * size);
      label.setAttribute("font-size", 12 * size);
    }
  }

  function showLegend(graph) {
    const { nodes, edges, groups } = graph;
    legend.replaceChildren();
    const add = (mark, text) => {
      const entry = document.createElement("span");
      const dot = entry.appendChild(document.createElement("i"));
      dot.className = mark;
      entry.append(text);
      legend.appendChild(entry);
    };
    if (groups) {
      groups.forEach((name, i) => add(`layer-${i}`, name));
    } else {
      legend.append("Depth:");
      const deepest = Math.max(...nodes.map((n) => n.layer));
      for (let layer = 0; layer <= Math.min(deepest, colors - 1); layer++) {
        add(`layer-${layer}`, layer === colors - 1 && deepest >= colors ? `${layer}+` : `${layer}`);
      }
    }
    if (nodes.some((n) => n.cycle)) add("cycle", "cycle");
    for (const kind of [...new Set(edges.map((e) => e.kind))].sort()) add(`kind kind-${kind}`, kind);
    const shapes = new Map(nodes.filter((n) => n.kind).map((n) => [n.kind, n.shape]));
    for (const kind of [...shapes.keys()].sort()) {
      const entry = document.createElement("span");
      const icon = element("svg", { viewBox: "0 0 24 24" }, entry);
      element("path", { d: shapePath(shapes.get(kind), 12, 12, 9) }, icon);
      entry.append(kind);
      legend.appendChild(entry);
    }
  }

  function highlight(id, items) {
    for (const item of items) {
      const near = id === null || item.ids.has(id);
      item.element.classList.toggle("dim", !near);
      item.element.classList.toggle("near", id !== null && near);
    }
  }

  function title(level, focus) {
    if (level !== "type") return "Click a module to see its types, a line to see the types it joins";
    return focus.peer ? `${focus.module} ↔ ${focus.peer}` : focus.module;
  }

  function draw(level, focus, graph) {
    buttons.forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.level === level));
      if (b.dataset.level === "type") b.disabled = !focus;
    });
    focused = level === "type";
    svg.replaceChildren();
    const cyclic = graph.nodes.filter((n) => n.cycle).length;
    info.textContent = `${title(level, focus)}: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${cyclic} in cycles`;
    root = element("g", {}, svg);
    marks = [];
    legend.replaceChildren();
    if (!graph.nodes.length) {
      info.textContent = focused ? `${title(level, focus)}: no links between types` : "No data yet: run Nomos: Analyze Workspace.";
      return;
    }
    showLegend(graph);
    const box = svg.getBoundingClientRect();
    const top = bar.getBoundingClientRect().bottom;
    const index = layout(graph.nodes, graph.edges, box.width / Math.max(box.height - top, 1) || 1.5);
    const items = [];
    const slots = new Map();
    for (const edge of graph.edges) {
      const a = index.get(edge.from), b = index.get(edge.to);
      const bend = Math.max(Math.abs(b.x - a.x) / 2, 40);
      const near = a.x <= b.x ? bend : -bend;
      // Edges of different kinds between the same nodes fan out, so that each color stays visible.
      const key = [edge.from, edge.to].sort().join("\u0000");
      const slot = slots.get(key) ?? 0;
      slots.set(key, slot + 1);
      const fan = (slot % 2 ? 1 : -1) * Math.ceil(slot / 2) * 12;
      const d = `M${a.x} ${a.y}C${a.x + near} ${a.y + fan} ${b.x - near} ${b.y + fan} ${b.x} ${b.y}`;
      const line = element("path", { d, class: `edge kind-${edge.kind}${edge.cycle ? " cycle" : ""}` }, root);
      const hit = element("path", { d, class: edge.pair ? "hit open" : "hit" }, root);
      element("title", {}, hit).textContent = `${edge.from} → ${edge.to}: ${edge.kind} (${edge.weight})`;
      if (edge.pair) hit.addEventListener("click", () => vscode.postMessage({ type: "focus", module: edge.pair[0], peer: edge.pair[1] }));
      items.push({ element: line, ids: new Set([edge.from, edge.to]) });
    }
    for (const node of graph.nodes) {
      const neighbours = new Set([node.id]);
      for (const edge of graph.edges) {
        if (edge.from === node.id) neighbours.add(edge.to);
        if (edge.to === node.id) neighbours.add(edge.from);
      }
      const peer = focused && node.role === "module";
      const color = peer ? "peer" : `layer-${Math.min(node.layer, colors - 1)}`;
      const circle = element("path", { class: `node ${color}${node.cycle ? " cycle" : ""}` }, root);
      element("title", {}, circle).textContent = node.kind ? `${node.id} (${node.kind})` : node.id;
      const label = element("text", peer ? { class: "peer" } : {}, root);
      label.textContent = node.label;
      marks.push({ node, circle, label });
      items.push({ element: circle, ids: neighbours }, { element: label, ids: neighbours });
      circle.addEventListener("mouseenter", () => highlight(node.id, items));
      circle.addEventListener("mouseleave", () => highlight(null, items));
      circle.addEventListener("click", () => vscode.postMessage(node.role === "module" ? { type: "focus", module: node.id } : { type: "open", language: node.language, file: node.file, line: node.line }));
    }
    const xs = graph.nodes.map((n) => n.x), ys = graph.nodes.map((n) => n.y);
    // Labels hang to the right of the nodes, so the margin is on that side.
    const width = Math.max(...xs) - Math.min(...xs) + LABELS + 40, height = Math.max(...ys) - Math.min(...ys) + 80;
    view.k = Math.min(box.width / width, (box.height - top) / height, 1.5);
    view.x = box.width / 2 - view.k * (Math.max(...xs) + Math.min(...xs) + LABELS) / 2;
    view.y = (box.height + top) / 2 - view.k * (Math.max(...ys) + Math.min(...ys)) / 2;
    apply();
  }

  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    view.x = event.offsetX - (event.offsetX - view.x) * factor;
    view.y = event.offsetY - (event.offsetY - view.y) * factor;
    view.k *= factor;
    apply();
  }, { passive: false });

  let drag = null;
  svg.addEventListener("pointerdown", (event) => { drag = { x: event.clientX - view.x, y: event.clientY - view.y }; });
  window.addEventListener("pointerup", () => { drag = null; });
  window.addEventListener("pointermove", (event) => {
    if (!drag) return;
    view.x = event.clientX - drag.x;
    view.y = event.clientY - drag.y;
    apply();
  });

  buttons.forEach((b) => b.addEventListener("click", () => vscode.postMessage({ type: "level", level: b.dataset.level })));
  window.addEventListener("message", (event) => {
    if (event.data.type === "graph") draw(event.data.level, event.data.focus, event.data.graph);
  });
  vscode.postMessage({ type: "level", level: "module" });
})();
