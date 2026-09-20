'use strict';
(function (global) {
  const GV = global.GV;
  const el = GV.el;

  const App = {
    repo: null,
    undoStack: [],
    redoStack: [],
    session: null,
    selected: null,
    currentExample: null,

    init: function () {
      this.repo = GV.EXAMPLES.diverge.build();
      this.bindGraph();
      this.bindUI();
      this.bindKeyboard();
      this.renderAll();
      this.afterRender();
      this.log('就绪。点击顶部按钮可加载三个内置示例。', 'info');
    },

    log: function (msg, kind) {
      const view = document.getElementById('log-view');
      const line = el('div', { class: 'log-' + (kind || 'ok') }, GV.nowStamp() + '  ' + msg);
      view.appendChild(line);
      view.scrollTop = view.scrollHeight;
    },

    snapshot: function () {
      return {
        repo: this.repo.snapshot(),
        selected: this.selected,
        example: this.currentExample
      };
    },

    pushUndo: function () {
      this.undoStack.push(this.snapshot());
      if (this.undoStack.length > 120) this.undoStack.shift();
      this.redoStack = [];
    },

    undo: function () {
      if (this.session) { this.log('存在未完成的冲突会话，请先 continue/skip/abort', 'err'); return; }
      const snap = this.undoStack.pop();
      if (!snap) return;
      this.redoStack.push(this.snapshot());
      this.repo.restore(snap.repo);
      this.selected = snap.selected;
      this.currentExample = snap.example;
      this.log('撤销', 'info');
      this.renderAll();
    },

    redo: function () {
      if (this.session) { this.log('存在未完成的冲突会话，请先 continue/skip/abort', 'err'); return; }
      const snap = this.redoStack.pop();
      if (!snap) return;
      this.undoStack.push(this.snapshot());
      this.repo.restore(snap.repo);
      this.selected = snap.selected;
      this.currentExample = snap.example;
      this.log('重做', 'info');
      this.renderAll();
    },

    requireClean: function () {
      const head = this.repo.headTree();
      if (!GV.filesEqual(head, this.repo.index)) {
        throw new GV.GitError('索引与 HEAD 不一致，请先提交或重置索引');
      }
      if (!GV.filesEqual(this.repo.index, this.repo.worktree)) {
        throw new GV.GitError('工作区有未暂存改动，请先提交或 stash（本演示不支持 stash）');
      }
    },

    renderAll: function () {
      GV.GraphView.selected = this.selected;
      GV.GraphView.render(this.repo);
      this.renderRefs();
      this.renderFiles();
      this.renderDetail();
      this.renderSelectors();
      this.renderBanner();
      document.getElementById('btn-undo').disabled = this.undoStack.length === 0 || Boolean(this.session);
      document.getElementById('btn-redo').disabled = this.redoStack.length === 0 || Boolean(this.session);
      const busy = Boolean(this.session);
      ['btn-commit','btn-merge','btn-rebase','btn-rebase-onto','btn-pick','btn-revert',
       'btn-branch','btn-tag','btn-checkout','btn-detach','btn-reset','btn-write','btn-rm',
       'btn-add','btn-add-all','btn-reset-index','btn-branch-del','btn-tag-del']
        .forEach(function (id) { document.getElementById(id).disabled = busy; });
    },

    afterRender: function () {
      const self = this;
      requestAnimationFrame(function () {
        GV.GraphView.fit();
        GV.GraphView.applyTransform();
      });
    },

    renderBanner: function () {
      const banner = document.getElementById('example-banner');
      if (this.currentExample && GV.EXAMPLES[this.currentExample]) {
        banner.innerHTML = GV.EXAMPLES[this.currentExample].banner;
        banner.classList.remove('hidden');
      } else {
        banner.classList.add('hidden');
      }
    },

    renderRefs: function () {
      const view = document.getElementById('refs-view');
      view.innerHTML = '';
      const detached = this.repo.detached;
      const headLine = el('div', { class: 'ref-line' });
      const headChip = el('span', {
        class: 'ref-chip ' + (detached ? 'chip-detach' : 'chip-head'),
        text: detached ? 'HEAD(detached)' : 'HEAD'
      });
      const target = detached
        ? GV.shortId(this.repo.detachedId)
        : ('→ ' + this.repo.branchName());
      headLine.appendChild(headChip);
      headLine.appendChild(el('span', { class: 'small muted', text: target }));
      view.appendChild(headLine);

      Object.keys(this.repo.branches).sort().forEach((ref) => {
        const name = ref.slice(11);
        const line = el('div', { class: 'ref-line' });
        const isCurrent = !detached && this.repo.headRef === ref;
        line.appendChild(el('span', {
          class: 'ref-chip chip-branch',
          text: isCurrent ? '● ' + name : name
        }));
        line.appendChild(el('span', { class: 'small muted', text: GV.shortId(this.repo.branches[ref]) }));
        line.style.cursor = 'pointer';
        line.addEventListener('click', () => this.selectCommit(this.repo.branches[ref]));
        view.appendChild(line);
      });

      Object.keys(this.repo.tags).sort().forEach((ref) => {
        const name = ref.slice(10);
        const line = el('div', { class: 'ref-line' });
        line.appendChild(el('span', { class: 'ref-chip chip-tag', text: 'v ' + name }));
        line.appendChild(el('span', { class: 'small muted', text: GV.shortId(this.repo.tags[ref]) }));
        line.style.cursor = 'pointer';
        line.addEventListener('click', () => this.selectCommit(this.repo.tags[ref]));
        view.appendChild(line);
      });
    },

    fileStatus: function (path) {
      const head = this.repo.headTree();
      const inH = Object.prototype.hasOwnProperty.call(head, path);
      const inI = Object.prototype.hasOwnProperty.call(this.repo.index, path);
      const inW = Object.prototype.hasOwnProperty.call(this.repo.worktree, path);
      if (inI && inW && inH) {
        if (this.repo.index[path] !== head[path] && this.repo.worktree[path] !== this.repo.index[path]) return 'AM';
        if (this.repo.index[path] !== head[path]) return 'M';
        if (this.repo.worktree[path] !== this.repo.index[path]) return ' M';
        return null;
      }
      if (inI && inW && !inH) return 'A';
      if (inI && !inW && inH) return 'MD';
      if (inI && !inW && !inH) return 'AD';
      if (!inI && inW && inH) return ' M';
      if (!inI && inW && !inH) return '??';
      if (!inI && !inW && inH) return ' D';
      if (inI && inW && inH && this.repo.index[path] === head[path]) return null;
      return null;
    },

    renderFiles: function () {
      const view = document.getElementById('files-view');
      view.innerHTML = '';
      const head = this.repo.headTree();
      const paths = {};
      Object.keys(head).forEach((p) => { paths[p] = 1; });
      Object.keys(this.repo.index).forEach((p) => { paths[p] = 1; });
      Object.keys(this.repo.worktree).forEach((p) => { paths[p] = 1; });
      const keys = Object.keys(paths).sort();
      if (!keys.length) {
        view.appendChild(el('div', { class: 'muted small', text: '（空仓库，尚无文件）' }));
        return;
      }
      keys.forEach((path) => {
        const st = this.fileStatus(path);
        const line = el('div', { class: 'file-line' });
        const mark = st === '??' ? '??' : (st || '  ');
        line.appendChild(el('span', {
          class: 'file-status st-' + (mark.trim()[0] === '?' ? 'U' : (mark.trim()[0] || 'M')),
          text: mark
        }));
        const pathNode = el('span', { class: 'file-path', text: path });
        pathNode.addEventListener('click', () => {
          document.getElementById('edit-path').value = path;
          document.getElementById('edit-content').value =
            Object.prototype.hasOwnProperty.call(this.repo.worktree, path) ? this.repo.worktree[path] : '';
        });
        line.appendChild(pathNode);
        view.appendChild(line);
      });
    },

    renderDetail: function () {
      const view = document.getElementById('detail-view');
      view.innerHTML = '';
      if (!this.selected || !this.repo.commits[this.selected]) {
        view.appendChild(el('span', { class: 'muted small', text: '点击图中的提交节点查看详情。' }));
        return;
      }
      const c = this.repo.commits[this.selected];
      const refs = this.repo.refsAt(c.id);
      const add = (k, v) => {
        view.appendChild(el('div', { class: 'detail-section' }, [
          el('span', { class: 'k small', text: k + '：' }),
          el('span', { class: 'small', text: v })
        ]));
      };
      add('SHA', c.id);
      add('父提交', c.parents.length ? c.parents.map(GV.shortId).join(', ') : '(根提交)');
      add('提交信息', c.message);
      if (refs.length) {
        add('引用', refs.map((r) => r.kind + ':' + r.name).join('  '));
      }
      const filesTitle = el('div', { class: 'k small', text: '文件树（' + Object.keys(c.tree).length + '）：' });
      view.appendChild(filesTitle);
      Object.keys(c.tree).sort().forEach((p) => {
        const sec = el('div', { class: 'detail-section' });
        sec.appendChild(el('div', { class: 'small', style: 'color:var(--accent);cursor:pointer', text: p }));
        const pre = el('pre', { class: 'file-content mono', text: c.tree[p] });
        sec.appendChild(pre);
        view.appendChild(sec);
      });
    },

    selectCommit: function (id) {
      this.selected = id;
      this.renderAll();
    },

    renderSelectors: function () {
      const fill = (id, entries, allowEmpty) => {
        const sel = document.getElementById(id);
        const prev = sel.value;
        sel.innerHTML = '';
        if (allowEmpty) sel.appendChild(el('option', { value: '', text: '— 选择提交 —' }));
        entries.forEach((e) => sel.appendChild(el('option', { value: e.value, text: e.label })));
        if (prev && entries.some((e) => e.value === prev)) sel.value = prev;
      };
      const branchEntries = Object.keys(this.repo.branches).sort().map((ref) => ({
        value: ref, label: ref.slice(11)
      }));
      const tagEntries = Object.keys(this.repo.tags).sort().map((ref) => ({
        value: ref, label: ref.slice(10)
      }));
      fill('branch-select', branchEntries);
      fill('tag-select', tagEntries);
      fill('merge-select', branchEntries);
      fill('rebase-select', branchEntries, true);
      fill('rebase-onto', branchEntries.concat(tagEntries).map((e) => e), true);
      fill('rebase-upstream', branchEntries, true);

      const head = this.repo.headId();
      const ancestors = head ? this.repo.ancestorSet([head]) : {};
      const pickEntries = Object.keys(this.repo.commits)
        .filter((id) => !ancestors[id])
        .sort((a, b) => this.repo.commits[a].time - this.repo.commits[b].time)
        .map((id) => ({ value: id, label: GV.shortId(id) + ' ' + this.repo.commits[id].message }));
      fill('pick-select', pickEntries, true);

      const revertEntries = head ? Object.keys(ancestors)
        .filter((id) => this.repo.commits[id].parents.length <= 1)
        .sort((a, b) => this.repo.commits[b].time - this.repo.commits[a].time)
        .map((id) => ({ value: id, label: GV.shortId(id) + ' ' + this.repo.commits[id].message })) : [];
      fill('revert-select', revertEntries, true);

      const resetEntries = head ? Object.keys(ancestors)
        .sort((a, b) => this.repo.commits[b].time - this.repo.commits[a].time)
        .map((id) => ({ value: id, label: GV.shortId(id) + ' ' + this.repo.commits[id].message })) : [];
      fill('reset-select', resetEntries, true);

      const detachEntries = Object.keys(this.repo.commits)
        .sort((a, b) => this.repo.commits[b].time - this.repo.commits[a].time)
        .map((id) => ({ value: id, label: GV.shortId(id) + ' ' + this.repo.commits[id].message }));
      fill('detach-select', detachEntries, true);
    }
  };

  global.App = App;
})(window);

(function (global) {
  const App = global.App;
  const el = GV.el;
  Object.assign(App, {
    doWriteFile: function () {
      const path = document.getElementById('edit-path').value.trim();
      const content = document.getElementById('edit-content').value;
      if (!path) { this.log('请输入文件路径', 'err'); return; }
      this.pushUndo();
      if (content === '' && !Object.prototype.hasOwnProperty.call(this.repo.worktree, path)) {
        this.repo.worktree[path] = '';
      } else {
        this.repo.worktree[path] = content;
      }
      this.log('写入工作区文件: ' + path);
      this.renderAll();
    },

    doRemoveFile: function () {
      const path = document.getElementById('edit-path').value.trim();
      if (!path || !Object.prototype.hasOwnProperty.call(this.repo.worktree, path)) {
        this.log('文件不存在于工作区: ' + path, 'err'); return;
      }
      this.pushUndo();
      delete this.repo.worktree[path];
      this.log('从工作区删除: ' + path);
      this.renderAll();
    },

    doAdd: function (all) {
      this.pushUndo();
      if (all) {
        this.repo.index = GV.clone(this.repo.worktree);
      } else {
        const idx = GV.clone(this.repo.worktree);
        const head = this.repo.headTree();
        Object.keys(head).forEach(function (p) {
          if (!Object.prototype.hasOwnProperty.call(idx, p)) idx[p] = head[p];
        });
        this.repo.index = idx;
      }
      this.log(all ? 'git add -A（含新文件与删除）' : 'git add（暂存已跟踪改动）');
      this.renderAll();
    },

    doResetIndex: function () {
      this.pushUndo();
      this.repo.index = this.repo.headTree();
      this.log('索引重置为 HEAD（保留工作区改动）');
      this.renderAll();
    },

    doCommit: function () {
      const msg = document.getElementById('commit-msg').value.trim();
      if (!msg) { this.log('请填写提交信息', 'err'); return; }
      if (GV.filesEqual(this.repo.index, this.repo.headTree())) {
        this.log('索引与 HEAD 完全相同，没有可提交的改动', 'err'); return;
      }
      this.pushUndo();
      const parents = this.repo.headId() ? [this.repo.headId()] : [];
      const c = this.repo.addCommit(parents, this.repo.index, msg);
      this.repo.setHeadToCommit(c.id);
      this.repo.index = GV.clone(c.tree);
      this.repo.worktree = GV.clone(c.tree);
      document.getElementById('commit-msg').value = '';
      this.selected = c.id;
      this.log('创建提交 ' + GV.shortId(c.id) + ' “' + msg + '”');
      this.renderAll();
    },

    doCreateBranch: function () {
      const name = document.getElementById('new-branch-name').value.trim();
      if (!name) { this.log('请输入分支名', 'err'); return; }
      try {
        this.pushUndo();
        this.repo.createBranch(name, this.selected || this.repo.headId());
        document.getElementById('new-branch-name').value = '';
        this.log('创建分支 ' + name);
        this.renderAll();
      } catch (e) { this.undoStack.pop(); this.log(e.message, 'err'); }
    },

    doDeleteBranch: function () {
      const ref = document.getElementById('branch-select').value;
      if (!ref) return;
      try {
        this.pushUndo();
        this.repo.deleteBranch(ref);
        this.log('删除分支 ' + ref.slice(11));
        this.renderAll();
      } catch (e) { this.undoStack.pop(); this.log(e.message, 'err'); }
    },

    doCheckout: function () {
      const ref = document.getElementById('branch-select').value;
      if (!ref) return;
      try {
        this.requireClean();
        this.pushUndo();
        this.repo.checkoutRef(ref);
        this.selected = this.repo.headId();
        this.log('checkout ' + ref.slice(11));
        this.renderAll();
      } catch (e) { this.undoStack.pop(); this.log(e.message, 'err'); }
    },

    doDetach: function () {
      const id = document.getElementById('detach-select').value;
      if (!id) return;
      try {
        this.requireClean();
        this.pushUndo();
        this.repo.detachAt(id);
        this.selected = id;
        this.log('detached HEAD 位于 ' + GV.shortId(id));
        this.renderAll();
      } catch (e) { this.undoStack.pop(); this.log(e.message, 'err'); }
    },

    doCreateTag: function () {
      const name = document.getElementById('new-tag-name').value.trim();
      if (!name) { this.log('请输入标签名', 'err'); return; }
      try {
        this.pushUndo();
        this.repo.createTag(name, this.selected || this.repo.headId());
        document.getElementById('new-tag-name').value = '';
        this.log('打标签 ' + name);
        this.renderAll();
      } catch (e) { this.undoStack.pop(); this.log(e.message, 'err'); }
    },

    doDeleteTag: function () {
      const ref = document.getElementById('tag-select').value;
      if (!ref) return;
      try {
        this.pushUndo();
        this.repo.deleteTag(ref);
        this.log('删除标签 ' + ref.slice(10));
        this.renderAll();
      } catch (e) {
        this.undoStack.pop();
        this.log(e.message, 'err');
      }
    }
  });
})(window);

(function (global) {
  const App = global.App;
  const el = GV.el;

  function labelsFor(kind) {
    if (kind === 'rebase') return { ours: '当前（rebase 基底）', base: '原提交父版本', theirs: '正在重放的提交' };
    if (kind === 'pick') return { ours: 'HEAD', base: '被挑选提交的父版本', theirs: 'cherry-pick 的提交' };
    if (kind === 'revert') return { ours: 'HEAD', base: '被回滚提交', theirs: '回滚后的内容' };
    return { ours: 'HEAD', base: 'merge base', theirs: '被合并分支' };
  }

  Object.assign(App, {
    doMerge: function (targetRef, opts) {
      opts = opts || {};
      const repo = this.repo;
      try {
        this.requireClean();
        if (!targetRef || !repo.branches[targetRef]) throw new GV.GitError('请选择要合并的分支');
        const headId = repo.headId();
        const targetId = repo.branches[targetRef];
        const targetName = targetRef.slice(11);

        if (headId === targetId) { this.log('已经是最新的（同一提交）', 'info'); return; }

        const isAncestor = repo.isAncestor(headId, targetId);
        const isDescendant = repo.isAncestor(targetId, headId);

        if (isAncestor && !opts.noFf) {
          if (opts.ffOnly === false && !opts.noFf) { /* default ff */ }
          this.pushUndo();
          repo.setHeadToCommit(targetId);
          repo.index = GV.clone(repo.commits[targetId].tree);
          repo.worktree = GV.clone(repo.index);
          this.selected = targetId;
          this.log('Fast-forward 到 ' + targetName + ' (' + GV.shortId(targetId) + ')');
          this.renderAll();
          return;
        }
        if (isDescendant) {
          this.log('已经包含 ' + targetName + ' 的全部提交', 'info');
          return;
        }
        if (opts.ffOnly) throw new GV.GitError('无法 fast-forward（--ff-only）');

        const bases = repo.mergeBasesMany([headId, targetId]);
        const baseId = bases[0] || null;
        const baseTree = baseId ? repo.commits[baseId].tree : {};
        const res = GV.mergeTrees(
          baseTree,
          repo.commits[headId].tree,
          repo.commits[targetId].tree,
          labelsFor('merge')
        );

        if (res.conflicts.length) {
          this.pushUndo();
          this.session = {
            kind: 'merge',
            tree: res.tree,
            conflicts: res.conflicts,
            parents: [headId, targetId],
            labels: labelsFor('merge'),
            message: 'Merge branch ' + "'" + targetName + "'",
            baseTree: baseTree
          };
          this.openConflictModal('合并冲突：merge ' + targetName,
            '与 ' + targetName + ' 的合并存在冲突。解决下面每个文件后继续，或选择中止。');
          this.renderAll();
          return;
        }

        this.pushUndo();
        const c = repo.addCommit([headId, targetId], res.tree, 'Merge branch ' + "'" + targetName + "'");
        repo.setHeadToCommit(c.id);
        repo.index = GV.clone(c.tree);
        repo.worktree = GV.clone(c.tree);
        this.selected = c.id;
        this.log('合并提交 ' + GV.shortId(c.id) + '（双父 merge）');
        this.renderAll();
      } catch (e) {
        this.log(e.message, 'err');
      }
    },

    doOctopus: function (targetRefs) {
      const repo = this.repo;
      try {
        this.requireClean();
        if (targetRefs.length < 2) return this.doMerge(targetRefs[0], {});
        const headId = repo.headId();
        const targetIds = targetRefs.map((r) => repo.branches[r]);
        const bases = repo.mergeBasesMany([headId].concat(targetIds));
        const baseTree = bases.length ? repo.commits[bases[0]].tree : {};
        const sideTrees = [repo.commits[headId].tree].concat(
          targetIds.map((id) => repo.commits[id].tree)
        );
        const res = GV.mergeTreesMulti(baseTree, sideTrees, labelsFor('merge'));
        const names = targetRefs.map((r) => "'" + r.slice(11) + "'").join(' ');
        if (res.conflicts.length) {
          this.pushUndo();
          this.session = {
            kind: 'merge',
            tree: res.tree,
            conflicts: res.conflicts,
            parents: [headId].concat(targetIds),
            labels: labelsFor('merge'),
            message: 'Merge branches ' + names + ' (octopus)',
            baseTree: baseTree
          };
          this.openConflictModal('Octopus 合并冲突',
            '章鱼合并要求所有分支能干净合并，当前存在冲突。通常应 abort 后改用普通 merge。');
          this.renderAll();
          return;
        }
        this.pushUndo();
        const c = repo.addCommit([headId].concat(targetIds), res.tree, 'Merge branches ' + names + ' (octopus)');
        repo.setHeadToCommit(c.id);
        repo.index = GV.clone(c.tree);
        repo.worktree = GV.clone(c.tree);
        this.selected = c.id;
        this.log('Octopus 合并提交 ' + GV.shortId(c.id) + '（' + c.parents.length + ' 个父提交）');
        this.renderAll();
      } catch (e) {
        this.log(e.message, 'err');
      }
    },

    doCherryPick: function (id) {
      const repo = this.repo;
      try {
        this.requireClean();
        if (!id || !repo.commits[id]) throw new GV.GitError('请选择要 cherry-pick 的提交');
        if (repo.commits[id].parents.length > 1) throw new GV.GitError('本演示不支持 cherry-pick 合并提交');
        this.applyThreeWay('pick', id, repo.commits[id].message, null);
      } catch (e) {
        this.log(e.message, 'err');
      }
    },

    doRevert: function (id) {
      const repo = this.repo;
      try {
        this.requireClean();
        if (!id || !repo.commits[id]) throw new GV.GitError('请选择要 revert 的提交');
        if (repo.commits[id].parents.length > 1) throw new GV.GitError('本演示不支持 revert 合并提交');
        const c = repo.commits[id];
        const parentTree = c.parents.length ? repo.commits[c.parents[0]].tree : {};
        const res = GV.mergeTrees(c.tree, repo.headTree(), parentTree, labelsFor('revert'));
        if (res.conflicts.length) {
          this.pushUndo();
          this.session = {
            kind: 'revert',
            tree: res.tree,
            conflicts: res.conflicts,
            picked: id,
            labels: labelsFor('revert'),
            message: 'Revert "' + c.message + '"'
          };
          this.openConflictModal('Revert 冲突',
            '回滚 ' + GV.shortId(id) + ' 与当前代码冲突，需要手动解决。');
          this.renderAll();
          return;
        }
        this.finishPickLike('revert', res.tree, id, 'Revert "' + c.message + '"');
      } catch (e) {
        this.log(e.message, 'err');
      }
    },

    applyThreeWay: function (kind, pickedId, message, extra) {
      const repo = this.repo;
      const c = repo.commits[pickedId];
      const parentTree = c.parents.length ? repo.commits[c.parents[0]].tree : {};
      const res = GV.mergeTrees(parentTree, repo.headTree(), c.tree, labelsFor(kind));
      if (res.conflicts.length) {
        this.pushUndo();
        this.session = Object.assign({
          kind: kind,
          tree: res.tree,
          conflicts: res.conflicts,
          picked: pickedId,
          labels: labelsFor(kind),
          message: message
        }, extra || {});
        const title = kind === 'pick' ? 'Cherry-pick 冲突' : '冲突';
        const desc = kind === 'pick'
          ? 'cherry-pick ' + GV.shortId(pickedId) + ' 时冲突。该提交可能依赖尚未挑选的前置提交。'
          : '应用提交时冲突。';
        this.openConflictModal(title, desc);
        this.renderAll();
        return;
      }
      this.finishPickLike(kind, res.tree, pickedId, message);
    },

    finishPickLike: function (kind, tree, pickedId, message) {
      const repo = this.repo;
      this.pushUndo();
      const headId = repo.headId();
      const c = repo.addCommit(headId ? [headId] : [], tree, message);
      c.cherryPickedFrom = kind === 'revert' ? null : pickedId;
      repo.setHeadToCommit(c.id);
      repo.index = GV.clone(c.tree);
      repo.worktree = GV.clone(c.tree);
      this.selected = c.id;
      const verb = kind === 'revert' ? 'Revert 提交' : 'Cherry-pick 提交';
      this.log(verb + '，生成新提交 ' + GV.shortId(c.id) + '（原 ' + GV.shortId(pickedId) + '）');
      this.renderAll();
    },

    doReset: function (targetId, mode) {
      try {
        if (!targetId) throw new GV.GitError('请选择 reset 目标');
        if (this.repo.detached) throw new GV.GitError('detached HEAD 下 reset 请使用分支操作（演示限制）');
        this.pushUndo();
        const repo = this.repo;
        repo.branches[repo.headRef] = targetId;
        if (mode === 'soft') {
          this.log('reset --soft 到 ' + GV.shortId(targetId) + '（索引/工作区保留）');
        } else if (mode === 'hard') {
          repo.index = GV.clone(repo.commits[targetId].tree);
          repo.worktree = GV.clone(repo.index);
          this.log('reset --hard 到 ' + GV.shortId(targetId) + '（索引/工作区全部重置）');
        } else {
          repo.index = GV.clone(repo.commits[targetId].tree);
          this.log('reset --mixed 到 ' + GV.shortId(targetId) + '（索引重置，工作区保留）');
        }
        this.selected = targetId;
        this.renderAll();
      } catch (e) {
        this.undoStack.pop();
        this.log(e.message, 'err');
      }
    }
  });
})(window);

(function (global) {
  const App = global.App;
  const el = GV.el;

  Object.assign(App, {
    doRebase: function (upstreamRef, ontoRef) {
      const repo = this.repo;
      try {
        this.requireClean();
        if (!upstreamRef || !repo.branches[upstreamRef]) throw new GV.GitError('请选择 rebase 的 upstream 分支');
        const upstreamId = repo.branches[upstreamRef];
        const ontoId = ontoRef && repo.branches[ontoRef] ? repo.branches[ontoRef] : upstreamId;
        const origHead = repo.headId();
        if (repo.isAncestor(origHead, upstreamId) && ontoId === upstreamId) {
          this.log('当前分支已是 upstream 的祖先，无需 rebase', 'info');
          return;
        }
        const list = repo.rebaseList(ontoId, origHead).filter(function (id) {
          const c = repo.commits[id];
          return c.parents.length <= 1;
        });
        const upstreamReachable = repo.ancestorSet(repo.allRefs().filter(function (r) {
          return r.kind === 'branch';
        }).map(function (r) { return r.id; }));
        const todos = list.filter((id) => !repo.hasPatch([ontoId].concat(Object.keys(repo.ancestorSet([ontoId]))), repo.patchId(id)));
        const skippedMerge = list.length - todos.length;

        this.pushUndo();
        const origBranch = repo.detached ? null : repo.headRef;
        repo.detached = true;
        repo.detachedId = ontoId;
        repo.index = GV.clone(repo.commits[ontoId].tree);
        repo.worktree = GV.clone(repo.index);

        this.session = {
          kind: 'rebase',
          todos: todos,
          index: 0,
          onto: ontoId,
          origHead: origHead,
          origBranch: origBranch,
          wasDetached: Boolean(origBranch) === false,
          baseTree: GV.clone(repo.commits[ontoId].tree),
          currentTree: GV.clone(repo.commits[ontoId].tree),
          labels: { ours: '基底（upstream）', base: '被重放提交的父版本', theirs: '正在重放的提交' }
        };
        if (skippedMerge) this.log('注意：rebase 默认忽略合并提交（' + skippedMerge + ' 个）', 'info');
        this.log('开始 rebase ' + upstreamRef.slice(11) +
          (ontoRef && ontoRef !== upstreamRef ? ' --onto ' + ontoRef.slice(11) : '') +
          '，共 ' + todos.length + ' 个提交待重放', 'info');
        this.pumpRebase();
      } catch (e) {
        this.log(e.message, 'err');
      }
    },

    pumpRebase: function () {
      const repo = this.repo;
      const s = this.session;
      while (s.index < s.todos.length) {
        const pickedId = s.todos[s.index];
        const c = repo.commits[pickedId];
        const parentTree = c.parents.length ? repo.commits[c.parents[0]].tree : {};
        const res = GV.mergeTrees(parentTree, s.currentTree, c.tree, s.labels);
        if (res.conflicts.length) {
          s.tree = res.tree;
          s.conflicts = res.conflicts;
          s.picked = pickedId;
          this.openConflictModal('Rebase 冲突（' + (s.index + 1) + '/' + s.todos.length + '）',
            '重放提交 ' + GV.shortId(pickedId) + ' “' + c.message + '” 时发生冲突。');
          this.renderAll();
          return;
        }
        if (GV.filesEqual(res.tree, s.currentTree)) {
          this.log('跳过空提交 ' + GV.shortId(pickedId) + '（改动已存在）', 'info');
          s.index++;
          continue;
        }
        const nc = repo.addCommit(repo.detachedId ? [repo.detachedId] : [], res.tree, c.message);
        nc.cherryPickedFrom = pickedId;
        repo.detachedId = nc.id;
        s.currentTree = GV.clone(nc.tree);
        s.index++;
      }
      this.finishRebase();
    },

    finishRebase: function () {
      const repo = this.repo;
      const s = this.session;
      const tip = repo.detachedId || s.onto;
      if (s.origBranch) {
        repo.branches[s.origBranch] = tip;
        repo.headRef = s.origBranch;
        repo.detached = false;
        repo.detachedId = null;
      }
      repo.index = GV.clone(repo.commits[tip].tree);
      repo.worktree = GV.clone(repo.index);
      this.selected = tip;
      this.session = null;
      this.closeConflictModal();
      this.log('rebase 完成，分支已指向新提交 ' + GV.shortId(tip), 'info');
      this.renderAll();
    },

    conflictAbort: function () {
      const s = this.session;
      if (!s) return;
      this.session = null;
      this.closeConflictModal();
      this.undo();
      this.log('操作已中止，仓库状态恢复到操作之前（通过撤销）', 'info');
    },

    conflictSkip: function () {
      const s = this.session;
      if (!s) return;
      if (s.kind === 'rebase') {
        s.index++;
        repoIndexFromTree.call(this, s.currentTree);
        this.log('跳过提交 ' + GV.shortId(s.picked), 'info');
        this.pumpRebase();
      } else {
        this.log('skip 仅在 rebase 中可用；本次将中止操作', 'info');
        this.conflictAbort();
      }
    },

    conflictContinue: function () {
      const s = this.session;
      if (!s) return;
      const edits = this.collectConflictEdits();
      if (edits.error) { this.log(edits.error, 'err'); return; }
      const repo = this.repo;

      if (s.kind === 'merge') {
        const c = repo.addCommit(s.parents, edits.tree, s.message);
        repo.setHeadToCommit(c.id);
        repo.index = GV.clone(c.tree);
        repo.worktree = GV.clone(c.tree);
        this.session = null;
        this.closeConflictModal();
        this.selected = c.id;
        this.log('冲突已解决，创建合并提交 ' + GV.shortId(c.id) + '（' + c.parents.length + ' 父）');
        this.renderAll();
        return;
      }

      if (s.kind === 'pick' || s.kind === 'revert') {
        const headId = repo.headId();
        const c = repo.addCommit(headId ? [headId] : [], edits.tree, s.message);
        c.cherryPickedFrom = s.kind === 'pick' ? s.picked : null;
        repo.setHeadToCommit(c.id);
        repo.index = GV.clone(c.tree);
        repo.worktree = GV.clone(c.tree);
        this.session = null;
        this.closeConflictModal();
        this.selected = c.id;
        this.log('冲突已解决，' + (s.kind === 'pick' ? 'cherry-pick' : 'revert') + ' 完成：' + GV.shortId(c.id));
        this.renderAll();
        return;
      }

      if (s.kind === 'rebase') {
        const pickedId = s.picked;
        const origMsg = repo.commits[pickedId].message;
        const nc = repo.addCommit(repo.detachedId ? [repo.detachedId] : [], edits.tree, origMsg);
        nc.cherryPickedFrom = pickedId;
        repo.detachedId = nc.id;
        s.currentTree = GV.clone(nc.tree);
        s.index++;
        this.closeConflictModal();
        this.log('冲突已解决，重放提交生成 ' + GV.shortId(nc.id));
        this.pumpRebase();
      }
    },

    collectConflictEdits: function () {
      const s = this.session;
      const tree = GV.clone(s.tree);
      let error = null;
      s.conflicts.forEach(function (cf) {
        const ta = document.querySelector('textarea[data-conflict-path="' + cssEscape(cf.path) + '"]');
        if (!ta) return;
        const val = ta.value;
        if (/^(<{7}|>{7}|={7}\s*$|\|{7})/m.test(val)) {
          error = '文件 ' + cf.path + ' 中仍包含冲突标记，请先清理';
        }
        if (val === '__DELETE__') {
          delete tree[cf.path];
        } else {
          tree[cf.path] = val;
        }
      });
      return { tree: tree, error: error };
    },

    openConflictModal: function (title, desc) {
      const modal = document.getElementById('conflict-modal');
      if (!modal) return;
      document.getElementById('conflict-title').textContent = title;
      document.getElementById('conflict-desc').textContent = desc;
      const container = document.getElementById('conflict-files');
      container.innerHTML = '';
      const s = this.session;
      s.conflicts.forEach((cf, idx) => container.appendChild(this.buildConflictFile(cf, idx)));
      document.getElementById('conflict-skip').style.display = s.kind === 'rebase' ? '' : 'none';
      modal.classList.remove('hidden');
    },

    buildConflictFile: function (cf, idx) {
      const s = this.session;
      const box = el('div', { class: 'conflict-file' });
      const title = el('h3', {}, [
        el('span', { text: cf.path }),
        el('span', {
          class: 'conflict-type',
          text: cf.type === 'modify-delete'
            ? (cf.side === 'theirs' ? '修改/删除：对方删除，我方修改' : '修改/删除：我方删除，对方修改')
            : '内容冲突（diff3）'
        })
      ]);
      box.appendChild(title);

      const tabs = el('div', { class: 'conflict-tabs' });
      const editor = el('textarea', { class: 'conflict-editor mono', 'data-conflict-path': cf.path });
      const views = {};
      if (cf.type === 'content') {
        views.merged = cf.merged;
        views.ours = cf.ours;
        views.base = cf.base == null ? '' : cf.base;
        views.theirs = cf.theirs;
      } else {
        views.merged = cf.merged;
        views.ours = cf.ours == null ? '（该文件在此侧被删除）' : cf.ours;
        views.base = cf.base == null ? '' : cf.base;
        views.theirs = cf.theirs == null ? '（该文件在此侧被删除）' : cf.theirs;
      }
      const tabDefs = [
        ['merged', '合并结果（编辑我）'],
        ['ours', s.labels.ours],
        ['base', s.labels.base],
        ['theirs', s.labels.theirs]
      ];
      tabDefs.forEach((d, i) => {
        const btn = el('button', { class: i === 0 ? 'active' : '', text: d[1] });
        btn.addEventListener('click', () => {
          views[currentTab[cf.path]] = editor.value;
          currentTab[cf.path] = d[0];
          editor.value = views[d[0]];
          Array.prototype.forEach.call(tabs.children, (b) => b.classList.remove('active'));
          btn.classList.add('active');
        });
        tabs.appendChild(btn);
      });
      const currentTab = {};
      currentTab[cf.path] = 'merged';
      editor.value = views.merged;
      box.appendChild(tabs);
      box.appendChild(editor);
      if (cf.type === 'modify-delete') {
        const del = el('button', { class: 'btn danger', text: '解决：删除该文件', style: 'margin:6px 10px' });
        del.addEventListener('click', () => { editor.value = '__DELETE__'; this.log(cf.path + ' 标记为删除'); });
        box.appendChild(del);
      }
      return box;
    },

    closeConflictModal: function () {
      const m = document.getElementById('conflict-modal');
      if (m) m.classList.add('hidden');
    }
  });

  function repoIndexFromTree(tree) {
    this.repo.index = GV.clone(tree);
    this.repo.worktree = GV.clone(tree);
  }

  function cssEscape(s) { return String(s).split(String.fromCharCode(92)).join(String.fromCharCode(92,92)).split(String.fromCharCode(34)).join(String.fromCharCode(92,34)); }
})(window);

(function (global) {
  const App = global.App;
  const el = GV.el;

  Object.assign(App, {
    loadExample: function (name) {
      this.session = null;
      this.closeConflictModal();
      this.repo = GV.EXAMPLES[name].build();
      this.currentExample = name;
      this.undoStack = [];
      this.redoStack = [];
      this.selected = this.repo.headId();
      this.log('加载示例：' + GV.EXAMPLES[name].title, 'info');
      this.renderAll();
      this.afterRender();
    },

    runExampleAction: function () {
      if (!this.currentExample) { this.log('请先加载一个示例', 'err'); return; }
      GV.EXAMPLES[this.currentExample].action(this);
    },

    bindGraph: function () {
      const self = this;
      GV.GraphView.onSelect = function (id) { self.selectCommit(id); };
      const svg = document.getElementById('graph');

      let panning = false;
      let startX = 0;
      let startY = 0;
      let origTx = 0;
      let origTy = 0;
      let moved = false;

      svg.addEventListener('mousedown', function (ev) {
        if (ev.target.tagName === 'circle' || ev.target.closest('.commit-node')) return;
        panning = true;
        moved = false;
        startX = ev.clientX;
        startY = ev.clientY;
        origTx = GV.GraphView.tx;
        origTy = GV.GraphView.ty;
        svg.classList.add('panning');
      });
      window.addEventListener('mousemove', function (ev) {
        if (!panning) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        GV.GraphView.tx = origTx + dx;
        GV.GraphView.ty = origTy + dy;
        GV.GraphView.applyTransform();
      });
      window.addEventListener('mouseup', function () {
        panning = false;
        svg.classList.remove('panning');
      });
      svg.addEventListener('click', function (ev) {
        if (moved) { moved = false; return; }
        if (ev.target === svg || ev.target.id === 'viewport' || ev.target.id === 'edge-layer') {
          self.selected = null;
          self.renderAll();
        }
      });

      svg.addEventListener('wheel', function (ev) {
        ev.preventDefault();
        const rect = svg.getBoundingClientRect();
        const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
        GV.GraphView.zoomAt(factor, ev.clientX - rect.left, ev.clientY - rect.top);
        GV.GraphView.applyTransform();
      }, { passive: false });

      document.getElementById('zoom-in').addEventListener('click', function () {
        const wrap = document.getElementById('canvas-wrap');
        GV.GraphView.zoomAt(1.2, wrap.clientWidth / 2, wrap.clientHeight / 2);
        GV.GraphView.applyTransform();
      });
      document.getElementById('zoom-out').addEventListener('click', function () {
        const wrap = document.getElementById('canvas-wrap');
        GV.GraphView.zoomAt(1 / 1.2, wrap.clientWidth / 2, wrap.clientHeight / 2);
        GV.GraphView.applyTransform();
      });
      document.getElementById('zoom-fit').addEventListener('click', function () {
        GV.GraphView.fit();
        GV.GraphView.applyTransform();
      });
      document.getElementById('zoom-reset').addEventListener('click', function () {
        GV.GraphView.resetView();
        GV.GraphView.applyTransform();
      });
      document.getElementById('toggle-dangling').addEventListener('change', function () {
        self.renderAll();
      });
    },

    bindUI: function () {
      const self = this;
      const on = function (id, fn) { document.getElementById(id).addEventListener('click', fn); };

      on('btn-undo', function () { self.undo(); });
      on('btn-redo', function () { self.redo(); });
      on('btn-write', function () { self.doWriteFile(); });
      on('btn-rm', function () { self.doRemoveFile(); });
      on('btn-add', function () { self.doAdd(false); });
      on('btn-add-all', function () { self.doAdd(true); });
      on('btn-reset-index', function () { self.doResetIndex(); });
      on('btn-commit', function () { self.doCommit(); });
      on('btn-branch', function () { self.doCreateBranch(); });
      on('btn-branch-del', function () { self.doDeleteBranch(); });
      on('btn-checkout', function () { self.doCheckout(); });
      on('btn-detach', function () { self.doDetach(); });
      on('btn-tag', function () { self.doCreateTag(); });
      on('btn-tag-del', function () { self.doDeleteTag(); });

      on('btn-merge', function () {
        const ref = document.getElementById('merge-select').value;
        self.doMerge(ref, {
          ffOnly: document.getElementById('merge-ff-only').checked,
          noFf: document.getElementById('merge-no-ff').checked
        });
      });
      on('btn-rebase', function () {
        const ref = document.getElementById('rebase-select').value;
        if (ref) self.doRebase(ref, null);
        else self.log('请选择 upstream 分支', 'err');
      });
      on('btn-rebase-onto', function () {
        const onto = document.getElementById('rebase-onto').value;
        const up = document.getElementById('rebase-upstream').value;
        if (onto && up) self.doRebase(up, onto);
        else self.log('请同时选择 onto 与 upstream', 'err');
      });
      on('btn-pick', function () {
        const id = document.getElementById('pick-select').value;
        self.doCherryPick(id);
      });
      on('btn-revert', function () {
        const id = document.getElementById('revert-select').value;
        self.doRevert(id);
      });
      on('btn-reset', function () {
        const id = document.getElementById('reset-select').value;
        const mode = document.getElementById('reset-mode').value;
        self.doReset(id, mode);
      });

      on('conflict-continue', function () { self.conflictContinue(); });
      on('conflict-skip', function () { self.conflictSkip(); });
      on('conflict-abort', function () { self.conflictAbort(); });

      document.querySelectorAll('[data-example]').forEach(function (btn) {
        btn.addEventListener('click', function () { self.loadExample(btn.getAttribute('data-example')); });
      });
      on('run-example', function () { self.runExampleAction(); });
    },

    bindKeyboard: function () {
      const self = this;
      window.addEventListener('keydown', function (ev) {
        const tag = ev.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
          ev.preventDefault(); self.undo();
        } else if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === 'y' ||
          (ev.shiftKey && ev.key.toLowerCase() === 'z'))) {
          ev.preventDefault(); self.redo();
        }
      });
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { App.init(); });
  } else {
    App.init();
  }
})(window);
