/* graph.js — SVG 提交图渲染：配色、引用标签、连线、缩放与平移 */
(function (global) {
  "use strict";

  const PALETTE = [
    "#58a6ff", "#3fb950", "#bc8cff", "#f0883e", "#39c5cf",
    "#f778ba", "#d29922", "#79c0ff", "#56d364", "#ffa657",
    "#d2a8ff", "#7ee787", "#ff7b72"
  ];

  class GraphView {
    constructor(repo, svg) {
      this.repo = repo;
      this.svg = svg;
      this.viewport = document.getElementById("viewport");
      this.edgeLayer = document.getElementById("edge-layer");
      this.nodeLayer = document.getElementById("node-layer");
      this.scale = 1;
      this.tx = 0; this.ty = 0;
      this.showUnreachable = true;
      this.selectedSha = null;
      this.onSelect = null;
      this.layout = null;
      this._bindPanZoom();
    }

    /* ---------- 配色：以分支顶端为色源，第一父链优先向下染色 ---------- */
    computeColors() {
      const colorOf = new Map();
      const repo = this.repo;
      const tips = Object.keys(repo.branches).map((name, i) => ({
        sha: repo.branches[name], name, color: PALETTE[i % PALETTE.length], kind: "branch"
      })).concat(
        // detached HEAD 单独给色
        repo.head.detached && repo.head.sha
          ? [{ sha: repo.head.sha, name: "HEAD", color: "#e3b341", kind: "head" }] : []
      );
      // 当前分支最先 BFS，让其第一父染成当前分支色
      tips.sort((a, b) => {
        const cur = repo.head.detached ? null : repo.head.ref;
        const score = t => t.name === cur ? 0 : t.kind === "head" ? 1 : 2;
        return score(a) - score(b);
      });
      for (const tip of tips) {
        const queue = [tip.sha];
        while (queue.length) {
          const sha = queue.shift();
          if (!sha || colorOf.has(sha)) continue;
          colorOf.set(sha, tip.color);
          const c = repo.commits[sha];
          if (c && c.parents.length) queue.push(c.parents[0]);
        }
        // 再处理第二父等（未染色的 merge 父）
        const q2 = [tip.sha];
        while (q2.length) {
          const sha = q2.shift();
          if (!sha) continue;
          const c = repo.commits[sha];
          if (!c) continue;
          for (const p of c.parents) {
            if (p && !colorOf.has(p)) {
              colorOf.set(p, tip.color);
              q2.push(p);
            }
          }
        }
      }
      return { colorOf, tips: tips.map(t => ({ name: t.name, color: t.color })) };
    }

    render() {
      const repo = this.repo;
      this.layout = GraphLayout.buildLayout(repo, this.showUnreachable);
      const { nodes, edges } = this.layout;
      const { colorOf } = this.computeColors();

      // refs 归属
      const branchesAt = new Map(), tagsAt = new Map();
      for (const [name, sha] of Object.entries(repo.branches)) {
        if (!branchesAt.has(sha)) branchesAt.set(sha, []);
        branchesAt.get(sha).push(name);
      }
      for (const [name, sha] of Object.entries(repo.tags)) {
        if (!tagsAt.has(sha)) tagsAt.set(sha, []);
        tagsAt.get(sha).push(name);
      }

      this.edgeLayer.innerHTML = "";
      this.nodeLayer.innerHTML = "";
      const NS = "http://www.w3.org/2000/svg";

      // edges 先画
      for (const e of edges) {
        const path = document.createElementNS(NS, "path");
        const dy = e.y2 - e.y1;
        const midY = e.y1 + dy * 0.55;
        const d = "M" + e.x1 + "," + e.y1 +
          " C" + e.x1 + "," + midY + " " + e.x2 + "," + (e.y2 - dy * 0.45) +
          " " + e.x2 + "," + e.y2;
        path.setAttribute("d", d);
        let color = colorOf.get(e.from) || "#8b949e";
        // 向“子”一侧着色更符合直觉
        path.setAttribute("stroke", color);
        path.setAttribute("class", "edge" + (e.unreachable ? " dim" : ""));
        if (e.unreachable) path.setAttribute("marker-end", "url(#arrow-dim)");
        this.edgeLayer.appendChild(path);
      }

      // nodes
      for (const [sha, n] of nodes) {
        const c = repo.commits[sha];
        const g = document.createElementNS(NS, "g");
        g.setAttribute("class", "commit-node" + (n.unreachable ? " unreachable" : ""));
        g.setAttribute("transform", "translate(" + n.x + "," + n.y + ")");
        g.dataset.sha = sha;

        const circle = document.createElementNS(NS, "circle");
        circle.setAttribute("r", this.layout.R);
        const isMerge = c.parents.length > 1;
        circle.setAttribute("class", "node-circle");
        circle.setAttribute("fill", isMerge ? "#0d1117" : (colorOf.get(sha) || "#8b949e"));
        circle.setAttribute("stroke", colorOf.get(sha) || "#8b949e");
        circle.setAttribute("stroke-width", isMerge ? 3 : 2);
        g.appendChild(circle);

        if (isMerge) {
          // 两条小横线表示 merge
          const bar = document.createElementNS(NS, "line");
          bar.setAttribute("x1", -4); bar.setAttribute("y1", 0);
          bar.setAttribute("x2", 4); bar.setAttribute("y2", 0);
          bar.setAttribute("stroke", colorOf.get(sha) || "#8b949e");
          bar.setAttribute("stroke-width", 2);
          g.appendChild(bar);
        }

        // chips：HEAD 在最上行；分支为带颜色圆角标签；标签为金色描边标签
        const branchChips = [];
        const bnames = branchesAt.get(sha) || [];
        const allBranches = Object.keys(repo.branches);
        bnames.forEach(name => {
          const i = allBranches.indexOf(name);
          branchChips.push({ text: name, color: PALETTE[i % PALETTE.length],
            isHead: !repo.head.detached && repo.head.ref === name });
        });
        if (repo.head.detached && repo.head.sha === sha)
          branchChips.push({ text: "HEAD", color: "#e3b341", isHead: true, detached: true });
        const tagNames = tagsAt.get(sha) || [];

        if (!repo.head.detached && repo.branches[repo.head.ref] === sha) {
          const ht = document.createElementNS(NS, "text");
          ht.setAttribute("x", 16); ht.setAttribute("y", -38);
          ht.setAttribute("class", "chip chip-head");
          ht.setAttribute("fill", "#e3b341");
          ht.textContent = "HEAD → " + repo.head.ref;
          g.appendChild(ht);
        }

        let chipX = 16;
        const chipRowY = -15;
        const measure = s => s.split("").reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 11 : 6.6), 0);
        const drawBranchChip = (text, color, isHead) => {
          const w = measure(text) + 12;
          const rect = document.createElementNS(NS, "rect");
          rect.setAttribute("x", chipX - 4); rect.setAttribute("y", chipRowY - 10);
          rect.setAttribute("width", w); rect.setAttribute("height", 15); rect.setAttribute("rx", 3);
          rect.setAttribute("fill", color); rect.setAttribute("opacity", "0.18");
          rect.setAttribute("stroke", color); rect.setAttribute("stroke-width", 1);
          g.appendChild(rect);
          const tx = document.createElementNS(NS, "text");
          tx.setAttribute("x", chipX + 2); tx.setAttribute("y", chipRowY - 2.5);
          tx.setAttribute("dominant-baseline", "central");
          tx.setAttribute("class", "chip chip-branch");
          tx.setAttribute("fill", color);
          tx.textContent = text;
          g.appendChild(tx);
          chipX += w + 6;
        };
        const drawTagChip = (text) => {
          const w = measure(text) + 12;
          const rect = document.createElementNS(NS, "rect");
          rect.setAttribute("x", chipX - 4); rect.setAttribute("y", chipRowY - 10);
          rect.setAttribute("width", w); rect.setAttribute("height", 15); rect.setAttribute("rx", 3);
          rect.setAttribute("fill", "#3a2e12");
          rect.setAttribute("stroke", "#d29922"); rect.setAttribute("stroke-width", 1);
          g.appendChild(rect);
          const dot = document.createElementNS(NS, "circle");
          dot.setAttribute("cx", chipX + 1); dot.setAttribute("cy", chipRowY - 2.5); dot.setAttribute("r", 2.5);
          dot.setAttribute("fill", "#d29922");
          g.appendChild(dot);
          const tx = document.createElementNS(NS, "text");
          tx.setAttribute("x", chipX + 7); tx.setAttribute("y", chipRowY - 2.5);
          tx.setAttribute("dominant-baseline", "central");
          tx.setAttribute("class", "chip chip-tag");
          tx.setAttribute("fill", "#e3b341");
          tx.textContent = text;
          g.appendChild(tx);
          chipX += w + 6;
        };
        branchChips.filter(c => !c.isHead).forEach(c => drawBranchChip(c.text, c.color));
        tagNames.forEach(n => drawTagChip(n));

        // message + sha
        const msg = document.createElementNS(NS, "text");
        msg.setAttribute("x", 16); msg.setAttribute("y", 1);
        msg.setAttribute("class", "node-msg");
        msg.textContent = c.message;
        g.appendChild(msg);

        const sh = document.createElementNS(NS, "text");
        sh.setAttribute("x", 16); sh.setAttribute("y", 15);
        sh.setAttribute("class", "node-sha");
        sh.textContent = sha;
        g.appendChild(sh);

        if (this.selectedSha === sha) {
          const ring = document.createElementNS(NS, "circle");
          ring.setAttribute("r", this.layout.R + 5);
          ring.setAttribute("class", "sel-ring");
          g.appendChild(ring);
        }

        g.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.select(sha);
        });
        this.nodeLayer.appendChild(g);
      }

      this.applyTransform();
    }

    select(sha) {
      this.selectedSha = sha;
      if (this.onSelect) this.onSelect(sha);
      this.render();
    }

    applyTransform() {
      this.viewport.setAttribute("transform",
        "translate(" + this.tx + "," + this.ty + ") scale(" + this.scale + ")");
    }

    /* ---------- 缩放 / 拖拽 ---------- */
    _bindPanZoom() {
      const el = this.svg;
      let panning = false, sx = 0, sy = 0, ox = 0, oy = 0;
      el.addEventListener("mousedown", (e) => {
        if (e.target.closest(".commit-node")) return;
        panning = true; sx = e.clientX; sy = e.clientY; ox = this.tx; oy = this.ty;
        el.classList.add("panning");
      });
      window.addEventListener("mousemove", (e) => {
        if (!panning) return;
        this.tx = ox + e.clientX - sx;
        this.ty = oy + e.clientY - sy;
        this.applyTransform();
      });
      window.addEventListener("mouseup", () => { panning = false; el.classList.remove("panning"); });

      el.addEventListener("wheel", (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.zoomAt(e.offsetX, e.offsetY, factor);
      }, { passive: false });

      el.addEventListener("dblclick", (e) => {
        if (e.target.closest(".commit-node")) return;
        this.fit();
      });
    }

    zoomAt(cx, cy, factor) {
      const ns = Math.min(2.5, Math.max(0.3, this.scale * factor));
      const k = ns / this.scale;
      this.tx = cx - (cx - this.tx) * k;
      this.ty = cy - (cy - this.ty) * k;
      this.scale = ns;
      this.applyTransform();
    }

    zoomIn() { this.zoomAt(this.svg.clientWidth / 2, this.svg.clientHeight / 2, 1.2); }
    zoomOut() { this.zoomAt(this.svg.clientWidth / 2, this.svg.clientHeight / 2, 1 / 1.2); }

    fit() {
      if (!this.layout) return;
      const w = this.svg.clientWidth, h = this.svg.clientHeight;
      const sx = w / (this.layout.width + 60);
      const sy = h / (this.layout.height + 20);
      this.scale = Math.min(1.15, Math.min(sx, sy));
      this.tx = (w - this.layout.width * this.scale) / 2;
      this.ty = 24;
      this.applyTransform();
    }

    centerOn(sha) {
      const n = this.layout && this.layout.nodes.get(sha);
      if (!n) return;
      this.tx = this.svg.clientWidth / 2 - n.x * this.scale;
      this.ty = 70 - n.y * this.scale;
      this.applyTransform();
    }
  }

  global.GraphView = GraphView;
  global.GRAPH_PALETTE = PALETTE;
})(window);
