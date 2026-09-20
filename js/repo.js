'use strict';
(function (global) {
  const GV = global.GV;

  class Commit {
    constructor(id, parents, tree, message, time) {
      this.id = id;
      this.parents = parents || [];
      this.tree = tree || {};
      this.message = message || '';
      this.time = time || Date.now();
    }
  }

  class Repo {
    constructor() {
      this.commits = {};
      this.branches = {};
      this.tags = {};
      this.headRef = 'refs/heads/main';
      this.detached = false;
      this.detachedId = null;
      this.index = {};
      this.worktree = {};
      this.seq = 1;
    }

    genId() {
      const hex = '0123456789abcdef';
      let id = '';
      do {
        id = '';
        for (let i = 0; i < 8; i++) id += hex[Math.floor(Math.random() * 16)];
      } while (this.commits[id]);
      return id;
    }

    headId() {
      if (this.detached) return this.detachedId;
      return Object.prototype.hasOwnProperty.call(this.branches, this.headRef)
        ? this.branches[this.headRef] : null;
    }

    headTree() {
      const id = this.headId();
      return id ? GV.clone(this.commits[id].tree) : {};
    }

    branchName() {
      return this.detached ? null : this.headRef.slice('refs/heads/'.length);
    }

    allRefs() {
      const list = [];
      for (const r in this.branches) list.push({ kind: 'branch', ref: r, name: r.slice(11), id: this.branches[r] });
      for (const r in this.tags) list.push({ kind: 'tag', ref: r, name: r.slice(10), id: this.tags[r] });
      return list;
    }

    refsAt(id) {
      const out = [];
      for (const r in this.branches) if (this.branches[r] === id) out.push({ kind: 'branch', name: r.slice(11) });
      for (const r in this.tags) if (this.tags[r] === id) out.push({ kind: 'tag', name: r.slice(10) });
      if (this.detached && this.detachedId === id) out.push({ kind: 'detached', name: 'HEAD' });
      return out;
    }

    addCommit(parents, tree, message) {
      const id = this.genId();
      const c = new Commit(id, parents, GV.clone(tree || {}), message, this.seq++);
      this.commits[id] = c;
      return c;
    }

    setHeadToCommit(id) {
      if (this.detached) this.detachedId = id;
      else this.branches[this.headRef] = id;
    }

    createBranch(name, id) {
      const ref = 'refs/heads/' + name;
      if (this.branches[ref]) throw new GV.GitError('分支已存在: ' + name);
      this.branches[ref] = id || this.headId();
    }

    deleteBranch(name) {
      const ref = 'refs/heads/' + name;
      if (!this.branches[ref]) throw new GV.GitError('分支不存在: ' + name);
      if (!this.detached && this.headRef === ref) throw new GV.GitError('不能删除当前检出的分支: ' + name);
      delete this.branches[ref];
    }

    createTag(name, id) {
      const ref = 'refs/tags/' + name;
      if (this.tags[ref]) throw new GV.GitError('标签已存在: ' + name);
      this.tags[ref] = id || this.headId();
    }

    deleteTag(ref) {
      if (!this.tags[ref]) throw new GV.GitError('标签不存在: ' + ref);
      delete this.tags[ref];
    }

    checkoutRef(ref) {
      let id = null;
      let detached = false;
      if (ref === 'HEAD') { id = this.headId(); detached = this.detached; }
      else if (this.branches[ref]) { id = this.branches[ref]; detached = false; }
      else if (this.tags[ref]) { id = this.tags[ref]; detached = true; }
      else throw new GV.GitError('引用不存在: ' + ref);
      if (this.branches[ref]) this.headRef = ref;
      this.detached = detached;
      this.detachedId = detached ? id : null;
      const tree = id ? GV.clone(this.commits[id].tree) : {};
      this.index = GV.clone(tree);
      this.worktree = GV.clone(tree);
    }

    detachAt(id) {
      if (!this.commits[id]) throw new GV.GitError('提交不存在: ' + id);
      this.detached = true;
      this.detachedId = id;
      this.index = GV.clone(this.commits[id].tree);
      this.worktree = GV.clone(this.commits[id].tree);
    }

    ancestorSet(ids) {
      const seen = {};
      const stack = (ids || []).slice();
      while (stack.length) {
        const id = stack.pop();
        if (!id || seen[id]) continue;
        seen[id] = true;
        const c = this.commits[id];
        if (c) for (const p of c.parents) stack.push(p);
      }
      return seen;
    }

    isAncestor(a, b) {
      if (!a) return false;
      return Boolean(this.ancestorSet([b])[a]);
    }

    mergeBasesMany(ids) {
      const self = this;
      const present = ids.filter(function (id) { return id && self.commits[id]; });
      if (!present.length) return [];
      let common = this.ancestorSet([present[0]]);
      for (let i = 1; i < present.length; i++) {
        const s = this.ancestorSet([present[i]]);
        for (const k in common) if (!s[k]) delete common[k];
      }
      const bases = Object.keys(common).filter(function (id) {
        const c = self.commits[id];
        return !c.parents.some(function (p) { return common[p]; });
      });
      bases.sort(function (x, y) { return self.commits[y].time - self.commits[x].time; });
      return bases;
    }

    mergeBase(a, b) {
      const bases = this.mergeBasesMany([a, b]);
      return bases.length ? bases[0] : null;
    }

    rebaseList(upstream, headId) {
      const up = this.ancestorSet([upstream]);
      const out = [];
      let cur = headId;
      while (cur && !up[cur]) {
        out.push(cur);
        const c = this.commits[cur];
        cur = c.parents[0] || null;
      }
      return out.reverse();
    }

    patchId(id) {
      const c = this.commits[id];
      if (!c.parents.length) return 'ROOT:' + JSON.stringify(c.tree);
      const base = this.commits[c.parents[0]].tree;
      const changes = [];
      const paths = {};
      Object.keys(base).forEach(function (p) { paths[p] = 1; });
      Object.keys(c.tree).forEach(function (p) { paths[p] = 1; });
      Object.keys(paths).sort().forEach(function (p) {
        if (base[p] !== c.tree[p]) {
          changes.push(p + ' ' + (Object.prototype.hasOwnProperty.call(c.tree, p) ? c.tree[p] : '<DEL>'));
        }
      });
      return changes.join('\n');
    }

    hasPatch(ids, patch) {
      const self = this;
      return ids.some(function (id) { return self.patchId(id) === patch; });
    }

    snapshot() {
      return {
        commits: GV.clone(this.commits),
        branches: GV.clone(this.branches),
        tags: GV.clone(this.tags),
        headRef: this.headRef,
        detached: this.detached,
        detachedId: this.detachedId,
        index: GV.clone(this.index),
        worktree: GV.clone(this.worktree),
        seq: this.seq
      };
    }

    restore(snap) {
      this.commits = GV.clone(snap.commits);
      this.branches = GV.clone(snap.branches);
      this.tags = GV.clone(snap.tags);
      this.headRef = snap.headRef;
      this.detached = snap.detached;
      this.detachedId = snap.detachedId;
      this.index = GV.clone(snap.index);
      this.worktree = GV.clone(snap.worktree);
      this.seq = snap.seq;
    }

    reachableIds() {
      const tips = [];
      for (const r in this.branches) tips.push(this.branches[r]);
      for (const r in this.tags) tips.push(this.tags[r]);
      if (this.detached && this.detachedId) tips.push(this.detachedId);
      return this.ancestorSet(tips);
    }
  }

  GV.Commit = Commit;
  GV.Repo = Repo;
})(window);
