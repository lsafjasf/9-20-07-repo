/* main.js — 装配：侧栏渲染、操作按钮、示例加载 */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);

  let repo = new Repo();
  let view = new GraphView(repo, $("#graph"));
  let ui = new UI(repo, view);
  let hintText = "";
  let activeFile = null;

  /* ---------------- 渲染 ---------------- */

  function render() {
    view.render();
    renderRefs();
    renderWorkFiles();
    renderDetail();
    renderStatus();
    updateButtons();
  }

  function renderStatus() {
    const p = repo.pending;
    if (p && p.conflicts && p.conflicts.length) {
      $("#status-text").textContent = "⚠ 操作进行中：" + p.label + " — 有 " +
        p.conflicts.length + " 个冲突待解决";
      $("#status-text").className = "warn";
      return;
    }
    if (p) {
      $("#status-text").textContent = "操作进行中：" + p.label;
      $("#status-text").className = "warn";
      return;
    }
    if (hintText) {
      $("#status-text").textContent = hintText;
      $("#status-text").className = "";
    }
    $("#status-help").textContent = "撤销: " + repo.history.length + " / 重做: " + repo.future.length;
  }

  function updateButtons() {
    const busy = !!(repo.pending);
    document.querySelectorAll("[data-act]").forEach(b => {
      const act = b.dataset.act;
      const blocked = busy && !["undo", "redo", "help"].includes(act);
      b.disabled = blocked;
    });
  }

  function renderRefs() {
    const box = $("#ref-list");
    const rows = [];
    if (repo.head.detached) {
      rows.push(refRow("●", "#e3b341", "HEAD (detached)", repo.head.sha, "HEAD"));
    }
    const cur = repo.head.detached ? null : repo.head.ref;
    Object.keys(repo.branches).sort().forEach((name, i) => {
      rows.push(refRow("⑂", GRAPH_PALETTE[i % GRAPH_PALETTE.length],
        name + (name === cur ? " *" : ""), repo.branches[name], "branch:" + name,
        name === cur));
    });
    Object.keys(repo.tags).sort().forEach(name => {
      rows.push(refRow("🏷", "#d29922", name, repo.tags[name], "tag:" + name, false, true));
    });
    box.innerHTML = rows.length ? rows.join("") : '<p class="muted small">尚无引用</p>';
    box.querySelectorAll("[data-ref]").forEach(el => {
      el.onclick = () => {
        const ref = el.dataset.ref;
        if (ref === "HEAD") view.select(repo.head.sha);
        else if (ref.startsWith("branch:")) view.select(repo.branches[ref.slice(7)]);
        else view.select(repo.tags[ref.slice(4)]);
      };
    });
  }

  function refRow(icon, color, name, sha, key, current, isTag) {
    return '<div class="ref-item' + (current ? " sel" : "") + '" data-ref="' + key + '">' +
      '<span class="ref-dot" style="background:' + color + '"></span>' +
      '<span class="ref-name">' + escapeHtml(name) + "</span>" +
      (isTag ? '<span class="ref-kind">tag</span>' : "") +
      '<span class="ref-sha">' + (sha || "").slice(0, 7) + "</span></div>";
  }

  function renderWorkFiles() {
    const box = $("#work-files");
    const status = repo.worktreeStatus();
    box.innerHTML = status.length
      ? status.map(r =>
          '<div class="file-row' + (r.path === activeFile ? " sel" : "") + '" data-path="' + escapeHtml(r.path) + '">' +
          '<span class="file-status f-' + r.status + '">' + r.status + "</span>" +
          "<span>" + escapeHtml(r.path) + "</span></div>").join("")
      : '<p class="muted small">工作区干净</p>';
    box.querySelectorAll(".file-row").forEach(el => {
      el.onclick = () => { activeFile = el.dataset.path; loadEditor(); renderWorkFiles(); };
    });
  }

  function loadEditor() {
    if (!activeFile) return;
    $("#editor-fname").textContent = activeFile;
    $("#editor").value = Object.prototype.hasOwnProperty.call(repo.worktree, activeFile)
      ? repo.worktree[activeFile]
      : "";
  }

  function renderDetail() {
    const box = $("#detail");
    const sha = view.selectedSha;
    const c = sha && repo.commits[sha];
    if (!c) {
      box.innerHTML = '<p class="muted">点击图中的提交节点查看详情。<br>选中的提交可用于 cherry-pick / revert / reset。</p>';
      renderLegend();
      return;
    }
    const parentTree = c.parents.length ? repo.treeAt(c.parents[0]) : {};
    const full = repo.treeAt(sha);
    const changed = Object.keys(c.tree).sort();
    box.innerHTML =
      '<div class="dline"><b>提交</b> <span class="dsha">' + c.sha + "</span></div>" +
      '<div class="dline"><b>说明</b> ' + escapeHtml(c.message) + "</div>" +
      '<div class="dline"><b>父提交</b> ' +
        (c.parents.length
          ? c.parents.map(p => '<span class="dsha pickable" data-sha="' + p + '">' + p + "</span>").join(" , ")
          : "（根提交）") + "</div>" +
      (c.parents.length > 1 ? '<div class="dline muted small">octopus/merge 提交，共 ' + c.parents.length + " 个父提交</div>" : "") +
      '<div class="dfiles"><div class="muted small" style="margin-bottom:4px">改动文件（' + changed.length + '）</div>' +
      changed.map(p => {
        const st = c.tree[p] === null ? "D" : (parentTree[p] === undefined ? "A" : "M");
        return '<div class="dfile-row" data-path="' + escapeHtml(p) + '">' +
          '<span class="file-status f-' + st + '">' + st + "</span><span>" + escapeHtml(p) +
          "</span></div>";
      }).join("") +
      '<div id="blob-view"></div></div>';
    box.querySelectorAll(".pickable").forEach(el => {
      el.style.cursor = "pointer";
      el.onclick = () => view.select(el.dataset.sha);
    });
    box.querySelectorAll(".dfile-row").forEach(el => {
      el.onclick = () => {
        const p = el.dataset.path;
        const bv = $("#blob-view");
        if (c.tree[p] === null) {
          bv.innerHTML = '<pre class="blob">（文件在该提交中被删除）</pre>';
        } else {
          bv.innerHTML = '<pre class="blob">' + escapeHtml(full[p]) + "</pre>";
        }
      };
    });
    renderLegend();
  }

  function renderLegend() {
    const tips = [];
    Object.keys(repo.branches).sort().forEach((n, i) =>
      tips.push('<span style="color:' + GRAPH_PALETTE[i % GRAPH_PALETTE.length] + '">●</span> ' + escapeHtml(n)));
    $("#legend").innerHTML = tips.join("　") +
      '<div style="margin-top:6px">○ merge 提交　虚线=游离提交　黄点=HEAD/标签</div>';
  }

  /* ---------------- 操作 ---------------- */

  function chooseBranches(title, intro, multi, onOk) {
    const cur = repo.head.detached ? null : repo.head.ref;
    const items = Object.keys(repo.branches).sort()
      .filter(n => n !== cur)
      .map(n => ({
        id: n,
        label: "⑂ " + n,
        desc: repo.branches[n].slice(0, 7) +
          (repo.isAncestor(repo.headSha(), repo.branches[n]) ? "（包含当前 HEAD，可 fast-forward）" :
           repo.isAncestor(repo.branches[n], repo.headSha()) ? "（已合入当前分支）" : "（已分叉）")
      }));
    if (multi) ui.chooseFrom(title, items, onOk, { intro, okText: "合并", multi: true });
    else ui.chooseFrom(title, items, onOk, { intro });
  }

  function doMerge(targets) {
    const r = repo.merge(targets, {});
    afterMutation(r, "合并完成");
  }

  function doRebase(upstream, onto) {
    const r = repo.rebase(upstream, onto);
    afterMutation(r, "变基完成");
  }

  function afterMutation(r, okMsg) {
    if (r && r.conflict) {
      hintText = "";
      render();
      ui.status("检测到冲突，请在弹窗中解决", "warn");
      // 延迟到 DOM 重建之后再弹出，避免被同一帧的重绘覆盖
      setTimeout(() => ui.openConflict(), 0);
      return;
    }
    if (r && r.done) {
      ui.close();
      const sha = repo.headSha();
      if (sha) view.selectedSha = sha;
      render();
      ui.status(okMsg + " ✓", "ok");
      return;
    }
    if (r && (r.sha || r.ff)) {
      ui.close();
      const sha = r.ff ? repo.headSha() : r.sha;
      if (sha) view.selectedSha = sha;
      render();
      ui.status(okMsg + " ✓", "ok");
      return;
    }
    ui.close();
    render();
    ui.status(okMsg + " ✓", "ok");
  }

  function requireSelectedCommit() {
    const sha = view.selectedSha;
    if (!sha || !repo.commits[sha]) {
      ui.status("请先在图中点击选中一个提交", "err");
      return null;
    }
    return sha;
  }
  /* ---------------- 按钮事件 ---------------- */

  document.getElementById("topbar").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    dispatch(act);
  });

  function dispatch(act) {
    // 冲突进行中：直接打开冲突窗
    if (repo.pending && repo.pending.conflicts && repo.pending.conflicts.length &&
        ["merge", "rebase", "cherry-pick", "revert"].includes(repo.pending.kind)) {
      if (!["undo", "redo", "help"].includes(act)) { ui.openConflict(); return; }
    }

    switch (act) {
      case "commit":
        ui.prompt("新建提交", "提交信息", "", (v) => {
          if (!v.trim()) { ui.status("提交信息不能为空", "err"); return true; }
          ui.guard(() => repo.commit(v.trim()), "已提交 ✓");
        });
        break;
      case "branch":
        ui.prompt("创建分支", "分支名（基于当前 HEAD）", "feature/x", (v) => {
          if (!v.trim()) return true;
          ui.guard(() => repo.createBranch(v.trim()), "分支已创建 ✓");
        });
        break;
      case "tag":
        ui.prompt("打标签", "标签名（打在当前 HEAD）", "v1.0", (v) => {
          if (!v.trim()) return true;
          ui.guard(() => repo.createTag(v.trim()), "标签已创建 ✓");
        });
        break;
      case "checkout-branch":
        chooseBranches("切换分支", "工作区有改动时无法切换，请先提交或 reset --hard。", false,
          name => ui.guard(() => { repo.checkoutBranch(name); view.selectedSha = repo.headSha(); }, "已切换到 " + name));
        break;
      case "detach":
        ui.guard(() => { repo.checkoutCommit(repo.headSha()); view.selectedSha = repo.headSha(); },
          "HEAD 已分离");
        break;
      case "merge": {
        // 多选实现：用复选列表
        chooseBranchesMulti();
        break;
      }
      case "rebase":
        chooseBranches("rebase 当前分支到…", "当前分支独有提交将被重放到所选分支顶端，提交会获得全新 SHA。", false,
          name => { try { doRebase(name); } catch (e) { ui.status(e.message, "err"); } });
        break;
      case "rebase-onto":
        chooseRebaseOnto();
        break;
      case "cherry-pick": {
        const sha = requireSelectedCommit();
        if (sha) ui.guard(() => {
          const r = repo.cherryPick(sha);
          afterMutation(r, "cherry-pick 完成");
        });
        break;
      }
      case "revert": {
        const sha = requireSelectedCommit();
        if (sha) ui.guard(() => {
          const r = repo.revert(sha);
          afterMutation(r, "revert 完成");
        });
        break;
      }
      case "reset-soft":
      case "reset-mixed":
      case "reset-hard": {
        const mode = act.split("-")[1];
        const cur = view.selectedSha || repo.headSha();
        const items = uniqueResetTargets().map(s => ({
          id: s, label: s + "  " + repo.commits[s].message,
          desc: "时间序 " + repo.commits[s].time
        }));
        ui.chooseFrom("reset --" + mode + " 到哪个提交？",
          items,
          target => ui.guard(() => { repo.reset(target, mode); view.selectedSha = target; },
            "已 reset --" + mode),
          { preselect: cur, okText: "reset --" + mode });
        break;
      }
      case "undo":
        ui.guard(() => {
          const label = repo.undo();
          if (repo.pending && repo.pending.conflicts) ui.openConflict(); else ui.close();
          ui.status("已撤销：" + label, "ok");
        });
        break;
      case "redo":
        ui.guard(() => {
          const label = repo.redo();
          if (repo.pending && repo.pending.conflicts) ui.openConflict(); else ui.close();
          ui.status("已重做：" + label, "ok");
        });
        break;
      case "help":
        ui.openHelp();
        break;
    }
  }

  function uniqueResetTargets() {
    // 当前 HEAD 第一父链 + 所选提交链
    const out = [];
    const seen = new Set();
    const walk = (sha) => {
      let cur = sha;
      while (cur && !seen.has(cur)) {
        seen.add(cur); out.push(cur);
        cur = repo.commits[cur].parents[0];
      }
    };
    walk(repo.headSha());
    if (view.selectedSha) walk(view.selectedSha);
    out.sort((a, b) => repo.commits[b].time - repo.commits[a].time);
    return out;
  }

  function chooseBranchesMulti() {
    const cur = repo.head.detached ? null : repo.head.ref;
    const names = Object.keys(repo.branches).sort().filter(n => n !== cur);
    const intro = "勾选一个分支＝普通 merge；勾选两个及以上＝octopus merge。冲突时 octopus 会被 Git 拒绝。";
    const rows = names.map((n, i) =>
      '<label class="choice"><input type="checkbox" class="radio cb-branch" data-name="' +
      escapeHtml(n) + '"' + (i === 0 ? " checked" : "") + "><div>" +
      '<div class="c-name">⑂ ' + escapeHtml(n) + "</div>" +
      '<div class="c-desc">' + repo.branches[n].slice(0, 7) +
      (repo.isAncestor(repo.headSha(), repo.branches[n]) ? "（可 fast-forward）" : "") +
      "</div></div></label>").join("");
    ui.open("合并分支到 " + (cur || "HEAD(detached)"),
      '<p class="muted">' + intro + '</p><div id="dlg-list" class="choice-list">' + rows + "</div>",
      [
        { text: "取消", left: true },
        {
          text: "merge", primary: true,
          onClick: () => {
            const picked = [...document.querySelectorAll(".cb-branch:checked")].map(x => x.dataset.name);
            if (!picked.length) { ui.status("至少选择一个分支", "err"); return true; }
            try { doMerge(picked); } catch (e) { ui.status(e.message, "err"); }
          }
        }
      ]);
  }

  function chooseRebaseOnto() {
    const cur = repo.head.detached ? null : repo.head.ref;
    const names = Object.keys(repo.branches).sort();
    const rows = names.map((n, i) =>
      '<div class="form-row"><label>' + (i === 0 ? "① 新基 onto（移植到哪里）" : "② 旧上游 upstream（从哪里切出来的）") + "</label>" +
      '<select id="onto-' + i + '" style="width:100%">' +
      names.map(x => '<option value="' + escapeHtml(x) + '"' +
        (x === n ? " selected" : "") + ">⑂ " + escapeHtml(x) + " @ " +
        repo.branches[x].slice(0, 7) + "</option>").join("") +
      '<option value="__ROOT__">（根提交之前 / 空）</option></select></div>').join("");
    ui.open("rebase --onto",
      '<p class="muted">效果：把「当前分支中不在 upstream 上的提交」嫁接到 onto 顶端。<br>' +
      "例如 stale-work 从 old 切出、在其上开发，想把新特性搬到 main：onto=main, upstream=old。</p>" + rows,
      [
        { text: "取消", left: true },
        {
          text: "执行 rebase --onto", primary: true,
          onClick: () => {
            const onto = $("#onto-0").value;
            const upstream = $("#onto-1").value;
            ui.guard(() => doRebase(upstream === "__ROOT__" ? null : upstream,
              onto === "__ROOT__" ? null : onto));
          }
        }
      ]);
  }

  /* ---------------- 示例 ---------------- */

  function loadExample(name) {
    hintText = "";
    if (!name) return;
    const built = Examples[name]();
    repo = built.repo;
    view.repo = repo;
    ui.repo = repo;
    view.selectedSha = built.preselect || repo.headSha();
    hintText = built.hint || "";
    repo.onChange(() => { hintText = ""; render(); });
    render();
    setTimeout(() => view.fit(), 30);
    ui.status("已载入示例：" + Examples.names[name], "ok");
  }

  /* ---------------- 编辑器 / 画布控件 ---------------- */

  $("#file-save").onclick = () => {
    if (!activeFile) { ui.status("请先在左侧选择一个文件", "err"); return; }
    ui.guard(() => repo.saveWorkFile(activeFile, $("#editor").value), "已保存到工作区");
  };
  $("#file-add").onclick = () => {
    ui.prompt("新建文件", "文件路径（如 src/util.js）", "newfile.txt", (v) => {
      if (!v.trim()) return true;
      try {
        repo.saveWorkFile(v.trim(), "");
        activeFile = v.trim();
        loadEditor();
        renderWorkFiles();
      } catch (e) { ui.status(e.message, "err"); }
      return true;
    });
  };
  $("#file-del").onclick = () => {
    if (!activeFile) { ui.status("请先选择文件", "err"); return; }
    const p = activeFile;
    ui.guard(() => { repo.deleteWorkFile(p); activeFile = null; $("#editor").value = ""; $("#editor-fname").textContent = "选择文件"; });
  };

  $("#zoom-in").onclick = () => view.zoomIn();
  $("#zoom-out").onclick = () => view.zoomOut();
  $("#zoom-reset").onclick = () => view.fit();
  $("#show-unreachable").onchange = (e) => { view.showUnreachable = e.target.checked; view.render(); };

  $("#examples").onchange = (e) => {
    loadExample(e.target.value);
    e.target.value = "";
  };

  ui.bindConflictModal();
  view.onSelect = () => renderDetail();

  // 键盘快捷键
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); dispatch("undo"); }
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); dispatch("redo"); }
  });

  // 初始：载入示例1
  repo.onChange(render);
  const initial = location.hash.replace("#", "") || "diverge";
  loadExample(Examples[initial] ? initial : "diverge");
  setTimeout(() => view.fit(), 60);

  // 暴露给无头浏览器自测
  globalThis.__app = {
    get repo() { return repo; },
    get view() { return view; },
    get ui() { return ui; },
    loadExample, render,
    clickAct(act) { dispatch(act); },
    modalVisible() { return !document.getElementById("modal-backdrop").classList.contains("hidden"); },
    modalText() { return document.getElementById("modal-body").innerText; }
  };
})();
