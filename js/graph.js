'use strict';
(function (global) {
  const GV = global.GV;

  const ROW_H = 56;
  const LANE_W = 24;
  const NODE_R = 6;

  function topoOrder(repo, idSet) {
    const commits = repo.commits;
    const inDegree = {};
    Object.keys(idSet).forEach(function (id) { inDegree[id] = 0; });
    Object.keys(idSet).forEach(function (id) {
      commits[id].parents.forEach(function (p) {
        if (inDegree[p] !== undefined) inDegree[p]++;
      });
    });
    const ready = Object.keys(idSet).filter(function (id) { return inDegree[id] === 0; });
    ready.sort(function (a, b) { return commits[b].time - commits[a].time; });
    const order = [];
    while (ready.length) {
      const id = ready.shift();
      order.push(id);
      commits[id].parents.forEach(function (p) {
        if (inDegree[p] === undefined) return;
        inDegree[p]--;
        if (inDegree[p] === 0) {
          ready.push(p);
          ready.sort(function (x, y) { return commits[y].time - commits[x].time; });
        }
      });
    }
    return order;
  }

  function layout(repo, showDangling) {
    let idSet;
    if (showDangling) {
      idSet = {};
      Object.keys(repo.commits).forEach(function (id) { idSet[id] = 1; });
    } else {
      idSet = repo.reachableIds();
    }
    const order = topoOrder(repo, idSet);
    const rowOf = {};
    order.forEach(function (id, i) { rowOf[id] = i; });

    const laneOf = {};
    const rows = order.map(function () { return { lane: 0, parents: [] }; });
    const occupied = order.map(function () { return {}; });

    function allocLane(rowIdx, preferred) {
      if (preferred !== undefined && !occupied[rowIdx][preferred]) return preferred;
      let l = 0;
      while (occupied[rowIdx][l]) l++;
      return l;
    }

    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const c = repo.commits[id];

      const parentInfos = c.parents.map(function (p) {
        if (rowOf[p] === undefined) return { id: p, lane: 0, row: -1 };
        let pl = laneOf[p];
        if (pl === undefined) {
          pl = allocLane(i);
          laneOf[p] = pl;
          occupied[i][pl] = true;
        }
        return { id: p, lane: pl, row: rowOf[p] };
      });

      let lane = laneOf[id];
      if (lane === undefined || occupied[i][lane]) {
        const pref = parentInfos.length && parentInfos[0].row >= 0 ? parentInfos[0].lane : 0;
        lane = allocLane(i, pref);
      }
      laneOf[id] = lane;
      occupied[i][lane] = true;
      rows[i].lane = lane;

      parentInfos.forEach(function (info) {
        if (info.row < 0) return;
        for (let r = i; r < info.row; r++) occupied[r][info.lane] = true;
        rows[i].parents.push(info);
      });
    }

    let maxLane = 0;
    rows.forEach(function (r) {
      maxLane = Math.max(maxLane, r.lane);
      r.parents.forEach(function (p) { maxLane = Math.max(maxLane, p.lane); });
    });

    return {
      order: order,
      rows: rows,
      maxLane: maxLane,
      width: (maxLane + 1) * LANE_W + 420,
      height: rows.length * ROW_H + 30
    };
  }

  const GraphView = {
    scale: 1,
    tx: 40,
    ty: 44,
    selected: null,
    onSelect: null,

    resetView: function () {
      this.scale = 1;
      this.tx = 40;
      this.ty = 20;
    },

    applyTransform: function () {
      const viewport = document.getElementById('viewport');
      viewport.setAttribute('transform',
        'translate(' + this.tx + ',' + this.ty + ') scale(' + this.scale + ')');
    },

    render: function (repo) {
      const self = this;
      const showDangling = document.getElementById('toggle-dangling').checked;
      const data = layout(repo, showDangling);
      const reachable = repo.reachableIds();
      const edgeLayer = document.getElementById('edge-layer');
      const nodeLayer = document.getElementById('node-layer');
      const labelLayer = document.getElementById('label-layer');
      edgeLayer.innerHTML = '';
      nodeLayer.innerHTML = '';
      labelLayer.innerHTML = '';

      self.applyTransform();

      function nodeX(lane) { return lane * LANE_W + 14; }
      function nodeY(row) { return row * ROW_H + ROW_H / 2; }

      data.rows.forEach(function (r, i) {
        const c = repo.commits[data.order[i]];
        const dangling = !reachable[data.order[i]];
        const x = nodeX(r.lane);
        const y = nodeY(i);
        r.parents.forEach(function (p) {
          const px = nodeX(p.lane);
          const py = nodeY(p.row);
          const d = 'M' + x + ',' + y +
            ' C' + x + ',' + (y + ROW_H * 0.55) +
            ' ' + px + ',' + (py - ROW_H * 0.55) +
            ' ' + px + ',' + py;
          edgeLayer.appendChild(GV.svgEl('path', {
            d: d,
            'class': 'edge' + (dangling ? ' edge-dangling' : ''),
            stroke: laneColor(p.lane)
          }));
        });
      });

      data.rows.forEach(function (r, i) {
        const id = data.order[i];
        const c = repo.commits[id];
        const dangling = !reachable[id];
        const x = nodeX(r.lane);
        const y = nodeY(i);

        const g = GV.svgEl('g', {
          'class': 'commit-node' + (dangling ? ' node-dangling' : '') + (self.selected === id ? ' sel' : ''),
          transform: 'translate(' + x + ',' + y + ')'
        });
        g.appendChild(GV.svgEl('circle', {
          r: c.parents.length > 1 ? NODE_R + 1.5 : NODE_R,
          fill: laneColor(r.lane),
          stroke: '#0b1016',
          'stroke-width': 1.5
        }));
        g.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (self.onSelect) self.onSelect(id);
        });
        nodeLayer.appendChild(g);

        const refs = repo.refsAt(id);
        let chipX = x + 14;
        refs.forEach(function (ref) {
          const label = ref.kind === 'detached' ? 'HEAD' : (ref.kind === 'tag' ? String.fromCharCode(127991) + ' ' + ref.name : ref.name);
          const w = label.length * 7 + 16;
          const cls = ref.kind === 'detached' ? 'detach' : ref.kind;
          const rectY = y - 9;
          labelLayer.appendChild(GV.svgEl('rect', {
            x: chipX, y: rectY, width: w, height: 18, rx: 9,
            fill: chipColor(cls), stroke: '#0b1016', 'stroke-width': 1
          }));
          const txt = GV.svgEl('text', {
            x: chipX + w / 2, y: y + 1, 'text-anchor': 'middle',
            'font-size': 10, fill: '#fff', 'pointer-events': 'none',
            'dominant-baseline': 'middle'
          });
          txt.textContent = label;
          labelLayer.appendChild(txt);
          chipX += w + 5;
        });

        const textX = Math.max(x + 14, chipX + 4);
        const msg = GV.svgEl('text', { x: textX, y: y - 8, 'class': 'commit-msg' });
        msg.textContent = c.message || '(no message)';
        labelLayer.appendChild(msg);

        const sha = GV.svgEl('text', { x: textX, y: y + 11, 'class': 'commit-sha' });
        let suffix = '';
        if (c.parents.length > 1) suffix = '  merge(' + c.parents.length + ')';
        sha.textContent = GV.shortId(c.id) + suffix;
        labelLayer.appendChild(sha);
      });

      const svg = document.getElementById('graph');
      svg.setAttribute('width', data.width);
      svg.setAttribute('height', data.height);
      this._data = data;
      return data;
    },

    fit: function () {
      const wrap = document.getElementById('canvas-wrap');
      const svg = document.getElementById('graph');
      const w = parseFloat(svg.getAttribute('width')) || 400;
      const h = parseFloat(svg.getAttribute('height')) || 300;
      const availW = wrap.clientWidth - 24;
      const availH = wrap.clientHeight - 60;
      this.scale = Math.min(availW / w, availH / h, 1.15);
      this.tx = 10;
      this.ty = 96;
    },

    zoomAt: function (factor, cx, cy) {
      const newScale = Math.min(3, Math.max(0.25, this.scale * factor));
      const k = newScale / this.scale;
      this.tx = cx - (cx - this.tx) * k;
      this.ty = cy - (cy - this.ty) * k;
      this.scale = newScale;
    }
  };

  function laneColor(lane) {
    const colors = ['#4da3ff', '#3fb950', '#d29922', '#bc8cff', '#f85149', '#39c5cf', '#db61a2', '#e3b341'];
    return colors[lane % colors.length];
  }

  function chipColor(cls) {
    if (cls === 'tag') return '#8957e5';
    if (cls === 'detach') return '#57606a';
    return '#1f6feb';
  }

  GV.GraphView = GraphView;
  GV.laneColor = laneColor;
  GV.graphConsts = { ROW_H: ROW_H, LANE_W: LANE_W };
})(window);
