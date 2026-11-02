// Draws the dependency graph with a small force layout. Everything shown comes from facts.
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
  // Above this many nodes labels appear only near the pointer until the view is zoomed in.
  const CROWDED = 60;

  function element(name, attributes, parent) {
    const node = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    parent.appendChild(node);
    return node;
  }

  function layout(nodes, edges) {
    const count = Math.max(nodes.length, 1);
    nodes.forEach((n, i) => {
      const angle = i * 2.399963;
      const radius = 18 * Math.sqrt(i + 1);
      n.x = radius * Math.cos(angle);
      n.y = radius * Math.sin(angle);
    });
    const index = new Map(nodes.map((n) => [n.id, n]));
    const links = edges.map((e) => [index.get(e.from), index.get(e.to)]);
    const iterations = count > 300 ? 120 : 260;
    for (let step = 0; step < iterations; step++) {
      const cooling = 1 - step / iterations;
      for (const n of nodes) { n.dx = -n.x * 0.01; n.dy = -n.y * 0.01; }
      for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = a.x - b.x || 0.1, dy = a.y - b.y || 0.1;
          const force = 1800 / Math.max(dx * dx + dy * dy, 25);
          a.dx += dx * force; a.dy += dy * force;
          b.dx -= dx * force; b.dy -= dy * force;
        }
      }
      for (const [a, b] of links) {
        const dx = b.x - a.x, dy = b.y - a.y;
        a.dx += dx * 0.02; a.dy += dy * 0.02;
        b.dx -= dx * 0.02; b.dy -= dy * 0.02;
      }
      for (const n of nodes) {
        n.x += Math.max(-20, Math.min(20, n.dx)) * cooling;
        n.y += Math.max(-20, Math.min(20, n.dy)) * cooling;
      }
    }
    return index;
  }

  function radius(node) {
    return 7 + Math.min(11, Math.sqrt(Math.max(node.size, 1)) / 2);
  }

  function apply() {
    root.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.k})`);
    // Zooming out moves nodes closer but keeps them and their labels readable.
    const size = 1 / Math.min(view.k, 1);
    root.classList.toggle("quiet", marks.length > CROWDED && view.k < 1);
    for (const { node, circle, label } of marks) {
      const r = radius(node) * size;
      circle.setAttribute("r", r);
      circle.setAttribute("stroke-width", (node.cycle ? 3 : 1) * size);
      label.setAttribute("x", node.x + r + 3 * size);
      label.setAttribute("y", node.y + 4 * size);
      label.setAttribute("font-size", 12 * size);
    }
  }

  function showLegend(nodes) {
    legend.replaceChildren("Depth:");
    const add = (mark, text) => {
      const entry = document.createElement("span");
      const dot = entry.appendChild(document.createElement("i"));
      dot.className = mark;
      entry.append(text);
      legend.appendChild(entry);
    };
    const deepest = Math.max(...nodes.map((n) => n.layer));
    for (let layer = 0; layer <= Math.min(deepest, colors - 1); layer++) {
      add(`layer-${layer}`, layer === colors - 1 && deepest >= colors ? `${layer}+` : `${layer}`);
    }
    if (nodes.some((n) => n.cycle)) add("cycle", "cycle");
  }

  function highlight(id, items) {
    for (const item of items) {
      const near = id === null || item.ids.has(id);
      item.element.classList.toggle("dim", !near);
      item.element.classList.toggle("near", id !== null && near);
    }
  }

  function draw(level, graph) {
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.level === level)));
    svg.replaceChildren();
    const cyclic = graph.nodes.filter((n) => n.cycle).length;
    info.textContent = `${graph.nodes.length} nodes, ${graph.edges.length} edges, ${cyclic} in cycles`;
    root = element("g", {}, svg);
    marks = [];
    legend.replaceChildren();
    if (!graph.nodes.length) {
      info.textContent = "No data yet: run Nomos: Analyze Workspace.";
      return;
    }
    showLegend(graph.nodes);
    const index = layout(graph.nodes, graph.edges);
    const items = [];
    for (const edge of graph.edges) {
      const a = index.get(edge.from), b = index.get(edge.to);
      const line = element("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: edge.cycle ? "cycle" : "" }, root);
      element("title", {}, line).textContent = `${edge.from} → ${edge.to} (${edge.weight})`;
      items.push({ element: line, ids: new Set([edge.from, edge.to]) });
    }
    for (const node of graph.nodes) {
      const neighbours = new Set([node.id]);
      for (const edge of graph.edges) {
        if (edge.from === node.id) neighbours.add(edge.to);
        if (edge.to === node.id) neighbours.add(edge.from);
      }
      const color = `layer-${Math.min(node.layer, colors - 1)}`;
      const circle = element("circle", { cx: node.x, cy: node.y, class: node.cycle ? `${color} cycle` : color }, root);
      element("title", {}, circle).textContent = `${node.id} (layer ${node.layer})`;
      const label = element("text", {}, root);
      label.textContent = node.label;
      marks.push({ node, circle, label });
      items.push({ element: circle, ids: neighbours }, { element: label, ids: neighbours });
      circle.addEventListener("mouseenter", () => highlight(node.id, items));
      circle.addEventListener("mouseleave", () => highlight(null, items));
      circle.addEventListener("click", () => vscode.postMessage({ type: "open", language: node.language, file: node.file, line: node.line }));
    }
    const box = svg.getBoundingClientRect();
    const xs = graph.nodes.map((n) => n.x), ys = graph.nodes.map((n) => n.y);
    const top = bar.getBoundingClientRect().bottom;
    const width = Math.max(...xs) - Math.min(...xs) + 240, height = Math.max(...ys) - Math.min(...ys) + 80;
    view.k = Math.min(box.width / width, (box.height - top) / height, 1.5);
    view.x = box.width / 2 - view.k * (Math.max(...xs) + Math.min(...xs)) / 2;
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
    if (event.data.type === "graph") draw(event.data.level, event.data.graph);
  });
  vscode.postMessage({ type: "level", level: "module" });
})();
