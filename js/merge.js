'use strict';
(function (global) {
  const GV = global.GV;

  function splitLines(text) {
    if (text === '' || text == null) return [];
    return String(text).split('\n');
  }

  function syncPairs(a, b) {
    const n = a.length;
    const m = b.length;
    const dp = [];
    let i;
    let j;
    for (i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const pairs = [];
    i = 0;
    j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        pairs.push([i, j]);
        i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        i++;
      } else {
        j++;
      }
    }
    return pairs;
  }

  function diff3Regions(base, ours, theirs) {
    const po = syncPairs(base, ours);
    const pt = syncPairs(base, theirs);
    const syncs = [];
    let io = 0;
    let it = 0;
    while (io < po.length || it < pt.length) {
      const bo = io < po.length ? po[io][0] : Infinity;
      const bt = it < pt.length ? pt[it][0] : Infinity;
      if (bo === bt) {
        syncs.push([bo, po[io][1], pt[it][1]]);
        io++; it++;
      } else if (bo < bt) {
        io++;
      } else {
        it++;
      }
    }
    const regions = [];
    let pb = 0;
    let pu = 0;
    let pv = 0;
    syncs.forEach(function (s) {
      regions.push({
        kind: 'change',
        base: base.slice(pb, s[0]),
        ours: ours.slice(pu, s[1]),
        theirs: theirs.slice(pv, s[2])
      });
      regions.push({ kind: 'sync', line: base[s[0]] });
      pb = s[0] + 1;
      pu = s[1] + 1;
      pv = s[2] + 1;
    });
    regions.push({
      kind: 'change',
      base: base.slice(pb),
      ours: ours.slice(pu),
      theirs: theirs.slice(pv)
    });
    return regions;
  }

  function diff3Merge(baseText, oursText, theirsText, labels) {
    const base = splitLines(baseText);
    const ours = splitLines(oursText);
    const theirs = splitLines(theirsText);
    const regions = diff3Regions(base, ours, theirs);

    const merged = [];
    let conflicts = 0;
    regions.forEach(function (r) {
      if (r.kind === 'sync') {
        merged.push(r.line);
        return;
      }
      const bStr = r.base.join('\n');
      const oStr = r.ours.join('\n');
      const tStr = r.theirs.join('\n');
      if (oStr === bStr) {
        merged.push.apply(merged, r.theirs);
      } else if (tStr === bStr || oStr === tStr) {
        merged.push.apply(merged, r.ours);
      } else if (!oStr && !tStr) {
        merged.push.apply(merged, r.base);
      } else {
        conflicts++;
        merged.push('<<<<<<< ' + (labels ? labels.ours : 'ours'));
        merged.push.apply(merged, r.ours);
        merged.push('||||||| ' + (labels ? labels.base : 'base'));
        merged.push.apply(merged, r.base);
        merged.push('=======');
        merged.push.apply(merged, r.theirs);
        merged.push('>>>>>>> ' + (labels ? labels.theirs : 'theirs'));
      }
    });

    return { text: merged.join('\n'), conflicts: conflicts };
  }

  function mergeTrees(baseTree, oursTree, theirsTree, labels) {
    const result = {};
    const conflicts = [];
    const paths = {};
    Object.keys(baseTree || {}).forEach(function (p) { paths[p] = 1; });
    Object.keys(oursTree || {}).forEach(function (p) { paths[p] = 1; });
    Object.keys(theirsTree || {}).forEach(function (p) { paths[p] = 1; });

    Object.keys(paths).sort().forEach(function (p) {
      const b = baseTree ? baseTree[p] : undefined;
      const o = oursTree ? oursTree[p] : undefined;
      const t = theirsTree ? theirsTree[p] : undefined;
      const hasB = Object.prototype.hasOwnProperty.call(baseTree || {}, p);
      const hasO = Object.prototype.hasOwnProperty.call(oursTree || {}, p);
      const hasT = Object.prototype.hasOwnProperty.call(theirsTree || {}, p);

      if (o === t) { if (hasO) result[p] = o; return; }
      if (!hasT || t === b) { if (hasO) result[p] = o; return; }
      if (!hasO || o === b) { if (hasT) result[p] = t; return; }

      if (hasO && hasT) {
        const res = diff3Merge(hasB ? b : '', o, t, labels);
        result[p] = res.text;
        if (res.conflicts > 0) {
          conflicts.push({
            path: p,
            type: 'content',
            base: hasB ? b : null,
            ours: o,
            theirs: t,
            merged: res.text
          });
        }
      } else if (hasO && !hasT) {
        conflicts.push({ path: p, type: 'modify-delete', side: 'theirs', ours: o, base: b, merged: o });
      } else {
        conflicts.push({ path: p, type: 'modify-delete', side: 'ours', ours: null, theirs: t, base: b, merged: t });
      }
    });

    return { tree: result, conflicts: conflicts };
  }

  function mergeTreesMulti(baseTree, sideTrees, labels) {
    let current = GV.clone(sideTrees[0]);
    const allConflicts = [];
    for (let i = 1; i < sideTrees.length; i++) {
      const res = mergeTrees(baseTree, current, sideTrees[i], labels);
      current = res.tree;
      res.conflicts.forEach(function (c) { allConflicts.push(c); });
    }
    const unique = [];
    const seen = {};
    allConflicts.forEach(function (c) {
      if (!seen[c.path]) { seen[c.path] = 1; unique.push(c); }
    });
    return { tree: current, conflicts: unique };
  }

  GV.diff3Merge = diff3Merge;
  GV.mergeTrees = mergeTrees;
  GV.mergeTreesMulti = mergeTreesMulti;
})(window);
