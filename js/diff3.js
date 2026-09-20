/* diff3.js — 基于 LCS 的逐行三路合并 (base / ours / theirs)
 *
 * 分别求 (base,ours)、(base,theirs) 的差异块（以 base 坐标表示），
 * 然后沿 base 同步推进：
 *   - 两边都没动的行：直接保留；
 *   - 只有一边改动：取改动侧（这是“双方改不同行不冲突”的关键）；
 *   - 两边差异块在 base 上重叠：构成冲突区域，双方结果一致则自动取，
 *     否则写 <<<<<<< / ======= / >>>>>>> 冲突标记。
 */
(function (global) {
  "use strict";

  // 前缀 DP：dp[i][j] = a[0..i) 与 b[0..j) 的 LCS 长度
  function lcsTable(a, b) {
    const n = a.length, m = b.length;
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp;
  }

  // 差异块：{start,end(相对 base，半开), del:[base旧行], ins:[新行]}
  function diffChunks(base, other) {
    const dp = lcsTable(base, other);
    const chunks = [];
    let cur = null;
    const finish = () => { if (cur) { chunks.unshift(cur); cur = null; } };
    let bi = base.length, j = other.length;
    while (bi > 0 && j > 0) {
      if (base[bi - 1] === other[j - 1]) { finish(); bi--; j--; }
      else if (dp[bi - 1][j] >= dp[bi][j - 1]) {
        if (!cur) cur = { start: bi - 1, end: bi - 1, del: [], ins: [] };
        cur.del.unshift(base[bi - 1]); cur.start = bi - 1; cur.end = bi; bi--;
      } else {
        if (!cur) cur = { start: bi, end: bi, del: [], ins: [] };
        cur.ins.unshift(other[j - 1]); j--;
      }
    }
    while (bi > 0) {
      if (!cur) cur = { start: bi - 1, end: bi - 1, del: [], ins: [] };
      cur.del.unshift(base[bi - 1]); cur.start = bi - 1; cur.end = bi; bi--;
    }
    while (j > 0) {
      if (!cur) cur = { start: bi, end: bi, del: [], ins: [] };
      cur.ins.unshift(other[j - 1]); j--;
    }
    finish();
    return chunks;
  }

  // 把某一侧差异块应用到 base 的 [rs,re) 区间，得到该侧在该区间的结果文本
  // 取一侧在 base 区间 [rs,re] 内（含 rs 处的插入点）的结果行
  function sideSlice(base, chunks, rs, re) {
    const out = [];
    let cur = rs;
    for (const ch of chunks) {
      // 块在区间之后（对纯插入块，插入点等于 re 也属于该区间边界）
      if (ch.start > re || ch.end < rs) continue;
      if (ch.start < rs && ch.end <= rs) continue;
      const s = Math.max(ch.start, rs);
      const e = Math.min(ch.end, re);
      for (let x = cur; x < s; x++) out.push(base[x]);
      out.push(...ch.ins);
      cur = e;
    }
    for (let x = cur; x < re; x++) out.push(base[x]);
    return out;
  }

  function linesEq(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function merge3(baseStr, oursStr, theirsStr, labels) {
    labels = labels || {};
    const lo = labels.ours || "HEAD";
    const lt = labels.theirs || "incoming";
    const A = baseStr.split("\n");
    const out = [];
    let conflicts = 0;

    const cO = diffChunks(A, oursStr.split("\n"));
    const cT = diffChunks(A, theirsStr.split("\n"));
    let bi = 0, po = 0, pt = 0;

    const emitConflict = (rs, re) => {
      const rb = A.slice(rs, re);
      const ro = sideSlice(A, cO, rs, re);
      const rt = sideSlice(A, cT, rs, re);
      if (linesEq(ro, rb)) { out.push(...rt); return; }
      if (linesEq(rt, rb)) { out.push(...ro); return; }
      if (linesEq(ro, rt)) { out.push(...ro); return; }
      conflicts++;
      out.push("<<<<<<< " + lo);
      out.push(...ro);
      out.push("=======");
      out.push(...rt);
      out.push(">>>>>>> " + lt);
    };

    for (;;) {
      const co = po < cO.length ? cO[po] : null;
      const ct = pt < cT.length ? cT[pt] : null;
      if (!co && !ct) {
        if (bi < A.length) { out.push(A[bi]); bi++; continue; }
        break;
      }

      // 下一个事件位置（块起点；纯插入块 start===end）
      const so = co ? co.start : Infinity;
      const st = ct ? ct.start : Infinity;
      const next = Math.min(so, st);

      // 事件之前的公共行
      while (bi < Math.min(next, A.length)) { out.push(A[bi]); bi++; }

      if (so < st) {
        out.push(...co.ins);
        bi = Math.max(bi, co.end); po++;
      } else if (st < so) {
        out.push(...ct.ins);
        bi = Math.max(bi, ct.end); pt++;
      } else {
        // 同一起点：重叠（或相邻）冲突区域
        let re = Math.max(co.end, ct.end);
        po++; pt++;
        for (;;) {
          const no = po < cO.length ? cO[po] : null;
          const nt = pt < cT.length ? cT[pt] : null;
          let grew = false;
          if (no && no.start <= re) { re = Math.max(re, no.end); po++; grew = true; }
          if (nt && nt.start <= re) { re = Math.max(re, nt.end); pt++; grew = true; }
          if (!grew) break;
        }
        emitConflict(next, re);
        bi = Math.max(bi, re);
      }
    }

    return { ok: conflicts === 0, result: out.join("\n"), conflicts };
  }

  global.Diff3 = { merge3, diffChunks };
})(window);
