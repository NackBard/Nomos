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
  const relations = document.getElementById("relations");
  let view = { x: 0, y: 0, k: 1 };
  let root;
  let marks = [];
  let links = [];
  let focused = false;
  // Kinds of links switched off in the legend; kept across redraws.
  const hidden = new Set();
  // How a link reads from each end; its kind shows in the line (CSS), its direction in a fin.
  const KINDS = {
    inheritance: { out: "inherits", in: "inherited by" },
    call: { out: "calls", in: "called by" },
    "type-ref": { out: "uses type", in: "type used by" },
    import: { out: "imports", in: "imported by" },
  };
  const kindOf = (kind) => KINDS[kind] ?? { out: kind, in: `${kind} (from)` };
  // Above this many nodes labels appear only near the pointer until the view is zoomed in.
  const CROWDED = 60;
  // Above this many named lines the names appear only on the links of the node under the pointer.
  const NAMED = 12;
  // Distance between columns and rows of the layout. A row holds a node and the label under it: a node never grows past
  // LARGEST and a label past LABEL_ROOM, so neither can reach the node of the next row.
  const COLUMN = 210;
  const ROW = 50;
  const LARGEST = 15;
  const LABEL_ROOM = ROW - 2 * LARGEST - 4;
  // Distance between the lanes of links that leave one side of a node, and the most they may spread in total.
  const LANE = 14;
  const LANES_SPREAD = 3 * ROW;
  // Height a waypoint of a long link takes in its column: room for its line and a gap to the next one.
  const WAYPOINT = 18;

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
    // A waypoint needs room for one line, not for a node and its label. Only nodes count towards folding a column.
    const slot = (node) => (node.waypoint ? WAYPOINT : ROW);
    const shape = (column) => {
      const real = column.filter((n) => !n.waypoint).length;
      const wide = Math.max(1, Math.ceil(real / rows));
      const extent = wide > 1 ? Math.ceil(real / wide) * ROW : column.reduce((sum, n) => sum + slot(n), 0);
      return { wide, extent };
    };
    const tallest = Math.max(...filled.map((column) => shape(column).extent));
    let left = 0;
    for (const column of filled) {
      const { wide, extent } = shape(column);
      const first = top + (tallest - extent) / 2;
      if (wide > 1) {
        // A folded column keeps its nodes on a grid; the waypoints run between its first two sub-columns, in order.
        const real = column.filter((n) => !n.waypoint);
        const ways = column.filter((n) => n.waypoint);
        real.forEach((node, i) => {
          node.x = left + (i % wide) * COLUMN;
          node.y = first + (Math.floor(i / wide) + 0.5) * ROW;
        });
        ways.forEach((node, i) => {
          node.x = left + COLUMN / 2;
          node.y = first + ((i + 0.5) * extent) / ways.length;
        });
      } else {
        let y = first;
        for (const node of column) {
          node.x = left;
          node.y = y + slot(node) / 2;
          y += slot(node);
        }
      }
      left += wide * COLUMN;
      if (wide > 1) column.folded = true;
    }
    straighten(filled, around);
    return { width: left, height: tallest / ROW };
  }

  /**
   * Moves waypoints towards the line between their neighbours, so a long link runs straight and its curve is
   * symmetric, not bent wherever the ordering happened to put it. Nodes stay; a waypoint keeps its order in the column
   * and its distance to the nodes and waypoints around it, so it never moves onto a node.
   */
  function straighten(columns, around) {
    const mean = (node) => {
      const ys = around.get(node.id).map((n) => n.y);
      return ys.reduce((sum, y) => sum + y, 0) / ys.length;
    };
    const gap = (a, b) => ((a.waypoint ? WAYPOINT : ROW) + (b.waypoint ? WAYPOINT : ROW)) / 2;
    for (let pass = 0; pass < 16; pass++) {
      for (const column of pass % 2 ? [...columns].reverse() : columns) {
        if (column.folded) continue;
        for (let i = 0; i < column.length; ) {
          if (!column[i].waypoint) { i++; continue; }
          let j = i;
          while (j < column.length && column[j].waypoint) j++;
          const run = column.slice(i, j);
          const above = column[i - 1], below = column[j];
          const ys = run.map(mean);
          // Keep the order and the gaps: push down from the node above, then up from the node below, then down again.
          const top = above ? above.y + gap(above, run[0]) : -Infinity;
          const bottom = below ? below.y - gap(below, run[run.length - 1]) : Infinity;
          const down = () => {
            let limit = top;
            for (let k = 0; k < ys.length; k++) {
              ys[k] = Math.max(ys[k], limit);
              limit = ys[k] + WAYPOINT;
            }
          };
          down();
          let limit = bottom;
          for (let k = ys.length - 1; k >= 0; k--) {
            ys[k] = Math.min(ys[k], limit);
            limit = ys[k] - WAYPOINT;
          }
          down();
          run.forEach((node, k) => (node.y = ys[k]));
          i = j;
        }
      }
    }
  }

  /**
   * A link that skips columns gets a waypoint in every column it crosses. Waypoints are ordered and placed like nodes,
   * so the link keeps a row of its own there instead of running through a node that happens to sit in its way.
   * Returns, per edge, the points it passes from its source to its target.
   */
  function addWaypoints(edges, index, all) {
    return edges.map((edge, i) => {
      const a = index.get(edge.from), b = index.get(edge.to);
      const route = [a];
      const step = a.layer > b.layer ? -1 : 1;
      for (let layer = a.layer + step; layer !== b.layer && Math.abs(a.layer - b.layer) > 1; layer += step) {
        const point = { id: `\u0000${i}:${layer}`, layer, waypoint: true };
        all.push(point);
        route.push(point);
      }
      route.push(b);
      return route;
    });
  }

  function layout(nodes, edges, aspect) {
    const index = new Map(nodes.map((n) => [n.id, n]));
    const all = [...nodes];
    const routes = addWaypoints(edges, index, all);
    const around = new Map(all.map((n) => [n.id, []]));
    for (const route of routes) {
      for (let i = 1; i < route.length; i++) {
        around.get(route[i - 1].id).push(route[i]);
        around.get(route[i].id).push(route[i - 1]);
      }
    }
    const { groups, lone } = components(all, around);
    // A column folds only when it is really tall: folding puts nodes of one depth side by side, which reads as two depths.
    const rows = Math.max(12, Math.round(Math.sqrt(nodes.length * COLUMN / (ROW * aspect))));
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
    const ys = all.map((n) => n.y);
    const tall = Math.max(...ys) - Math.min(...ys) + ROW;
    const stretch = Math.min(3, (Math.max(...all.map((n) => n.x)) + COLUMN) / aspect / tall);
    if (stretch > 1) for (const node of all) node.y *= stretch;
    return { index, routes };
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

  // A fin: two short strokes slanting back from a point on the line, opening against the direction of the link.
  function finPath(tip, ux, uy, length) {
    const width = length * 0.75;
    const bx = tip.x - ux * length, by = tip.y - uy * length;
    return `M${bx - uy * width} ${by + ux * width}L${tip.x} ${tip.y}L${bx + uy * width} ${by - ux * width}`;
  }

  function apply() {
    root.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.k})`);
    // Zooming out moves nodes closer but keeps them and their labels readable.
    const size = 1 / Math.min(view.k, 1);
    root.classList.toggle("quiet", marks.length > CROWDED && view.k < 1);
    for (const { node, circle, label } of marks) {
      const r = node.role === "module" && focused ? LARGEST : Math.min(radius(node) * size, LARGEST);
      node.r = r;
      circle.setAttribute("d", shapePath(node.shape, node.x, node.y, r));
      circle.setAttribute("data-r", r);
      circle.setAttribute("stroke-width", (node.cycle ? 3 : 1) * size);
      // The label sits under the node; its size stops growing where it would reach the node of the next row.
      const font = Math.min(12 * size, LABEL_ROOM);
      label.setAttribute("x", node.x);
      label.setAttribute("y", node.y + r + font);
      label.setAttribute("font-size", font);
    }
    for (const { mid, ux, uy, head, via } of links) {
      const length = 5 * size;
      head.setAttribute("d", finPath({ x: mid.x + (ux * length) / 2, y: mid.y + (uy * length) / 2 }, ux, uy, length));
      if (!via) continue;
      // The name runs along the line, on its upper side, and is never upside down.
      let angle = (Math.atan2(uy, ux) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      const turn = (angle * Math.PI) / 180;
      const gap = 3 * size;
      const x = mid.x + Math.sin(turn) * gap, y = mid.y - Math.cos(turn) * gap;
      via.setAttribute("x", x);
      via.setAttribute("y", y);
      via.setAttribute("font-size", Math.min(8.5 * size, LABEL_ROOM));
      via.setAttribute("transform", `rotate(${angle} ${x} ${y})`);
    }
  }

  function setKind(kind, shown) {
    if (shown) hidden.delete(kind);
    else hidden.add(kind);
    for (const link of links) {
      if (link.edge.kind !== kind) continue;
      for (const part of link.parts) part.classList.toggle("off", !shown);
    }
  }

  // The links of one node, one line each, so that "who inherits, calls or uses whom" reads without following curves.
  function describe(node, graph) {
    const names = new Map(graph.nodes.map((n) => [n.id, n.label]));
    const lines = [];
    for (const edge of graph.edges) {
      if (hidden.has(edge.kind)) continue;
      const outgoing = edge.from === node.id;
      if (!outgoing && edge.to !== node.id) continue;
      const other = outgoing ? edge.to : edge.from;
      lines.push({ order: `${outgoing ? 0 : 1}${edge.kind}${names.get(other)}`, verb: outgoing ? kindOf(edge.kind).out : kindOf(edge.kind).in, arrow: outgoing ? "→" : "←", name: names.get(other) ?? other, via: edge.via, weight: edge.weight });
    }
    lines.sort((x, y) => (x.order < y.order ? -1 : x.order > y.order ? 1 : 0));
    relations.replaceChildren();
    const head = relations.appendChild(document.createElement("b"));
    head.textContent = node.kind ? `${node.id} (${node.kind})` : node.id;
    if (!lines.length) {
      const none = relations.appendChild(document.createElement("div"));
      none.className = "hint";
      none.textContent = "no links shown";
    }
    for (const line of lines) {
      const row = relations.appendChild(document.createElement("div"));
      const verb = row.appendChild(document.createElement("span"));
      verb.className = "verb";
      verb.textContent = `${line.verb} ${line.arrow} `;
      row.append(`${line.name}${line.via?.length ? `: ${line.via.join(", ")}` : ""}${line.weight > 1 ? ` (${line.weight})` : ""}`);
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
    // Each kind of link is a switch: hiding the others leaves, for example, the inheritance hierarchy alone.
    for (const kind of [...new Set(edges.map((e) => e.kind))].sort()) {
      const toggle = legend.appendChild(document.createElement("button"));
      toggle.className = "link";
      toggle.title = `Show or hide "${kind}" links`;
      toggle.setAttribute("aria-pressed", String(!hidden.has(kind)));
      const sample = element("svg", { viewBox: "0 0 30 12" }, toggle);
      element("path", { d: "M1 6H22", class: `edge kind-${kind}` }, sample);
      element("path", { d: finPath({ x: 17, y: 6 }, 1, 0, 4), class: `head kind-${kind}` }, sample);
      toggle.append(kind);
      toggle.addEventListener("click", () => {
        const shown = hidden.has(kind);
        setKind(kind, shown);
        toggle.setAttribute("aria-pressed", String(shown));
      });
    }
    const shapes = new Map(nodes.filter((n) => n.kind).map((n) => [n.kind, n.shape]));
    for (const kind of [...shapes.keys()].sort()) {
      const entry = document.createElement("span");
      const icon = element("svg", { viewBox: "0 0 24 24" }, entry);
      element("path", { d: shapePath(shapes.get(kind), 12, 12, 9) }, icon);
      entry.append(kind);
      legend.appendChild(entry);
    }
  }

  /**
   * A lane for each end of each link. The links that leave a node on one side are ordered by the height of the node at
   * their other end and spread apart, so they leave side by side, not on top of each other, and do not cross near the
   * node. Parallel links of different kinds keep the same order at both ends. `start` stays inside the node, `bend`
   * pulls the curve into its lane.
   */
  function assignLanes(edges, routes) {
    const sides = new Map();
    const lanes = edges.map(() => ({ a: { start: 0, bend: 0 }, b: { start: 0, bend: 0 } }));
    const add = (node, side, entry) => {
      const key = `${node.id}\u0000${side}`;
      if (!sides.has(key)) sides.set(key, { node, entries: [] });
      sides.get(key).entries.push(entry);
    };
    // Links between two nodes of one column (members of a cycle) are brackets left of the column: each pair of nodes gets
    // its brackets nested one inside the other, in a stable order, instead of lanes.
    const brackets = new Map();
    // The other end of a lane is the next point of the route: a waypoint for a long link, so lanes follow the real path.
    edges.forEach((edge, i) => {
      const route = routes[i];
      const a = route[0], next = route[1], b = route[route.length - 1], previous = route[route.length - 2];
      if (route.length === 2 && a.x === b.x) {
        const key = [a.id, b.id].sort().join("\u0000");
        if (!brackets.has(key)) brackets.set(key, []);
        brackets.get(key).push({ lane: lanes[i], kind: edge.kind, index: i });
        return;
      }
      add(a, a.x <= next.x ? 1 : -1, { lane: lanes[i].a, other: next, kind: edge.kind, index: i });
      add(b, previous.x <= b.x ? -1 : 1, { lane: lanes[i].b, other: previous, kind: edge.kind, index: i });
    });
    for (const { node, entries } of sides.values()) {
      entries.sort((p, q) => p.other.y - q.other.y || p.other.x - q.other.x || (p.kind < q.kind ? -1 : p.kind > q.kind ? 1 : 0) || p.index - q.index);
      const step = entries.length > 1 ? Math.min(LANE, LANES_SPREAD / (entries.length - 1)) : 0;
      const inside = (node.role === "module" && focused ? LARGEST : radius(node)) * 0.6;
      entries.forEach((entry, rank) => {
        const offset = (rank - (entries.length - 1) / 2) * step;
        entry.lane.bend = offset;
        entry.lane.start = Math.max(-inside, Math.min(inside, offset * 0.4));
      });
    }
    for (const entries of brackets.values()) {
      entries.sort((p, q) => (p.kind < q.kind ? -1 : p.kind > q.kind ? 1 : 0) || p.index - q.index);
      entries.forEach((entry, rank) => (entry.lane.bracket = rank));
    }
    return lanes;
  }

  /**
   * Cubic pieces through the points of a route. At the two nodes a line leaves and arrives horizontally, in its lane;
   * through waypoints it runs on as a Catmull-Rom spline, without a wave at each one.
   */
  function curveThrough(route, lane) {
    const last = route.length - 2;
    if (last === 0 && lane.bracket !== undefined) {
      // A bracket to the left of the column, where the links to dependencies leave and fewer lines run (none at depth 0):
      // wider for nodes further apart, and one lane wider for each link before it.
      const [from, to] = route;
      const reach = 28 + Math.abs(to.y - from.y) * 0.3 + lane.bracket * LANE;
      return [{ start: from, c1: { x: from.x - reach, y: from.y }, c2: { x: to.x - reach, y: to.y }, end: to }];
    }
    if (last === 0) {
      const [from, to] = route;
      const bend = Math.max(Math.abs(to.x - from.x) / 2, 40);
      const near = from.x <= to.x ? bend : -bend;
      return [{
        start: { x: from.x, y: from.y + lane.a.start },
        c1: { x: from.x + near, y: from.y + lane.a.bend },
        c2: { x: to.x - near, y: to.y + lane.b.bend },
        end: { x: to.x, y: to.y + lane.b.start },
      }];
    }
    // Every point gets a tangent of the same scale, so the handles on both sides of a point are equally long and an
    // arc over a symmetric route is symmetric. At the nodes the tangent is horizontal, as long as the first and last spans.
    const tangent = (i) => {
      if (i === 0) return { x: route[1].x - route[0].x, y: 0 };
      if (i === route.length - 1) return { x: route[i].x - route[i - 1].x, y: 0 };
      return { x: (route[i + 1].x - route[i - 1].x) / 2, y: (route[i + 1].y - route[i - 1].y) / 2 };
    };
    return route.slice(0, -1).map((from, k) => {
      const to = route[k + 1];
      const out = tangent(k), into = tangent(k + 1);
      return {
        start: { x: from.x, y: from.y + (k === 0 ? lane.a.start : 0) },
        c1: { x: from.x + out.x / 3, y: from.y + out.y / 3 + (k === 0 ? lane.a.bend : 0) },
        c2: { x: to.x - into.x / 3, y: to.y - into.y / 3 + (k === last ? lane.b.bend : 0) },
        end: { x: to.x, y: to.y + (k === last ? lane.b.start : 0) },
      };
    });
  }

  // The middle of a route and the direction there: the middle of the central piece, or the central waypoint.
  function middleOf(segments) {
    if (segments.length % 2) {
      const { start, c1, c2, end } = segments[(segments.length - 1) / 2];
      return { mid: { x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8, y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8 }, dx: end.x + c2.x - c1.x - start.x, dy: end.y + c2.y - c1.y - start.y };
    }
    const { c2, end } = segments[segments.length / 2 - 1];
    return { mid: end, dx: end.x - c2.x, dy: end.y - c2.y };
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
    root.classList.toggle("busy", graph.edges.filter((e) => e.via?.length).length > NAMED);
    const box = svg.getBoundingClientRect();
    const top = bar.getBoundingClientRect().bottom;
    const { index, routes } = layout(graph.nodes, graph.edges, box.width / Math.max(box.height - top, 1) || 1.5);
    const items = [];
    const lanes = assignLanes(graph.edges, routes);
    links = [];
    relations.replaceChildren();
    const hint = relations.appendChild(document.createElement("div"));
    hint.className = "hint";
    hint.textContent = "Point at a node to list its links; the fins on a line point to what is inherited, called or used.";
    // Lines under heads, heads under nodes: a head is never hidden by a line crossing it.
    const lineLayer = element("g", {}, root);
    const headLayer = element("g", {}, root);
    graph.edges.forEach((edge, i) => {
      const a = index.get(edge.from), b = index.get(edge.to);
      const segments = curveThrough(routes[i], lanes[i]);
      const d = `M${segments[0].start.x} ${segments[0].start.y}` + segments.map((s) => `C${s.c1.x} ${s.c1.y} ${s.c2.x} ${s.c2.y} ${s.end.x} ${s.end.y}`).join("");
      const parts = [];
      // A cycle keeps the line of its kind and gets a red underlay.
      if (edge.cycle) parts.push(element("path", { d, class: "halo" }, lineLayer));
      const line = element("path", { d, class: `edge kind-${edge.kind}` }, lineLayer);
      const head = element("path", { class: `head kind-${edge.kind}` }, headLayer);
      const hit = element("path", { d, class: edge.pair ? "hit open" : "hit" }, lineLayer);
      parts.push(line, head, hit);
      // A line to a folded module says which of its types it reaches (or which come from it), faintly, above the fin.
      let via;
      if (edge.via?.length) {
        via = element("text", { class: "via" }, headLayer);
        via.textContent = edge.via.length > 2 ? `${edge.via.slice(0, 2).join(", ")} +${edge.via.length - 2}` : edge.via.join(", ");
        parts.push(via);
      }
      const from = a.label, to = b.label;
      element("title", {}, hit).textContent = `${from} ${kindOf(edge.kind).out} ${to}${edge.weight > 1 ? ` (${edge.weight})` : ""}${edge.via?.length ? `\n${edge.via.join(", ")}` : ""}${edge.pair ? "\nClick to see the types it joins" : ""}`;
      if (edge.pair) hit.addEventListener("click", () => vscode.postMessage({ type: "focus", module: edge.pair[0], peer: edge.pair[1] }));
      // The head sits in the middle of the curve, pointing to the target: at the target it would hide under the label,
      // which hangs on the side links arrive from, and many heads would pile up at one node.
      const { mid, dx, dy } = middleOf(segments);
      const length = Math.hypot(dx, dy) || 1;
      links.push({ edge, mid, ux: dx / length, uy: dy / length, head, via, parts });
      for (const part of parts) {
        part.classList.toggle("off", hidden.has(edge.kind));
        items.push({ element: part, ids: new Set([edge.from, edge.to]) });
      }
    });
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
      circle.addEventListener("mouseenter", () => { highlight(node.id, items); describe(node, graph); });
      circle.addEventListener("mouseleave", () => highlight(null, items));
      circle.addEventListener("click", () => vscode.postMessage(node.role === "module" ? { type: "focus", module: node.id } : { type: "open", language: node.language, file: node.file, line: node.line }));
    }
    // Waypoints may take rows below or above the nodes; the view fits them too.
    const points = [...graph.nodes, ...routes.flat()];
    const xs = points.map((n) => n.x), ys = points.map((n) => n.y);
    // Labels are centered under the nodes: half a column of margin on each side, half a row below.
    const width = Math.max(...xs) - Math.min(...xs) + COLUMN + 40, height = Math.max(...ys) - Math.min(...ys) + ROW + 80;
    view.k = Math.min(box.width / width, (box.height - top) / height, 1.5);
    view.x = box.width / 2 - view.k * (Math.max(...xs) + Math.min(...xs)) / 2;
    view.y = (box.height + top) / 2 - view.k * (Math.max(...ys) + Math.min(...ys) + ROW / 2) / 2;
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
