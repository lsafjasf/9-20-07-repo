/* layout.js — 提交图泳道布局
 *
 * 策略：
 *  1. 从所有 ref 可达提交做拓扑排序（子在前、父在后），同层按时间新→旧；
 *  2. 逐行（提交）分配泳道：
 *     - 提交占据其“流动”到的泳道；第一父继续沿该泳道向下（让位规则除外）；
 *     - merge 的额外父提交若尚未露头，在主泳道附近选空泳道预留，
 *       避免连线跨越其它泳道；
 *  3. 不可达（游离）提交排在图底部，独立成区。
 */
(function (global) {
  "use strict";

  const X0 = 90, LANE_W = 22, Y0 = 60, ROW_H = 66, R = 8;

  function topoSort(repo, includeSet) {
    const commits = repo.commits;
    const indeg = new Map();
    for (const sha of includeSet) indeg.set(sha, 0);
    for (const sha of includeSet) {
      const c = commits[sha];
      if (!c) continue;
      for (const p of c.parents) if (indeg.has(p)) indeg.set(p, indeg.get(p) + 1);
    }
    const heap = [];
    for (const sha of includeSet) if (indeg.get(sha) === 0) heap.push(sha);
    const cmp = (a, b) => commits[b].time - commits[a].time;
    const out = [];
    while (heap.length) {
      heap.sort(cmp);
      const sha = heap.shift();
      out.push(sha);
      for (const p of commits[sha].parents) {
        if (!indeg.has(p)) continue;
        indeg.set(p, indeg.get(p) - 1);
        if (indeg.get(p) === 0) heap.push(p);
      }
    }
    return out;
  }

  function buildLayout(repo, showUnreachable) {
    const reach = repo.allReachable();
    const commits = repo.commits;

    const order = topoSort(repo, reach);

    const unreachSet = new Set(Object.keys(commits).filter(s => !reach.has(s)));
    const unreachOrder = showUnreachable && unreachSet.size
      ? topoSort(repo, unreachSet) : [];

    const rows = [];
    const laneOf = new Map();
    let lanes = []; // lanes[i] = 当前沿该泳道等待出现的提交 sha，null 为空

    const ordered = order.concat(unreachOrder);
    const rowSet = new Set(ordered);

    const allocLane = () => {
      for (let i = 0; i < lanes.length; i++) if (lanes[i] === null) return i;
      lanes.push(null);
      return lanes.length - 1;
    };

    for (const sha of ordered) {
      const c = commits[sha];
      const parents = c.parents.filter(p => commits[p] && rowSet.has(p));

      let lane = laneOf.has(sha) ? laneOf.get(sha) : allocLane();
      laneOf.set(sha, lane);

      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i] === sha && i !== lane) lanes[i] = null;
      }

      const placeParent = (ps, isPrimary) => {
        if (laneOf.has(ps)) {
          const pl = laneOf.get(ps);
          // 第一父在别的泳道流动：当前泳道结束让位，连线渲染时斜向汇合
          if (isPrimary && pl !== lane) lanes[lane] = null;
          else if (isPrimary) lanes[lane] = ps;
          return pl;
        }
        let pl;
        if (isPrimary) {
          pl = lane;
        } else {
          pl = -1;
          let best = Infinity;
          for (let i = 0; i < lanes.length; i++) {
            if (lanes[i] === null && Math.abs(i - lane) < best) {
              best = Math.abs(i - lane); pl = i;
            }
          }
          if (pl === -1) { lanes.push(null); pl = lanes.length - 1; }
        }
        lanes[pl] = ps;
        laneOf.set(ps, pl);
        return pl;
      };

      const extraLanes = [];
      if (parents[0]) placeParent(parents[0], true);
      else lanes[lane] = null;
      for (let pi = 1; pi < parents.length; pi++) {
        extraLanes.push(placeParent(parents[pi], false));
      }

      rows.push({ sha, lane, extraLanes, unreachable: !reach.has(sha) });
      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    }

    const nodes = new Map();
    rows.forEach((row, idx) => {
      nodes.set(row.sha, {
        sha: row.sha,
        x: X0 + row.lane * LANE_W,
        y: Y0 + idx * ROW_H,
        lane: row.lane,
        extraLanes: row.extraLanes,
        unreachable: row.unreachable,
        row: idx
      });
    });

    const edges = [];
    for (const row of rows) {
      const from = nodes.get(row.sha);
      const c = commits[row.sha];
      c.parents.forEach((ps, pi) => {
        const to = nodes.get(ps);
        if (!to) return;
        const fromLane = pi === 0 ? row.lane : row.extraLanes[pi - 1];
        edges.push({
          from: row.sha, to: ps,
          x1: X0 + fromLane * LANE_W, y1: from.y + R,
          x2: X0 + to.lane * LANE_W, y2: to.y - R,
          fromLane, toLane: to.lane,
          unreachable: from.unreachable && to.unreachable
        });
      });
    }

    const width = Math.max(X0 * 2 + Math.max(lanes.length, 1) * LANE_W, 640);
    const height = Y0 * 2 + rows.length * ROW_H;
    return { nodes, edges, rows: rows.map(r => r.sha), width, height, R, ROW_H, Y0 };
  }

  global.GraphLayout = { buildLayout, topoSort, X0, LANE_W, Y0, ROW_H, R };
})(window);
