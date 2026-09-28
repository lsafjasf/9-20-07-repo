global.window = global;
require("../js/diff3.js");
require("../js/repo.js");
require("../js/examples.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name, extra !== undefined ? extra : ""); } }
function mustThrow(name, fn) { try { fn(); fail++; console.log("FAIL (no throw):", name); } catch (e) { pass++; } }

// diff3
{
  let r = Diff3.merge3("a\nb\nc\nd", "a\nB\nc\nd", "a\nb\nC\nd", {});
  ok("diff3 non-overlap clean", r.ok && r.result === "a\nB\nC\nd", r.result);
  r = Diff3.merge3("a\nb\nc", "a\nX\nc", "a\nY\nc", {});
  ok("diff3 overlap conflict", !r.ok && r.conflicts === 1);
  r = Diff3.merge3("a", "a\nx", "a\ny", {});
  ok("diff3 both append conflict", !r.ok);
  r = Diff3.merge3("a\nb", "x\na\nb", "y\na\nb", {});
  ok("diff3 both prepend different conflict", !r.ok);
  r = Diff3.merge3("a\nb", "x\na\nb", "x\na\nb", {});
  ok("diff3 same prepend clean", r.ok && r.result === "x\na\nb", r.result);
}

// 基本提交
{
  const r = new Repo();
  r.saveWorkFile("f.txt", "1\n");
  const c1 = r.commit("first");
  ok("first commit", c1 && r.headSha() === c1);
  mustThrow("empty commit", () => r.commit("empty"));
  r.saveWorkFile("f.txt", "2\n");
  const c2 = r.commit("second");
  ok("second commit parent", r.commits[c2].parents[0] === c1);
  ok("tree replay", r.treeAt(c2)["f.txt"] === "2\n");
  r.undo();
  ok("undo commit", r.headSha() === c1 && r.worktree["f.txt"] === "2\n");
  r.redo();
  ok("redo commit", r.headSha() === c2);
}

// 分支 + ff
{
  const r = new Repo();
  r.saveWorkFile("f", "1");
  const a = r.commit("a");
  r.createBranch("dev");
  r.saveWorkFile("f", "2");
  const b = r.commit("b on main");
  r.checkoutBranch("dev");
  ok("checkout swaps worktree", r.worktree["f"] === "1");
  const res = r.merge(["main"]);
  ok("fast-forward", res.ff && r.headSha() === b);
  mustThrow("dirty checkout blocked", () => { r.saveWorkFile("f", "3"); r.checkoutBranch("main"); });
}

// 非ff合并
{
  const r = new Repo();
  r.saveWorkFile("f", "base");
  const a = r.commit("a");
  r.createBranch("x");
  r.saveWorkFile("f", "main"); r.commit("main1");
  r.checkoutBranch("x");
  r.saveWorkFile("xfile", "x"); r.commit("x1");
  r.checkoutBranch("main");
  const m1 = r.merge(["x"]);
  ok("non-ff merge commit", m1.sha && r.commits[m1.sha].parents.length === 2);
  const mt = r.treeAt(m1.sha);
  ok("conflict-free union content", mt["f"] === "main" && mt["xfile"] === "x");
}

// octopus 干净
{
  const r = new Repo();
  r.saveWorkFile("f", "base");
  r.commit("a");
  r.createBranch("x"); r.createBranch("y");
  r.saveWorkFile("m", "1"); r.commit("main1");
  r.checkoutBranch("x"); r.saveWorkFile("x", "1"); r.commit("x1");
  r.checkoutBranch("y"); r.saveWorkFile("y", "1"); r.commit("y1");
  r.checkoutBranch("main");
  const res = r.merge(["x", "y"]);
  ok("octopus merge", res.octopus && r.commits[res.sha].parents.length === 3);
  const t = r.treeAt(res.sha);
  ok("octopus union tree", t.x === "1" && t.y === "1" && t.m === "1");
}

// octopus 冲突拒绝
{
  const r = new Repo();
  r.saveWorkFile("f", "base\n"); r.commit("a");
  r.createBranch("x"); r.createBranch("y");
  r.saveWorkFile("f", "main\n"); r.commit("m");
  r.checkoutBranch("x"); r.saveWorkFile("f", "xval\n"); r.commit("x");
  r.checkoutBranch("y"); r.saveWorkFile("f", "yval\n"); r.commit("y");
  r.checkoutBranch("main");
  mustThrow("octopus conflict aborts", () => r.merge(["x", "y"]));
  ok("octopus abort clean", r.pending === null && r.worktree["f"] === "main\n");
}
// 普通 merge 冲突 -> 解决 -> 撤销整体
{
  const r = new Repo();
  r.saveWorkFile("f", "a\nb\nc\n");
  r.commit("base");
  r.createBranch("dev");
  r.saveWorkFile("f", "X\nb\nc\n"); r.commit("ours");
  r.checkoutBranch("dev");
  r.saveWorkFile("f", "Y\nb\nc\n"); r.commit("theirs");
  r.checkoutBranch("main");
  const res = r.merge(["dev"]);
  ok("merge conflict raised", res.conflict && r.pending.conflicts.length === 1);
  const c = r.pending.conflicts[0];
  ok("conflict markers", c.content.includes("<<<<<<<"));
  r.resolveConflict(c.path, { action: "keep", content: "X (merged)\nb\nc\n" });
  const cont = r.continueOperation();
  ok("merge continue", cont.done && r.commits[cont.sha].parents.length === 2);
  ok("resolved content", r.treeAt(r.headSha())["f"] === "X (merged)\nb\nc\n");
  r.undo();
  ok("undo whole merge", r.pending === null && r.worktree["f"] === "X\nb\nc\n");
}

// del/mod 冲突
{
  const r = new Repo();
  r.saveWorkFile("f", "base"); r.commit("base");
  r.createBranch("d");
  r.saveWorkFile("f", "changed"); r.commit("mod");
  r.checkoutBranch("d");
  r.deleteWorkFile("f"); r.commit("delete");
  r.checkoutBranch("main");
  const res = r.merge(["d"]);
  ok("delmod conflict", res.conflict && r.pending.conflicts[0].type === "delmod");
  r.resolveConflict("f", { action: "remove" });
  r.continueOperation();
  ok("delmod resolved deleted", !("f" in r.treeAt(r.headSha())));
}

// rebase 干净
{
  const r = new Repo();
  r.saveWorkFile("a", "1"); r.commit("base");
  r.createBranch("dev");
  r.saveWorkFile("m", "1"); r.commit("main1");
  r.checkoutBranch("dev");
  r.saveWorkFile("d", "1"); const d1 = r.commit("dev1");
  const res = r.rebase("main");
  ok("rebase done", res.done);
  ok("rebase rewritten", r.headSha() !== d1);
  ok("rebase parent main", r.commits[r.headSha()].parents[0] === r.branches.main);
  ok("rebase content", r.worktree["d"] === "1" && r.worktree["m"] === "1");
}

// rebase 冲突（示例2）
{
  const r = Examples.conflict().repo;
  const origTip = r.branches["feature/config"];
  const res = r.rebase("main");
  ok("ex2 conflict", res.conflict && r.pending.kind === "rebase");
  const c = r.pending.conflicts[0];
  r.resolveConflict(c.path, { action: "keep", content: "mode=staging\nport=8080\nname=demo\n" });
  const r2 = r.continueOperation();
  ok("rebase finish", r.pending === null, JSON.stringify(r2).slice(0,150));
  ok("rebased branch moved", r.branches["feature/config"] !== origTip);
  ok("rebased content", r.treeAt(r.headSha())["config.txt"] === "mode=staging\nport=8080\nname=demo\n");
  ok("rebased later commit lands", r.treeAt(r.headSha())["notes.txt"] === "预发环境说明\n");

  const r3 = Examples.conflict().repo;
  const saved = r3.branches["feature/config"];
  r3.rebase("main");
  r3.abortOperation();
  ok("rebase abort restore", r3.headSha() === saved && r3.pending === null);
}

// rebase --onto
{
  const r = Examples.conflict().repo;
  r.checkoutBranch("stale-work");
  ok("stale has old.txt", "old.txt" in r.treeAt(r.headSha()));
  const res = r.rebase("old", "main");
  ok("onto done", res.done, JSON.stringify(res).slice(0,200));
  const tip = r.commits[r.headSha()];
  ok("onto parent main", tip && tip.parents[0] === r.branches.main);
  ok("onto carries feature", r.treeAt(r.headSha())["new-feature.txt"] === "新特性 A\n");
  ok("onto drops old.txt", !("old.txt" in r.treeAt(r.headSha())));
}

// cherry-pick / revert
{
  const r = new Repo();
  r.saveWorkFile("f", "1\n"); r.commit("base");
  r.createBranch("dev");
  r.saveWorkFile("f", "1\n2\n"); const pick = r.commit("add 2");
  r.checkoutBranch("main");
  r.saveWorkFile("g", "x\n"); r.commit("main other");
  const res = r.cherryPick(pick);
  ok("pick clean", res.done && r.worktree["f"] === "1\n2\n");
  const pickedSha = r.headSha();
  ok("pick new sha", pickedSha !== pick);
  // revert 原始提交 pick（它相对其父 base 的补丁是“+2”，回退后 f 回到 1）
  const rev = r.revert(pick);
  ok("revert done", rev.done, JSON.stringify(rev).slice(0,200));
  ok("revert removes added line", r.worktree["f"] === "1\n");
  ok("revert msg", r.commits[r.headSha()].message.indexOf("Revert") === 0);
}

// cherry 示例：依赖顺序
{
  const r = Examples.cherry().repo;
  const use = Object.values(r.commits).find(c => c.message.indexOf("border") >= 0);
  const res = r.cherryPick(use.sha);
  ok("cherry dep conflict", res.conflict);
  r.abortOperation();
  const dep = Object.values(r.commits).find(c => c.message.indexOf("diff") >= 0);
  ok("pick dep first", r.cherryPick(dep.sha).done);
  const r2 = r.cherryPick(use.sha);
  ok("pick use after dep", r2.done, JSON.stringify(r2).slice(0,200));
  ok("area.js lands", r.worktree["area.js"] && r.worktree["area.js"].includes("diff"));
  ok("helper.js lands", r.worktree["helper.js"] && r.worktree["helper.js"].includes("sub"));
}

// reset
{
  const r = new Repo();
  r.saveWorkFile("f", "1"); const a = r.commit("a");
  r.saveWorkFile("f", "2"); const b = r.commit("b");
  r.reset(a, "soft");
  ok("soft keeps worktree", r.headSha() === a && r.worktree["f"] === "2");
  r.reset(b, "hard");
  r.saveWorkFile("f", "3"); r.reset(a, "hard");
  ok("hard resets worktree", r.headSha() === a && r.worktree["f"] === "1");
}

// detached
{
  const r = new Repo();
  r.saveWorkFile("f", "1"); const a = r.commit("a");
  r.saveWorkFile("f", "2"); const b = r.commit("b");
  r.checkoutCommit(a);
  ok("detach", r.head.detached && r.worktree["f"] === "1");
  r.saveWorkFile("f", "9"); const d = r.commit("d");
  ok("detached commit", r.head.sha === d && r.branches.main === b);
}

// tag
{
  const r = new Repo();
  r.saveWorkFile("f", "1"); const a = r.commit("a");
  r.createTag("v1");
  r.saveWorkFile("f", "2"); r.commit("b");
  ok("tag resolve", r.resolve("v1") === a);
}

// 引用日志：与执行过的操作一一对应（条数与内容可断言）
{
  const r = new Repo();
  ok("reflog empty", r.reflog.length === 0);
  r.saveWorkFile("f", "1"); const a = r.commit("c1");
  r.saveWorkFile("f", "2"); const b = r.commit("c2");
  r.createBranch("dev");
  r.createTag("v1");
  r.checkoutBranch("dev");
  r.saveWorkFile("f", "3"); const c = r.commit("c3");
  r.reset(a, "hard");
  ok("reflog count == ops", r.reflog.length === 7, r.reflog.length);

  const e = r.reflog;
  ok("e1 commit creates main",
    e[0].op === "提交 c1" && e[0].kind === "branch" && e[0].ref === "main" &&
    e[0].from === null && e[0].to === a, JSON.stringify(e[0]));
  ok("e2 commit moves main",
    e[1].op === "提交 c2" && e[1].from === a && e[1].to === b);
  ok("e3 branch created",
    e[2].op === "创建分支 dev" && e[2].kind === "branch" &&
    e[2].from === null && e[2].to === b);
  ok("e4 tag created",
    e[3].kind === "tag" && e[3].ref === "v1" && e[3].from === null && e[3].to === b);
  ok("e5 HEAD switches",
    e[4].kind === "HEAD" && e[4].fromRef === "main" && e[4].toRef === "dev");
  ok("e6 commit moves dev",
    e[5].kind === "branch" && e[5].ref === "dev" && e[5].from === b && e[5].to === c);
  ok("e7 reset moves dev back",
    e[6].op.indexOf("reset --hard") === 0 && e[6].from === c && e[6].to === a);
  ok("entries have time", e.every(x => typeof x.at === "string" && typeof x.time === "number"));
  ok("seq monotone", e.every((x, i) => x.seq === i + 1));

  // 从历史节点回到某个引用状态：dev 回到 e6 之后的值 c
  r.restoreReflog(e[5].seq);
  ok("restore moves branch", r.branches.dev === c);
  ok("restore syncs worktree", r.worktree["f"] === "3");
  ok("restore itself logged", r.reflog.length === 8 &&
    r.reflog[7].op.indexOf("回退 dev") === 0 &&
    r.reflog[7].from === a && r.reflog[7].to === c, JSON.stringify(r.reflog[7]));

  // 撤销不抹掉日志，且撤销本身也入日志
  r.undo();
  ok("undo appends reflog", r.reflog.length === 9 &&
    r.reflog[8].op.indexOf("撤销：") === 0 && r.reflog[8].to === a);
  ok("undo restore state", r.branches.dev === a);
  r.redo();
  ok("redo appends reflog", r.reflog.length === 10 &&
    r.reflog[9].op.indexOf("重做：") === 0 && r.branches.dev === c);

  // HEAD 条目回退：e5 记录 HEAD 从 main 切到 dev，回到该状态应附着 dev
  r.checkoutBranch("main");
  r.restoreReflog(e[4].seq);
  ok("restore HEAD entry", !r.head.detached && r.head.ref === "dev");
  ok("restore HEAD logged", r.reflog[r.reflog.length - 1].kind === "HEAD" &&
    r.reflog[r.reflog.length - 1].toRef === "dev");
}

// 储藏：保存 / 摘要 / 应用 / 丢弃，且不产生引用日志
{
  const r = new Repo();
  r.saveWorkFile("f", "1"); r.commit("base");
  const logBefore = r.reflog.length;

  mustThrow("stash nothing", () => r.stashSave("x"));
  r.saveWorkFile("f", "2"); r.saveWorkFile("g", "new");
  const st = r.stashSave("wip feature");
  ok("stash saved", r.stashes.length === 1 && st.message === "wip feature");
  ok("stash cleans worktree", r.worktree["f"] === "1" && !("g" in r.worktree));
  ok("stash keeps base", st.baseSha === r.headSha());

  const sum = r.stashSummary(st.id);
  ok("stash summary", sum.files === 2 && sum.mods.length === 1 &&
    sum.adds.length === 1 && sum.dels.length === 0, JSON.stringify(sum));
  ok("stash summary paths", sum.paths.join(",") === "g,f" || sum.paths.join(",") === "f,g"
    ? sum.paths.includes("f") && sum.paths.includes("g") : false);

  r.saveWorkFile("h", "other");
  r.stashApply(st.id);
  ok("apply restores", r.worktree["f"] === "2" && r.worktree["g"] === "new");
  ok("apply keeps other changes", r.worktree["h"] === "other");
  ok("apply keeps stash", r.stashes.length === 1);

  r.stashDrop(st.id);
  ok("drop removes", r.stashes.length === 0);
  mustThrow("drop missing", () => r.stashDrop(st.id));
  mustThrow("apply missing", () => r.stashApply(st.id));

  // 应用冲突：储藏改动与工作区改动撞在同一处
  r.saveWorkFile("f", "stash-side");
  const st2 = r.stashSave("conflict wip");
  r.saveWorkFile("f", "work-side");
  mustThrow("apply conflict", () => r.stashApply(st2.id));
  ok("conflict apply rolls back", r.worktree["f"] === "work-side" && r.stashes.length === 1);

  // 储藏操作不移动引用 -> 不产生引用日志
  ok("stash adds no reflog", r.reflog.length === logBefore,
    r.reflog.length - logBefore);

  // 储藏可撤销
  r.undo(); // undo stashSave(st2)
  ok("undo stash restores worktree", r.worktree["f"] === "stash-side" && r.stashes.length === 0);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
