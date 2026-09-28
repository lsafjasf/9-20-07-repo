/* ui.js — 对话框、表单、冲突解决界面、侧栏面板渲染 */
(function (global) {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  class UI {
    constructor(repo, view) {
      this.repo = repo;
      this.view = view;
      this.backdrop = $("#modal-backdrop");
      this.titleEl = $("#modal-title");
      this.bodyEl = $("#modal-body");
      this.footEl = $("#modal-foot");
      this.editingFile = null;
      this.statusTimer = null;
    }

    /* ---------- 状态提示 ---------- */
    status(msg, kind) {
      const el = $("#status-text");
      el.textContent = msg;
      el.className = kind || "";
      clearTimeout(this.statusTimer);
      if (kind === "ok" || kind === "err")
        this.statusTimer = setTimeout(() => { el.textContent = "就绪"; el.className = ""; }, 3500);
    }

    guard(fn, okMsg) {
      try {
        const r = fn();
        if (okMsg) this.status(okMsg, "ok");
        return r;
      } catch (e) {
        this.status(e.message, "err");
        return undefined;
      }
    }

    /* ---------- 模态框 ---------- */
    open(title, bodyHTML, footButtons) {
      this.titleEl.textContent = title;
      this.bodyEl.innerHTML = bodyHTML;
      this.footEl.innerHTML = "";
      (footButtons || []).forEach(b => {
        const btn = document.createElement("button");
        btn.textContent = b.text;
        if (b.primary) btn.className = "primary";
        if (b.danger) btn.classList.add("danger");
        if (b.left) btn.classList.add("left");
        btn.onclick = () => {
          if (b.onClick === false) return;
          const keep = b.onClick && b.onClick();
          if (!keep) this.close();
        };
        this.footEl.appendChild(btn);
      });
      this.backdrop.classList.remove("hidden");
    }

    close() { this.backdrop.classList.add("hidden"); }

    prompt(title, label, defaultValue, onOk, opts) {
      opts = opts || {};
      const body =
        '<div class="form-row"><label>' + label + '</label>' +
        '<input type="text" id="dlg-input" value="' + escapeHtml(defaultValue || "") + '"></div>' +
        (opts.hint ? '<p class="muted small">' + opts.hint + '</p>' : "");
      this.open(title, body, [
        { text: "取消", left: true },
        {
          text: opts.okText || "确定", primary: true,
          onClick: () => {
            const v = $("#dlg-input").value;
            const err = onOk(v);
            if (err === true) return true; // 保持打开
          }
        }
      ]);
      setTimeout(() => { const i = $("#dlg-input"); if (i) { i.focus(); i.select(); } }, 0);
      $("#dlg-input").addEventListener("keydown", e => {
        if (e.key === "Enter") this.footEl.querySelector(".primary").click();
      });
    }

    /* ---------- 通用单选列表（分支 / 提交） ---------- */
    chooseFrom(title, items, onOk, opts) {
      opts = opts || {};
      let sel = opts.preselect != null ? opts.preselect : (items[0] && items[0].id);
      const render = () => {
        const list = items.map(it =>
          '<div class="choice' + (it.id === sel ? " sel" : "") + '" data-id="' + escapeAttr(it.id) + '">' +
          '<input type="radio" class="radio" ' + (it.id === sel ? "checked" : "") + '>' +
          '<div><div class="c-name">' + escapeHtml(it.label) + "</div>" +
          (it.desc ? '<div class="c-desc">' + escapeHtml(it.desc) + "</div>" : "") +
          "</div></div>").join("");
        $("#dlg-list").innerHTML = list || '<p class="muted">没有可选项</p>';
        $("#dlg-list").querySelectorAll(".choice").forEach(el => {
          el.onclick = () => { sel = el.dataset.id; render(); };
        });
      };
      const body = (opts.intro ? '<p class="muted">' + opts.intro + "</p>" : "") +
        '<div id="dlg-list" class="choice-list"></div>';
      this.open(title, body, [
        { text: "取消", left: true },
        {
          text: opts.okText || "确定", primary: true,
          onClick: () => {
            if (sel == null) return true;
            return onOk(sel) === true;
          }
        }
      ]);
      render();
    }

    /* ---------- 冲突解决 ---------- */
    openConflict() {
      const p = this.repo.pending;
      if (!p || !p.conflicts || !p.conflicts.length) return;
      const kindText = {
        merge: "合并", rebase: "变基", "cherry-pick": "Cherry-pick", revert: "Revert"
      }[p.kind];
      const filesHtml = p.conflicts.map((c, i) => {
        if (c.type === "delmod") return this._delmodBlock(c, i);
        return this._contentBlock(c, i);
      }).join("");

      this.open("解决冲突 — " + kindText + "进行中",
        '<div class="pending-note">⚠ ' + this._pendingTip(p) + "</div>" + filesHtml,
        [
          {
            text: "中止操作（abort）", left: true, danger: true,
            onClick: () => { this.repo.abortOperation(); this.status("已中止，状态恢复", "ok"); }
          },
          p.kind === "rebase" ? {
            text: "跳过此提交（skip）",
            onClick: () => {
              if (!this._allResolved()) return this._warnUnresolved();
              this.repo.skipRebaseCommit();
              this.afterContinue();
            }
          } : null,
          {
            text: "标记已解决并继续", primary: true,
            onClick: () => {
              if (!this._allResolved()) return this._warnUnresolved();
              this._collectResolutions(p);
              const r = this.repo.continueOperation();
              this.afterContinue(r);
              return true; // 有后续冲突时保持/重开
            }
          }
        ].filter(Boolean));
    }

    afterContinue(r) {
      const p = this.repo.pending;
      if (p && p.conflicts && p.conflicts.length) {
        this.openConflict();
        this.status("仍有后续冲突需要解决", "warn");
        return;
      }
      this.close();
      this.status("操作完成 ✓", "ok");
      const sha = this.repo.headSha();
      if (sha) { this.view.select(sha); }
    }

    _pendingTip(p) {
      if (p.kind === "merge")
        return "合并 " + p.targetNames.join(", ") + " 时产生冲突。逐个文件选择保留内容，全部解决后继续生成 merge 提交。";
      if (p.kind === "rebase") {
        const orig = this.repo.commits[p.commits[p.idx]];
        return "正在重放提交 " + (orig ? orig.message : "") + "。冲突标记中 ours=已变基到的新基，theirs=被重放的旧提交。";
      }
      if (p.kind === "cherry-pick")
        return "摘取的提交无法干净应用。ours=当前分支，theirs=被摘取的补丁。";
      return "反向应用提交时产生冲突。";
    }

    _contentBlock(c, i) {
      const markerCount = (c.content.match(/^<{7}|^>{7}/gm) || []).length;
      return '<div class="conflict-file" id="cf-' + i + '">' +
        '<div class="conf-head"><span class="fname">📄 ' + escapeHtml(c.path) + '</span>' +
        '<span class="badge conflict" id="cb-' + i + '">未解决</span>' +
        '<div class="conf-actions">' +
        '<button class="mini" data-act="ours" data-i="' + i + '">采用 ours</button>' +
        '<button class="mini" data-act="theirs" data-i="' + i + '">采用 theirs</button>' +
        '<button class="mini" data-act="mark" data-i="' + i + '">标记已解决</button>' +
        "</div></div>" +
        '<textarea class="conf-editor" id="ce-' + i + '" spellcheck="false">' +
        escapeHtml(c.content) + "</textarea>" +
        '<div class="conf-meta">检测到 ' + markerCount / 2 + ' 处冲突段。可直接编辑文本（删掉 ' +
        "<<<<<<< / ======= / >>>>>>> 标记），再点「标记已解决」。</div></div>";
    }

    _delmodBlock(c, i) {
      const side = c.oursPresent ? "ours 修改了文件，theirs 删除了它" : "ours 删除了文件，theirs 修改了它";
      const keepContent = c.oursPresent ? c.ours : c.theirs;
      return '<div class="conflict-file" id="cf-' + i + '">' +
        '<div class="conf-head"><span class="fname">📄 ' + escapeHtml(c.path) + '</span>' +
        '<span class="badge delmod" id="cb-' + i + '">修改/删除</span></div>' +
        '<div class="conf-meta">' + side + "。请选择：</div>" +
        '<div class="conf-head">' +
        '<div class="conf-actions">' +
        '<button class="mini" data-act="deldel" data-i="' + i + '">确认删除文件</button>' +
        '<button class="mini" data-act="delkeep" data-i="' + i + '">保留修改后的文件</button>' +
        "</div></div>" +
        '<textarea class="conf-editor" id="ce-' + i + '" spellcheck="false">' +
        escapeHtml(keepContent) + "</textarea></div>";
    }

    bindConflictModal() {
      this.bodyEl.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;
        const i = +btn.dataset.i, act = btn.dataset.act;
        const p = this.repo.pending;
        const c = p.conflicts[i];
        if (!c) return;
        const editor = $("#ce-" + i);
        if (act === "ours") { editor.value = c.ours === undefined ? "" : c.ours; this._flash(i); }
        if (act === "theirs") { editor.value = c.theirs === undefined ? "" : c.theirs; this._flash(i); }
        if (act === "mark") this._markOne(i);
        if (act === "deldel") {
          this.repo.resolveConflict(c.path, { action: "remove" });
          this.openConflict();
        }
        if (act === "delkeep") {
          this.repo.resolveConflict(c.path, { action: "keep", content: editor.value });
          this.openConflict();
        }
      });
    }

    _flash(i) {
      const box = $("#cf-" + i);
      box.style.boxShadow = "0 0 0 2px #58a6ff";
      setTimeout(() => box.style.boxShadow = "", 500);
    }

    _markOne(i) {
      const p = this.repo.pending;
      const c = p.conflicts[i];
      const content = $("#ce-" + i).value;
      if (/^<{7}|^={7}$|^>{7}/m.test(content)) {
        $("#cb-" + i).textContent = "仍有冲突标记";
        $("#cf-" + i).classList.add("bad");
        return;
      }
      this.repo.resolveConflict(c.path, { action: "keep", content });
      this.openConflict();
    }

    _allResolved() {
      const p = this.repo.pending;
      return p && p.conflicts.every(c => c.resolved);
    }

    _warnUnresolved() {
      this.status("还有冲突文件未标记为已解决", "err");
      return true;
    }

    _collectResolutions() {
      // 内容型冲突在点“标记已解决”时已写入 repo；此处兜底（正常不会走到）
    }

    /* ---------- 帮助 ---------- */
    openHelp() {
      this.open("使用帮助",
        '<div class="help-cols"><div>' +
        "<h4>基本操作</h4>" +
        "左侧编辑文件并保存 → 顶部「＋ 提交」生成提交。<br>" +
        "「分支/标签」作用于当前 HEAD；「切换」可切分支，detach 后 HEAD 直接指向提交。<br>" +
        "点击图中节点选中提交，用于 cherry-pick / revert / reset 目标。" +
        "<h4>合并 / 变基</h4>" +
        "merge 默认允许 fast-forward；选择多个分支即 octopus 合并（冲突时 Git 会拒绝）。<br>" +
        "rebase 把当前分支提交重放到目标之上，提交会获得全新 SHA。<br>" +
        "rebase --onto 依次选择 新基 on­to 与 旧上游 upstream，截取区间移植。" +
        "<h4>冲突</h4>" +
        "弹窗内可直接编辑、采用单侧、或处理修改/删除冲突；解决后「继续」，也可 skip / abort。" +
        "</div><div>" +
        "<h4>撤销</h4>" +
        "每个操作（含冲突解决的全过程）都可撤销/重做，多步操作整体回滚。" +
        "<h4>储藏与引用日志</h4>" +
        "「▤ 储藏」收起工作区改动，左侧列表可查看内容摘要、应用或丢弃。<br>" +
        "右侧「引用日志」记录每次引用移动的前后值、时间与来源操作，点「回到此状态」可将引用回退到该历史状态（回退本身也会入日志）。" +
        "<h4>画布</h4>" +
        "滚轮缩放、拖拽平移、双击空白处适应窗口。<br>" +
        "空心圆点＝merge；虚线灰线连接的是无引用指向的游离提交。" +
        "<h4>reset 三模式</h4>" +
        "--soft：只移指针，改动保留；--mixed：清空暂存语义（本模型工作区仍保留）；" +
        "--hard：指针与工作区一起重置，改动丢弃。" +
        "<h4>三个示例</h4>" +
        "右上下拉框载入：分叉/octopus、rebase 冲突、cherry-pick 依赖；底部状态栏会给出操作建议。" +
        "</div></div>",
        [{ text: "知道了", primary: true }]);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(s) { return escapeHtml(s); }

  global.UI = UI;
  global.escapeHtml = escapeHtml;
})(window);
