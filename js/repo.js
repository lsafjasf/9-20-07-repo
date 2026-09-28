/* repo.js — 简化但语义完整的 Git 引擎
 *
 * 核心模型：
 *   commits[sha] = { sha, parents:[sha...], message, tree:{path:content|null},
 *                    author, time }   (tree 中值为 null 表示该提交删除了文件)
 *   branches = { name: sha }   tags = { name: sha }
 *   head = { detached:boolean, ref:"main", sha:... }
 *   worktree = { path: content }   仅保存现存文件
 *
 * 多步操作（rebase / cherry-pick / revert / 冲突中的 merge）用 pending 描述，
 * 配合 continueConflict / abortOperation 构成冲突解决流程。
 */
(function (global) {
  "use strict";

  class GitError extends Error {}

  class Repo {
    constructor() {
      this.commits = Object.create(null);
      this.branches = Object.create(null);
      this.tags = Object.create(null);
      this.head = { detached: false, ref: "main", sha: null };
      this.worktree = {};
      this.pending = null;
      this.counter = 0;
      this.history = [];
      this.future = [];
      this.stashes = [];
      this._stashSeq = 0;
      // 引用日志（reflog）：只增不减，撤销/重做不会抹掉历史轨迹
      this.reflog = [];
      this._reflogSeq = 0;
      this._changeListeners = [];
      this._reflogBase = this._refState();
    }

    onChange(fn) { this._changeListeners.push(fn); }
    _emit() { for (const fn of this._changeListeners) fn(); }

    /* ---------- 基础工具 ---------- */

    _newSha() {
      // 7 位伪哈希，由单调计数器派生，保证唯一且短哈希稳定
      const chars = "0123456789abcdef";
      let x = ((++this.counter) * 2654435761 ^ 0x9e3779b9) >>> 0;
      let h = "";
      for (let i = 0; i < 7; i++) {
        x = (Math.imul(x ^ (this.counter << (i % 8)), 1103515245) + 12345) >>> 0;
        h += chars[(x >>> (i * 2)) & 15];
      }
      let sha = h, guard = 0;
      while (this.commits[sha] && guard++ < 99) sha = h + (guard).toString(16);
      return sha.slice(0, 7);
    }

    headSha() {
      if (this.head.detached) return this.head.sha;
      return this.branches[this.head.ref] || null;
    }

    getCommit(sha) { return sha ? (this.commits[sha] || null) : null; }
    headCommit() { return this.getCommit(this.headSha()); }

    // 支持 name / name~2 / HEAD / 完整或短 sha
    resolve(ref) {
      if (ref == null) return this.headSha();
      let tilde = 0;
      let name = String(ref).trim();
      const m = name.match(/^(.*)~(\d+)$/);
      if (m) { name = m[1]; tilde = +m[2]; }
      if (name === "HEAD") name = this.head.detached ? this.head.sha : this.head.ref;
      let sha = null;
      if (this.branches[name] != null) sha = this.branches[name];
      else if (this.tags[name] != null) sha = this.tags[name];
      else if (this.commits[name]) sha = name;
      else {
        const hit = Object.keys(this.commits).find(s => s.startsWith(name));
        if (hit) sha = hit;
      }
      if (!sha) throw new GitError("无法解析引用：" + ref);
      for (let i = 0; i < tilde; i++) {
        const c = this.commits[sha];
        if (!c || !c.parents.length) throw new GitError("引用 " + ref + " 没有足够的祖先");
        sha = c.parents[0];
      }
      return sha;
    }

    isAncestor(anc, desc) {
      if (!anc) return true;
      const seen = new Set();
      const stack = [desc];
      while (stack.length) {
        const s = stack.pop();
        if (s === anc) return true;
        if (!s || seen.has(s)) continue;
        seen.add(s);
        const c = this.commits[s];
        if (c) stack.push(...c.parents);
      }
      return false;
    }

    mergeBase(a, b) {
      const seen = new Set();
      let frontier = [a];
      while (frontier.length) {
        const next = [];
        for (const s of frontier) {
          if (!s || seen.has(s)) continue;
          seen.add(s);
          const c = this.commits[s];
          if (c) next.push(...c.parents);
        }
        frontier = next;
      }
      let best = null;
      frontier = [b];
      const visited = new Set();
      while (frontier.length) {
        const next = [];
        for (const s of frontier) {
          if (!s || visited.has(s)) continue;
          visited.add(s);
          if (seen.has(s) && (best === null || this.commits[s].time > this.commits[best].time)) best = s;
          const c = this.commits[s];
          if (c) next.push(...c.parents);
        }
        frontier = next;
      }
      return best;
    }

    treeAt(sha) {
      // 沿第一父链重放得到完整快照
      const c = this.getCommit(sha);
      if (!c) return {};
      const t = {};
      const chain = [];
      let cur = c;
      while (cur) {
        chain.unshift(cur);
        cur = cur.parents.length ? this.commits[cur.parents[0]] : null;
      }
      for (const cm of chain) {
        for (const [p, v] of Object.entries(cm.tree)) {
          if (v === null) delete t[p];
          else t[p] = v;
        }
      }
      return t;
    }

    /* ---------- 历史 / 撤销 ---------- */

    _snapshot() {
      return JSON.stringify({
        commits: this.commits, branches: this.branches, tags: this.tags,
        head: this.head, worktree: this.worktree, pending: this.pending,
        counter: this.counter, stashes: this.stashes, _stashSeq: this._stashSeq
      });
    }

    _restore(json) {
      const s = JSON.parse(json);
      this.commits = s.commits; this.branches = s.branches; this.tags = s.tags;
      this.head = s.head; this.worktree = s.worktree; this.pending = s.pending;
      this.counter = s.counter;
      this.stashes = s.stashes || []; this._stashSeq = s._stashSeq || 0;
      this._emit();
    }

    /* ---------- 引用日志（reflog） ---------- */

    // 当前全部引用的可比较快照：分支、标签，以及 HEAD 的附着状态。
    // 附着 HEAD 随分支移动时不重复记 HEAD 条目（分支条目已表达），
    // 只有 HEAD 自身切换附着 / 游离移动时才记 HEAD 条目。
    _refState() {
      return {
        branches: Object.assign({}, this.branches),
        tags: Object.assign({}, this.tags),
        head: this.head.detached ? "D:" + this.head.sha : "B:" + this.head.ref,
        headSha: this.head.detached ? this.head.sha : (this.branches[this.head.ref] || null),
        headRef: this.head.detached ? null : this.head.ref
      };
    }

    // 把自上次记录以来的引用净变化追加为日志条目（每个引用一条）
    _collectReflog(op) {
      const cur = this._refState();
      const prev = this._reflogBase;
      const push = (kind, ref, from, to, extra) => {
        this.reflog.push(Object.assign({
          seq: ++this._reflogSeq,
          op, kind, ref, from, to,
          time: this.counter,
          at: new Date().toISOString()
        }, extra || {}));
        if (this.reflog.length > 500) this.reflog.shift();
      };
      const branchNames = new Set([...Object.keys(prev.branches), ...Object.keys(cur.branches)]);
      for (const n of branchNames) {
        const a = prev.branches[n] != null ? prev.branches[n] : null;
        const b = cur.branches[n] != null ? cur.branches[n] : null;
        if (a !== b) push("branch", n, a, b);
      }
      const tagNames = new Set([...Object.keys(prev.tags), ...Object.keys(cur.tags)]);
      for (const n of tagNames) {
        const a = prev.tags[n] != null ? prev.tags[n] : null;
        const b = cur.tags[n] != null ? cur.tags[n] : null;
        if (a !== b) push("tag", n, a, b);
      }
      if (prev.head !== cur.head) {
        push("HEAD", "HEAD", prev.headSha, cur.headSha,
          { fromRef: prev.headRef, toRef: cur.headRef });
      }
      this._reflogBase = cur;
    }

    // 从历史条目回到该条目记录后的引用状态（回退本身也记入日志）
    restoreReflog(seq) {
      const e = this.reflog.find(x => x.seq === seq);
      if (!e) throw new GitError("没有该日志条目：" + seq);
      const label = "回退 " + (e.kind === "HEAD" ? "HEAD" : e.ref) + " 到日志 #" + e.seq;
      return this._transaction(label, () => {
        if (e.kind === "branch") {
          if (e.to === null) {
            if (!this.head.detached && this.head.ref === e.ref)
              throw new GitError("该状态要求删除当前所在分支，无法回退");
            delete this.branches[e.ref];
          } else {
            if (!this.commits[e.to]) throw new GitError("目标提交已不存在：" + e.to);
            const isCurrent = !this.head.detached && this.head.ref === e.ref;
            if (isCurrent && this.worktreeStatus().some(r => r.status !== "C"))
              throw new GitError("工作区有未提交改动，请先提交、储藏或 reset --hard");
            this.branches[e.ref] = e.to;
            if (isCurrent) this.worktree = this.treeAt(e.to);
          }
        } else if (e.kind === "tag") {
          if (e.to === null) delete this.tags[e.ref];
          else {
            if (!this.commits[e.to]) throw new GitError("目标提交已不存在：" + e.to);
            this.tags[e.ref] = e.to;
          }
        } else { // HEAD
          if (e.toRef) {
            if (this.worktreeStatus().some(r => r.status !== "C"))
              throw new GitError("工作区有未提交改动，请先提交、储藏或 reset --hard");
            this.head = { detached: false, ref: e.toRef, sha: null };
            this.worktree = this.treeAt(this.branches[e.toRef]);
          } else {
            if (!this.commits[e.to]) throw new GitError("目标提交已不存在：" + e.to);
            if (this.worktreeStatus().some(r => r.status !== "C"))
              throw new GitError("工作区有未提交改动，请先提交、储藏或 reset --hard");
            this.head = { detached: true, ref: null, sha: e.to };
            this.worktree = this.treeAt(e.to);
          }
        }
        return e;
      });
    }

    /* ---------- 储藏（stash） ---------- */

    stashSave(message) {
      if (this.pending) throw new GitError("请先结束当前进行中的操作");
      const changes = this.worktreeStatus().filter(r => r.status !== "C");
      if (!changes.length) throw new GitError("工作区没有可储藏的改动");
      return this._transaction("stash 储藏（" + changes.length + " 个文件）", () => {
        const entry = {
          id: "stash-" + (++this._stashSeq),
          message: (message || "").trim() ||
            "WIP on " + (this.head.detached ? "HEAD" : this.head.ref),
          baseSha: this.headSha(),
          branch: this.head.detached ? null : this.head.ref,
          tree: Object.assign({}, this.worktree),
          time: this.counter
        };
        this.stashes.unshift(entry);
        this.worktree = this.headSha() ? this.treeAt(this.headSha()) : {};
        return entry;
      });
    }

    stashApply(id) {
      if (this.pending) throw new GitError("请先结束当前进行中的操作");
      const st = this.stashes.find(s => s.id === id);
      if (!st) throw new GitError("找不到储藏：" + id);
      return this._transaction("stash apply " + st.message, () => {
        const base = st.baseSha ? this.treeAt(st.baseSha) : {};
        const r = this._mergeTrees(base, Object.assign({}, this.worktree), st.tree,
          "工作区", st.message);
        if (r.conflicts.length)
          throw new GitError("应用储藏时冲突：" + r.conflicts.map(c => c.path).join("、"));
        this.worktree = r.tree;
        return st;
      });
    }

    stashDrop(id) {
      const idx = this.stashes.findIndex(s => s.id === id);
      if (idx < 0) throw new GitError("找不到储藏：" + id);
      return this._transaction("stash drop " + this.stashes[idx].message, () => {
        this.stashes.splice(idx, 1);
      });
    }

    // 内容摘要：相对储藏时的基线提交，新增/修改/删除了哪些文件
    stashSummary(id) {
      const st = typeof id === "object" && id ? id : this.stashes.find(s => s.id === id);
      if (!st) throw new GitError("找不到储藏：" + id);
      const base = st.baseSha ? this.treeAt(st.baseSha) : {};
      const has = (o, p) => Object.prototype.hasOwnProperty.call(o, p);
      const paths = new Set([...Object.keys(base), ...Object.keys(st.tree)]);
      const adds = [], mods = [], dels = [];
      for (const p of [...paths].sort()) {
        const inB = has(base, p), inT = has(st.tree, p);
        if (inB && !inT) dels.push(p);
        else if (!inB && inT) adds.push(p);
        else if (base[p] !== st.tree[p]) mods.push(p);
      }
      return {
        adds, mods, dels,
        paths: [...adds, ...mods, ...dels],
        files: adds.length + mods.length + dels.length
      };
    }

    _transaction(label, fn) {
      const before = this._snapshot();
      try {
        const result = fn();
        this.history.push({ label, before, after: this._snapshot() });
        if (this.history.length > 200) this.history.shift();
        this.future = [];
        this._collectReflog(label);
        this._emit();
        return result;
      } catch (e) {
        this._restore(before);
        throw e;
      }
    }

    // 多步流程（冲突解决过程中）复用同一个历史条目
    _swapStep(label) {
      return {
        commit: () => {
          const top = this.history[this.history.length - 1];
          if (top && top.label === label) top.after = this._snapshot();
          else this.history.push({ label, before: this._snapshot(), after: this._snapshot() });
          this.future = [];
          this._collectReflog(label);
          this._emit();
        }
      };
    }

    undo() {
      const h = this.history.pop();
      if (!h) throw new GitError("没有可撤销的操作");
      this.future.push(h);
      this._restore(h.before);
      this._collectReflog("撤销：" + h.label);
      return h.label;
    }

    redo() {
      const h = this.future.pop();
      if (!h) throw new GitError("没有可重做的操作");
      this.history.push(h);
      this._restore(h.after);
      this._collectReflog("重做：" + h.label);
      return h.label;
    }

    /* ---------- 工作区 ---------- */

    worktreeStatus() {
      const headTree = this.headSha() ? this.treeAt(this.headSha()) : {};
      const rows = [];
      const paths = new Set([...Object.keys(headTree), ...Object.keys(this.worktree)]);
      const conflicts = new Set(this.pending && this.pending.conflicts ? this.pending.conflicts.map(c => c.path) : []);
      for (const p of [...paths].sort()) {
        const inHead = Object.prototype.hasOwnProperty.call(headTree, p);
        const inWt = Object.prototype.hasOwnProperty.call(this.worktree, p);
        let st;
        if (conflicts.has(p)) st = "C";
        else if (inHead && !inWt) st = "D";
        else if (!inHead && inWt) st = "A";
        else if (inHead && inWt && headTree[p] !== this.worktree[p]) st = "M";
        else continue;
        rows.push({ path: p, status: st });
      }
      return rows;
    }

    saveWorkFile(path, content) {
      path = (path || "").trim();
      if (!path) throw new GitError("文件名不能为空");
      if (/[\\:*?"<>|]/.test(path)) throw new GitError("非法文件名");
      this.worktree[path] = content;
      this._emit();
    }

    deleteWorkFile(path) { delete this.worktree[path]; this._emit(); }

    /* ---------- 提交 ---------- */

    _makeCommit(parentShas, treeDelta, message, opts) {
      opts = opts || {};
      const sha = opts.sha || this._newSha();
      this.commits[sha] = {
        sha,
        parents: parentShas.slice(),
        message: message || "(no message)",
        tree: treeDelta,
        author: "you",
        time: opts.time != null ? opts.time : this.counter
      };
      return sha;
    }

    commit(message) {
      if (this.pending) throw new GitError("存在未完成的合并/变基，请先继续或中止");
      const headTree = this.headSha() ? this.treeAt(this.headSha()) : {};
      const delta = {};
      let changed = false;
      const paths = new Set([...Object.keys(headTree), ...Object.keys(this.worktree)]);
      for (const p of paths) {
        const inHead = Object.prototype.hasOwnProperty.call(headTree, p);
        const inWt = Object.prototype.hasOwnProperty.call(this.worktree, p);
        if (inHead && !inWt) { delta[p] = null; changed = true; }
        else if (inWt && (!inHead || headTree[p] !== this.worktree[p])) {
          delta[p] = this.worktree[p]; changed = true;
        }
      }
      return this._transaction("提交 " + (message || ""), () => {
        if (!changed) throw new GitError("工作区没有可提交的改动");
        const sha = this._makeCommit(this.headSha() ? [this.headSha()] : [], delta, message || "Update files");
        if (this.head.detached) this.head.sha = sha;
        else this.branches[this.head.ref] = sha;
        return sha;
      });
    }
    /* ---------- 分支 / 标签 / 切换 ---------- */

    createBranch(name, startRef) {
      name = (name || "").trim();
      if (!name) throw new GitError("分支名不能为空");
      if (/[\\~^:\s\[\]?*]/.test(name)) throw new GitError("非法分支名");
      if (this.branches[name]) throw new GitError("分支 " + name + " 已存在");
      const sha = startRef ? this.resolve(startRef) : this.headSha();
      if (!sha) throw new GitError("当前没有任何提交，无法创建分支");
      return this._transaction("创建分支 " + name, () => {
        this.branches[name] = sha;
        return name;
      });
    }

    createTag(name, ref) {
      name = (name || "").trim();
      if (!name) throw new GitError("标签名不能为空");
      if (this.tags[name]) throw new GitError("标签 " + name + " 已存在");
      const sha = ref ? this.resolve(ref) : this.headSha();
      if (!sha) throw new GitError("当前没有任何提交");
      return this._transaction("打标签 " + name, () => { this.tags[name] = sha; });
    }

    deleteRef(kind, name) {
      this._transaction(kind === "tag" ? "删除标签 " + name : "删除分支 " + name, () => {
        if (kind === "tag") delete this.tags[name];
        else {
          if (name === this.head.ref && !this.head.detached)
            throw new GitError("不能删除当前所在分支");
          delete this.branches[name];
        }
      });
    }

    checkoutBranch(name) {
      if (this.pending) throw new GitError("请先结束当前的合并/变基操作");
      if (!this.branches[name]) throw new GitError("分支不存在：" + name);
      const target = this.branches[name];
      if (this.worktreeStatus().some(r => r.status !== "C"))
        throw new GitError("工作区有未提交改动，请先提交或 reset --hard");
      this._transaction("切换到 " + name, () => {
        this.head = { detached: false, ref: name, sha: null };
        this.worktree = this.treeAt(target);
      });
    }

    checkoutCommit(sha) {
      const target = this.resolve(sha);
      if (this.worktreeStatus().some(r => r.status !== "C"))
        throw new GitError("工作区有未提交改动，请先提交或 reset --hard");
      this._transaction("detach 到 " + target.slice(0, 7), () => {
        this.head = { detached: true, ref: null, sha: target };
        this.worktree = this.treeAt(target);
      });
    }

    /* ---------- 三路树合并 ---------- */

    _mergeTrees(base, ours, theirs, labelO, labelT) {
      const result = {};
      const conflicts = [];
      const paths = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
      for (const path of paths) {
        const b = Object.prototype.hasOwnProperty.call(base, path) ? base[path] : undefined;
        const o = Object.prototype.hasOwnProperty.call(ours, path) ? ours[path] : undefined;
        const t = Object.prototype.hasOwnProperty.call(theirs, path) ? theirs[path] : undefined;
        if (o === t) { if (o !== undefined) result[path] = o; continue; }
        if (b === o) { if (t !== undefined) result[path] = t; continue; }
        if (b === t) { if (o !== undefined) result[path] = o; continue; }
        // 双方都改且不同（含双方各自新增同一文件但内容不同）
        // 即使改动落在不同行，若两侧差异区域在 base 上相邻/重叠（漂移），
        // 也按冲突处理——这正是 cherry-pick 依赖缺失、上下文漂移的情形。
        if (o !== undefined && t !== undefined && b !== undefined) {
          const chO = Diff3.diffChunks(b.split("\n"), o.split("\n"));
          const chT = Diff3.diffChunks(b.split("\n"), t.split("\n"));
          const overlap = chO.some(co =>
            chT.some(ct => co.start < ct.end && ct.start < co.end));
          const touch = chO.some(co =>
            chT.some(ct => co.start === ct.end || ct.start === co.end));
          if (overlap || touch) {
            const merged = Diff3.merge3(b, o, t, { ours: labelO, theirs: labelT });
            conflicts.push({
              path, type: "content",
              base: b, ours: o, theirs: t,
              drifted: touch && !overlap,
              content: merged.ok ? this._wrapDriftConflict(b, o, t, labelO, labelT) : merged.result
            });
            result[path] = conflicts[conflicts.length - 1].content;
            continue;
          }
        }
        if (o === undefined || t === undefined) {
          conflicts.push({
            path, type: "delmod",
            base: b, ours: o, theirs: t,
            oursPresent: o !== undefined, theirsPresent: t !== undefined
          });
          if (o !== undefined) result[path] = o;
          continue;
        }
        // 改动区域互不影响：正常三方自动合并
        const merged = Diff3.merge3(b === undefined ? "" : b, o, t,
          { ours: labelO, theirs: labelT });
        if (merged.ok) result[path] = merged.result;
        else {
          conflicts.push({
            path, type: "content",
            base: b === undefined ? "" : b, ours: o, theirs: t,
            addAdd: b === undefined,
            content: merged.result
          });
          result[path] = merged.result;
        }
      }
      // 跨文件依赖检查：theirs 新增/修改的文件若引用了“只在 theirs 树存在”的
      // 本地模块（相对路径 import/require），而 ours 树没有该文件，
      // 说明补丁缺少前置依赖（cherry-pick 依赖问题）-> 报依赖冲突。
      for (const path of paths) {
        const o = Object.prototype.hasOwnProperty.call(ours, path) ? ours[path] : undefined;
        const t2 = Object.prototype.hasOwnProperty.call(theirs, path) ? theirs[path] : undefined;
        const b2 = Object.prototype.hasOwnProperty.call(base, path) ? base[path] : undefined;
        // 只检查“补丁相对 base 真正改动/新增”的文件
        if (t2 === undefined || t2 === b2) continue;
        if (typeof t2 !== "string") continue;
        // 若该文件 ours 侧的内容已经能满足引用解析（即本次补丁没给它引入新依赖），
        // 也不应误报——因此仅当 ours 树里没有该文件（补丁新增文件）时才检查。
        if (o !== undefined && o === t2) continue;
        const refs = this._localRefs(path, t2);
        for (const ref of refs) {
          const existsO = Object.keys(ours).some(f => this._moduleMatch(ref, f));
          const existsT = Object.keys(theirs).some(f => this._moduleMatch(ref, f));
          if (!existsO && existsT) {
            conflicts.push({
              path, type: "dependency",
              base: b2, ours: o, theirs: t2,
              missing: ref,
              content: "<<<<<<< " + labelO + "\n" +
                (o === undefined ? "（" + path + " 在当前分支不存在）\n" : o) +
                "=======\n" + t2 +
                ">>>>>>> " + labelT + "（缺少依赖模块: " + ref + "）\n"
            });
            if (o !== undefined) result[path] = conflicts[conflicts.length - 1].content;
            break;
          }
        }
      }
      return { tree: result, conflicts };
    }

    _localRefs(fromPath, content) {
      const refs = [];
      const re = /(?:from\s+["']([.\/][^"']+)["'])|(?:require\(\s*["']([.\/][^"']+)["']\s*\))/g;
      let m;
      while ((m = re.exec(content))) refs.push(m[1] || m[2]);
      return refs;
    }

    _moduleMatch(ref, filePath) {
      const norm = s => s.replace(/\\/g, "/").replace(/\.(js|mjs|ts|jsx|tsx)$/, "");
      const dir = fromDir(filePath);
      const target = norm(ref);
      const candidates = [target, target + "/index"];
      const fp = norm(filePath);
      return candidates.some(c => {
        if (c.startsWith("./") || c.startsWith("../")) {
          return norm(joinPath(dir, c)) === fp || normalize(joinPath(dir, c)) === normalize(fp);
        }
        return false;
      }) || fp.endsWith(target.replace(/^\.\.?\//, ""));

      function fromDir(f) { const i = f.replace(/\\/g, "/").lastIndexOf("/"); return i < 0 ? "" : f.slice(0, i); }
      function joinPath(d, p) {
        const stack = d ? d.split("/") : [];
        p.replace(/^\.\//, "").split("/").forEach(seg => {
          if (seg === "..") stack.pop();
          else if (seg && seg !== ".") stack.push(seg);
        });
        return stack.join("/");
      }
      function normalize(p) { return p; }
    }

    _wrapDriftConflict(b, o, t, lo, lt) {
      return "<<<<<<< " + lo + "\n" + o +
        (o.endsWith("\n") ? "" : "\n") +
        "=======\n" + t +
        (t.endsWith("\n") ? "" : "\n") +
        ">>>>>>> " + lt + "\n";
    }

    /* ---------- merge（含 fast-forward 与 octopus） ---------- */

    merge(branchNames, opts) {
      opts = opts || {};
      if (this.pending) throw new GitError("请先结束当前进行中的操作");
      if (!branchNames || !branchNames.length) throw new GitError("请选择要合并的分支");
      const head = this.headSha();
      if (!head) throw new GitError("当前分支还没有提交");
      const targets = branchNames.map(n => {
        const sha = this.resolve(n);
        if (!sha) throw new GitError("无法解析：" + n);
        return { name: n, sha };
      });
      if (targets.some(t => t.sha === head))
        throw new GitError("已经包含该分支的全部提交");

      // 单目标 fast-forward
      if (targets.length === 1 && !opts.noff && this.isAncestor(head, targets[0].sha)) {
        const t = targets[0].sha;
        return this._transaction("Fast-forward 合并 " + branchNames[0], () => {
          if (this.head.detached) this.head.sha = t;
          else this.branches[this.head.ref] = t;
          this.worktree = this.treeAt(t);
          return { ff: true };
        });
      }

      const labelO = this.head.detached ? "HEAD" : this.head.ref;
      const txLabel = "merge " + branchNames.join(", ");
      return this._transaction(txLabel, () => {
        let mergedTree = this.treeAt(head);
        let parents = [head];
        let stepConflicts = [];

        for (const t of targets) {
          if (parents.includes(t.sha)) continue;
          const base = this.mergeBase(head, t.sha) ||
            (parents.length > 1 ? this._octopusBase(parents, t.sha) : null);
          const baseTree = base ? this.treeAt(base) : {};
          const theirsTree = this.treeAt(t.sha);
          const r = this._mergeTrees(baseTree, mergedTree, theirsTree, labelO, t.name);
          mergedTree = r.tree;
          parents = this._uniqueParents(parents, t.sha);
          if (r.conflicts.length) {
            stepConflicts = stepConflicts.concat(r.conflicts);
            if (targets.length > 1) {
              // 真正的 git octopus 在冲突时直接整体放弃
              throw new GitError("Octopus 合并在 " +
                r.conflicts.map(c => c.path).join(", ") + " 上冲突，Git 会拒绝自动合并，请分多次两两合并");
            }
          }
        }

        if (stepConflicts.length) {
          this.worktree = mergedTree;
          this.pending = {
            kind: "merge",
            label: txLabel,
            headName: labelO,
            targetNames: branchNames,
            parents,
            conflicts: stepConflicts.map(c => Object.assign({ resolved: false, resolution: null }, c)),
            octopus: targets.length > 1
          };
          return { conflict: true, conflicts: this.pending.conflicts };
        }

        const msg = opts.message || ("Merge branches " +
          branchNames.map(n => "'" + n + "'").join(", ") +
          (this.head.detached ? "" : " into " + this.head.ref));
        const sha = this._commitTree(parents, mergedTree, msg);
        this.worktree = mergedTree;
        return { sha, octopus: targets.length > 1 };
      });
    }

    _uniqueParents(parents, sha) {
      if (parents.some(p => this.isAncestor(sha, p))) return parents;
      return parents.filter(p => !this.isAncestor(p, sha)).concat([sha]);
    }

    _octopusBase(parents, target) {
      let b = parents[0];
      for (let i = 1; i < parents.length; i++) b = this.mergeBase(b, parents[i]);
      return this.mergeBase(b, target);
    }

    _commitTree(parents, fullTree, message) {
      const headTree = parents.length ? this.treeAt(parents[0]) : {};
      const delta = {};
      const paths = new Set([...Object.keys(headTree), ...Object.keys(fullTree)]);
      for (const p of paths) {
        const oldV = headTree[p];
        const newV = fullTree[p];
        if (oldV === newV) continue;
        if (newV === undefined) delta[p] = null;
        else delta[p] = newV;
      }
      const sha = this._newSha();
      this.commits[sha] = {
        sha, parents: parents.slice(), message, tree: delta,
        author: "you", time: this.counter
      };
      if (this.head.detached) this.head.sha = sha;
      else this.branches[this.head.ref] = sha;
      return sha;
    }
    /* ---------- rebase / rebase --onto ---------- */

    _rebaseCommits(upstreamSha, subjectSha) {
      const list = [];
      const seen = new Set();
      const stack = [subjectSha];
      while (stack.length) {
        const s = stack.pop();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        if (upstreamSha && this.isAncestor(s, upstreamSha)) continue;
        const c = this.commits[s];
        list.push(c);
        stack.push(...c.parents);
      }
      list.sort((a, b) => a.time - b.time);
      return list;
    }

    rebase(upstreamName, ontoName) {
      if (this.pending) throw new GitError("请先结束当前进行中的操作");
      if (this.worktreeStatus().some(r => r.status !== "C"))
        throw new GitError("工作区有未提交改动，请先提交或 reset --hard");
      const headSha = this.headSha();
      if (!headSha) throw new GitError("当前分支还没有提交");
      const upstream = upstreamName ? this.resolve(upstreamName) : null;
      const onto = ontoName ? this.resolve(ontoName) : upstream;

      const txLabel = "rebase" + (ontoName ? " --onto " + ontoName : " " + upstreamName);
      return this._transaction(txLabel, () => {
        const commits = this._rebaseCommits(upstream, headSha);
        this.pending = {
          kind: "rebase",
          label: txLabel,
          headName: this.head.detached ? "HEAD" : this.head.ref,
          wasDetached: this.head.detached,
          origHead: headSha,
          origRef: this.head.detached ? null : this.head.ref,
          onto,
          commits: commits.map(c => c.sha),
          idx: 0,
          currentBase: onto,
          conflicts: null,
          doneShas: []
        };
        this._moveHead(onto);
        this.worktree = onto ? this.treeAt(onto) : {};
        return this._nextRebaseStep();
      });
    }

    _nextRebaseStep() {
      const p = this.pending;
      while (p.idx < p.commits.length) {
        const orig = this.commits[p.commits[p.idx]];
        const baseTree = orig.parents.length ? this.treeAt(orig.parents[0]) : {};
        const oursTree = p.currentBase ? this.treeAt(p.currentBase) : {};
        const theirsTree = this.treeAt(orig.sha);
        const r = this._mergeTrees(baseTree, oursTree, theirsTree,
          p.headName, orig.sha.slice(0, 7));
        if (r.conflicts.length) {
          this.worktree = r.tree;
          p.conflicts = r.conflicts.map(c => Object.assign({ resolved: false, resolution: null }, c));
          this._emit();
          return { conflict: true, conflicts: p.conflicts, original: orig.sha };
        }
        // 上游已含等价改动 -> 补丁为空，跳过
        if (!this._treeEquals(r.tree, oursTree)) {
          const sha = this._commitTreeOnBase(p.currentBase ? [p.currentBase] : [], r.tree, orig.message);
          p.currentBase = sha;
          p.doneShas.push(sha);
        }
        p.idx++;
      }
      this._finishRebase();
      return { done: true };
    }

    _commitTreeOnBase(parents, fullTree, message) {
      const baseTree = parents.length ? this.treeAt(parents[0]) : {};
      const delta = {};
      for (const name of new Set([...Object.keys(baseTree), ...Object.keys(fullTree)])) {
        if (baseTree[name] === fullTree[name]) continue;
        delta[name] = fullTree[name] === undefined ? null : fullTree[name];
      }
      const sha = this._newSha();
      this.commits[sha] = {
        sha, parents: parents.slice(), message, tree: delta,
        author: "you", time: this.counter
      };
      return sha;
    }

    _treeEquals(a, b) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) if (a[k] !== b[k]) return false;
      return true;
    }

    _moveHead(sha) {
      if (this.pending && this.pending.wasDetached) this.head = { detached: true, ref: null, sha };
      else if (this.pending && this.pending.origRef) {
        this.head = { detached: false, ref: this.pending.origRef, sha: null };
        this.branches[this.pending.origRef] = sha;
      } else if (this.head.detached) this.head.sha = sha;
      else this.branches[this.head.ref] = sha;
    }

    _finishRebase() {
      const p = this.pending;
      this._moveHead(p.currentBase);
      this.worktree = p.currentBase ? this.treeAt(p.currentBase) : {};
      this.pending = null;
    }

    /* ---------- cherry-pick / revert ---------- */

    cherryPick(sha) {
      sha = this.resolve(sha);
      if (this.pending) throw new GitError("请先结束当前进行中的操作");
      const head = this.headSha();
      if (!head) throw new GitError("当前分支还没有提交");
      const orig = this.commits[sha];
      if (!orig) throw new GitError("找不到提交 " + sha);
      const txLabel = "cherry-pick " + sha.slice(0, 7);
      return this._transaction(txLabel, () => {
        this.pending = {
          kind: "cherry-pick",
          label: txLabel,
          headName: this.head.detached ? "HEAD" : this.head.ref,
          mode: "pick", origSha: sha, conflicts: null
        };
        return this._applyPick(orig, head, false);
      });
    }

    revert(sha) {
      sha = this.resolve(sha);
      if (this.pending) throw new GitError("请先结束当前进行中的操作");
      const head = this.headSha();
      if (!head) throw new GitError("当前分支还没有提交");
      const orig = this.commits[sha];
      if (!orig) throw new GitError("找不到提交 " + sha);
      const txLabel = "revert " + sha.slice(0, 7);
      return this._transaction(txLabel, () => {
        this.pending = {
          kind: "revert",
          label: txLabel,
          headName: this.head.detached ? "HEAD" : this.head.ref,
          mode: "revert", origSha: sha, conflicts: null
        };
        return this._applyPick(orig, head, true);
      });
    }

    _applyPick(orig, head, reverse) {
      const baseTree = orig.parents.length ? this.treeAt(orig.parents[0]) : {};
      const oursTree = this.treeAt(head);
      const patchTree = this.treeAt(orig.sha);
      const labelO = this.head.detached ? "HEAD" : this.head.ref;
      // cherry-pick：base=原父树，theirs=原提交树（正向补丁）
      // revert：base=原提交树，theirs=原父树（反向补丁），
      // 三方合并会自动把“反向补丁”套到当前 HEAD 上并处理冲突。
      // 关键：merge(base=X, ours=Y, theirs=Z) 在 Y===X 时结果取 Z。
      // revert 想把“orig 相对其父的补丁反向套到 HEAD”，
      // 令 X=patchTree(orig树), Y=oursTree(HEAD), Z=baseTree(orig父)：
      // 与 orig 一致的部分被回退，HEAD 独有的改动保留。
      const b = reverse ? patchTree : baseTree;
      const t2 = reverse ? baseTree : patchTree;
      const labelPatch = reverse ? "revert" : orig.sha.slice(0, 7);
      const r = this._mergeTrees(reverse ? patchTree : baseTree,
        oursTree,
        reverse ? baseTree : patchTree,
        labelO, labelPatch);
      if (r.conflicts.length) {
        this.worktree = r.tree;
        this.pending.conflicts = r.conflicts.map(c => Object.assign({ resolved: false, resolution: null }, c));
        this._emit();
        return { conflict: true, conflicts: this.pending.conflicts };
      }
      this._completePick(r.tree);
      return { done: true, sha: this.headSha() };
    }

    _completePick(fullTree) {
      const p = this.pending;
      const orig = this.commits[p.origSha];
      const parent = this.headSha();
      const message = p.mode === "pick" ? orig.message : 'Revert "' + orig.message + '"';
      const sha = this._commitTreeOnBase([parent], fullTree, message);
      this._moveHeadSimple(sha);
      this.worktree = fullTree;
      this.pending = null;
    }

    _moveHeadSimple(sha) {
      if (this.head.detached) this.head.sha = sha;
      else this.branches[this.head.ref] = sha;
    }

    /* ---------- reset ---------- */

    reset(ref, mode) {
      if (this.pending) throw new GitError("请先结束当前进行中的操作");
      const target = this.resolve(ref);
      if (!target) throw new GitError("无法解析目标：" + ref);
      return this._transaction("reset --" + mode + " 到 " + target.slice(0, 7), () => {
        const targetTree = this.treeAt(target);
        if (mode === "hard") this.worktree = Object.assign({}, targetTree);
        // soft/mixed 均保留工作区文件（soft 改动保留为“已暂存”语义，
        // mixed 保留为“未暂存”，在工作区视图中都表现为相对新 HEAD 的改动）
        if (this.head.detached) this.head.sha = target;
        else this.branches[this.head.ref] = target;
        return target;
      });
    }

    /* ---------- 冲突解决 / 中止 ---------- */

    resolveConflict(path, resolution) {
      const p = this.pending;
      if (!p || !p.conflicts) throw new GitError("当前没有等待解决的冲突");
      const c = p.conflicts.find(x => x.path === path);
      if (!c) throw new GitError("没有这个冲突文件：" + path);
      c.resolution = resolution;
      c.resolved = true;
      this._swapStep(p.label).commit();
    }

    continueOperation() {
      const p = this.pending;
      if (!p) throw new GitError("当前没有进行中的操作");
      const unresolved = p.conflicts ? p.conflicts.filter(c => !c.resolved) : [];
      if (unresolved.length) throw new GitError("还有 " + unresolved.length + " 个冲突未解决");

      const step = this._swapStep(p.label);
      if (p.kind === "merge") {
        const tree = this._resolvedTree(p);
        const sha = this._commitTree(p.parents, tree,
          "Merge branches " + p.targetNames.map(n => "'" + n + "'").join(", ") +
          (this.head.detached ? "" : " into " + p.headName));
        this.worktree = tree;
        this.pending = null;
        step.commit();
        return { done: true, sha };
      }
      if (p.kind === "cherry-pick" || p.kind === "revert") {
        const tree = this._resolvedTree(p);
        this._completePick(tree);
        step.commit();
        return { done: true, sha: this.headSha() };
      }
      if (p.kind === "rebase") {
        const tree = this._resolvedTree(p);
        const orig = this.commits[p.commits[p.idx]];
        const sha = this._commitTreeOnBase([p.currentBase], tree, orig.message);
        p.currentBase = sha;
        p.doneShas.push(sha);
        p.idx++;
        p.conflicts = null;
        const result = this._nextRebaseStep();
        step.commit();
        return result;
      }
    }

    _resolvedTree(p) {
      // 工作树已是“无冲突合并结果 + 冲突文本”，按每个裁决覆盖
      const tree = Object.assign({}, this.worktree);
      for (const c of p.conflicts) {
        const r = c.resolution;
        if (!r) continue;
        if (r.action === "remove") delete tree[c.path];
        else if (r.action === "ours") {
          if (c.ours === undefined) delete tree[c.path];
          else tree[c.path] = c.ours;
        } else if (r.action === "theirs") {
          if (c.theirs === undefined) delete tree[c.path];
          else tree[c.path] = c.theirs;
        } else if (r.action === "keep") tree[c.path] = r.content;
      }
      return tree;
    }

    skipRebaseCommit() {
      const p = this.pending;
      if (!p || p.kind !== "rebase") throw new GitError("只有 rebase 可以跳过当前提交");
      const step = this._swapStep(p.label);
      p.idx++;
      p.conflicts = null;
      const result = this._nextRebaseStep();
      step.commit();
      return result;
    }

    abortOperation() {
      const p = this.pending;
      if (!p) throw new GitError("当前没有进行中的操作");
      const step = this._swapStep(p.label);
      if (p.kind === "rebase") {
        if (p.wasDetached) this.head = { detached: true, ref: null, sha: p.origHead };
        else { this.head = { detached: false, ref: p.origRef, sha: null }; this.branches[p.origRef] = p.origHead; }
        this.worktree = this.treeAt(p.origHead);
      } else {
        this.worktree = this.treeAt(this.headSha());
      }
      this.pending = null;
      step.commit();
    }

    /* ---------- 查询 ---------- */

    allReachable() {
      const roots = [
        ...Object.values(this.branches),
        ...Object.values(this.tags),
        ...(this.head.detached ? [this.head.sha] : [])
      ].filter(Boolean);
      const seen = new Set();
      const stack = [...new Set(roots)];
      while (stack.length) {
        const s = stack.pop();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        const c = this.commits[s];
        if (c) stack.push(...c.parents);
      }
      return seen;
    }
  }

  global.Repo = Repo;
  global.GitError = GitError;
})(window);
