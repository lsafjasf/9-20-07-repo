'use strict';
(function (global) {
  const GV = global.GV;

  function commit(repo, parentIds, tree, message) {
    const c = repo.addCommit(parentIds, tree, message);
    return c.id;
  }

  function buildDiverge() {
    const repo = new GV.Repo();
    const t0 = { 'main.txt': '项目初始化\nv1\n', 'config.txt': 'debug=false\nport=8080\n' };
    const a = commit(repo, [], t0, 'Initial commit');
    repo.branches['refs/heads/main'] = a;

    const t1 = JSON.parse(JSON.stringify(t0));
    t1['main.txt'] = '项目初始化\nv1\nmain 上的新功能\n';
    const b = commit(repo, [a], t1, 'main: 添加新功能');
    repo.branches['refs/heads/main'] = b;

    const t2 = JSON.parse(JSON.stringify(t0));
    t2['feature.txt'] = 'feature 分支的工作\n';
    const f1 = commit(repo, [a], t2, 'feature: 开始实验');
    repo.branches['refs/heads/feature'] = f1;

    const t3 = JSON.parse(JSON.stringify(t2));
    t3['feature.txt'] = 'feature 分支的工作\n继续实验\n';
    const f2 = commit(repo, [f1], t3, 'feature: 继续实验');
    repo.branches['refs/heads/feature'] = f2;

    repo.tags['refs/tags/v0.1'] = a;
    repo.index = JSON.parse(JSON.stringify(repo.commits[b].tree));
    repo.worktree = JSON.parse(JSON.stringify(repo.index));
    return repo;
  }

  function buildRebaseConflict() {
    const repo = new GV.Repo();
    const base = { 'app.js': 'line1\nline2\nline3\n', 'shared.txt': 'A\nB\nC\n' };
    const r = commit(repo, [], base, 'Initial commit');
    repo.branches['refs/heads/main'] = r;

    const mt = JSON.parse(JSON.stringify(base));
    mt['shared.txt'] = 'A\nMAIN-CHANGE\nC\n';
    mt['main-only.txt'] = 'only on main\n';
    const m1 = commit(repo, [r], mt, 'main: 修改 shared.txt');
    repo.branches['refs/heads/main'] = m1;

    const ft = JSON.parse(JSON.stringify(base));
    ft['shared.txt'] = 'A\nFEATURE-CHANGE\nC\n';
    ft['feature.js'] = "console.log('feature');\n";
    const f1 = commit(repo, [r], ft, 'feature: 也修改 shared.txt');
    repo.branches['refs/heads/feature'] = f1;

    const ft2 = JSON.parse(JSON.stringify(ft));
    ft2['feature.js'] = "console.log('feature v2');\n";
    const f2 = commit(repo, [f1], ft2, 'feature: 升级 feature.js');
    repo.branches['refs/heads/feature'] = f2;

    repo.headRef = 'refs/heads/feature';
    repo.index = JSON.parse(JSON.stringify(repo.commits[f2].tree));
    repo.worktree = JSON.parse(JSON.stringify(repo.index));
    return repo;
  }

  function buildPickDependency() {
    const N = String.fromCharCode(10);
    const repo = new GV.Repo();
    const addFn = 'exports.add = function (a, b) {' + N + '  return a + b;' + N + '};' + N;
    const base = {
      'app.js': "var util = require('./util');" + N + "function greet() {" + N + "  return util.add(1, 2);" + N + '}' + N,
      'util.js': addFn
    };
    const r = commit(repo, [], base, 'Initial commit');
    repo.branches['refs/heads/main'] = r;

    const t1 = JSON.parse(JSON.stringify(base));
    t1['util.js'] = addFn + 'exports.mul = function (a, b) {' + N + '  return a * b;' + N + '};' + N;
    const c2 = commit(repo, [r], t1, 'C2: util.js 新增 mul');
    repo.branches['refs/heads/topic'] = c2;

    const t2 = JSON.parse(JSON.stringify(t1));
    t2['util.js'] = t1['util.js'] + 'exports.sq = function (x) {' + N + '  return exports.mul(x, x);' + N + '};' + N;
    t2['app.js'] = "var util = require('./util');" + N + "function greet() {" + N + "  return 'hi ' + util.mul(2, 3);" + N + '}' + N;
    const c3 = commit(repo, [c2], t2, 'C3: 新增 sq(用 mul) 并改 app.js');
    repo.branches['refs/heads/topic'] = c3;

    const mt = JSON.parse(JSON.stringify(base));
    mt['main.txt'] = 'main 继续自己的开发' + N;
    const m1 = commit(repo, [r], mt, 'main: 独立演进');
    repo.branches['refs/heads/main'] = m1;

    repo.tags['refs/tags/start'] = r;
    repo.index = JSON.parse(JSON.stringify(repo.commits[m1].tree));
    repo.worktree = JSON.parse(JSON.stringify(repo.index));
    return repo;
  }


  const EXAMPLES = {
    diverge: {
      title: '示例 ① 分叉合并',
      build: buildDiverge,
      banner: '<b>分叉合并示例。</b> main 与 feature 从 v0.1 分叉，各自前进。<br>' +
        '尝试：选中 feature 分支后点击 <b>merge</b>，会生成一个双父合并提交；或者 checkout feature 后 <b>rebase main</b> 观察提交被重新生成。<br>' +
        '也可点击「▶ 运行示例步骤」直接执行 merge。',
      action: function (app) {
        app.log('演示：将 feature 合并进 main', 'info');
        app.doMerge('refs/heads/feature', { ffOnly: false, noFf: false });
      }
    },
    rebase: {
      title: '示例 ② rebase 冲突',
      build: buildRebaseConflict,
      banner: '<b>rebase 冲突示例。</b> 当前在 feature 分支，它与 main 都修改了 <b>shared.txt</b> 的同一行。<br>' +
        '点击「▶ 运行示例步骤」执行 <b>git rebase main</b>，会在重放第一个提交时弹出冲突解决界面；' +
        '编辑冲突文件（删除冲突标记）后点「标记已解决并继续」。你也可以 <b>skip</b> 或 <b>abort</b>。',
      action: function (app) {
        app.log('演示：git rebase main（当前分支 feature）', 'info');
        app.doRebase('refs/heads/main', null);
      }
    },
    pick: {
      title: '示例 ③ cherry-pick 依赖',
      build: buildPickDependency,
      banner: '<b>cherry-pick 依赖示例。</b> topic 分支有两个提交：<b>C2</b> 先在 util.js 添加 mul，<b>C3</b> 的 app.js 依赖它。<br>' +
        'main 上没有 C2。直接「▶ 运行示例步骤」cherry-pick <b>C3</b> 会因缺少前置改动而冲突，展示依赖问题。<br>' +
        '正确做法：先 cherry-pick <b>C2</b>（在下拉框选择 “C2:…”），成功后再 cherry-pick C3。' +
        '冲突界面里同样可以编辑解决、skip 或 abort，每个操作都能撤销。',
      action: function (app) {
        const topicTip = app.repo.branches['refs/heads/topic'];
        app.log('演示：在 main 上直接 cherry-pick 依赖 C2 的 C3（预期冲突）', 'info');
        app.doCherryPick(topicTip);
      }
    }
  };

  GV.EXAMPLES = EXAMPLES;
})(window);
