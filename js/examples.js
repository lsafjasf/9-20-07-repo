/* examples.js — 三个内置示例
 * 直接用底层 _makeCommit 构造历史，counter 同时充当逻辑时间戳。
 */
(function (global) {
  "use strict";

  function fresh() {
    const r = new Repo();
    // 初始提交
    const readme = "# 演示仓库\n\n在左侧编辑文件，顶部按钮执行 Git 操作。\n";
    const sha = r._makeCommit([], { "README.md": readme }, "Initial commit");
    r.branches.main = sha;
    r.head = { detached: false, ref: "main", sha: null };
    r.worktree = r.treeAt(sha);
    r.history = [];
    r.future = [];
    return r;
  }

  // 示例 1：分叉合并 —— 包含分叉、标签、ff、octopus
  function diverge() {
    const r = fresh();
    const a = r.branches.main; // Initial

    const b = r._makeCommit([a], { "app.js": "function app(){\n  console.log('v1');\n}\n" }, "添加 app.js");
    r.branches.main = b;

    // feature/auth 从 b 分叉
    const auth1 = r._makeCommit([b], { "auth.js": "export function login(){ return true; }\n" }, "auth: 实现登录");
    const auth2 = r._makeCommit([auth1], { "auth.js": "export function login(user){ return !!user; }\n" }, "auth: 校验用户名");
    r.branches["feature/auth"] = auth2;

    // feature/ui 也从 b 分叉
    const ui1 = r._makeCommit([b], { "style.css": "body { margin: 0; }\n" }, "ui: 基础样式");
    r.branches["feature/ui"] = ui1;

    // main 继续前进（之后 merge auth 可演示非 ff / ff）
    const m1 = r._makeCommit([b], { "app.js": "function app(){\n  console.log('v2');\n}\n" }, "app: 升级到 v2");
    r.branches.main = m1;

    // hotfix 从 a 就分叉，打标签
    const h1 = r._makeCommit([a], { "README.md": "# 演示仓库\n\n紧急修复版本。\n" }, "hotfix: 修正 README");
    r.branches.hotfix = h1;
    r.tags["v0.9"] = h1;

    // main 上的发布标签
    r.tags["v1.0"] = b;

    r.worktree = r.treeAt(m1);
    return {
      repo: r,
      hint: "当前在 main。试试：① 选中 feature/auth 后点 merge（非快进合并）；" +
            "② 再 merge feature/ui 与 hotfix（可多选）体验 octopus；③ merge 后撤销可回到合并前。",
      preselect: null
    };
  }

  // 示例 2：rebase 冲突
  function conflict() {
    const r = fresh();
    const a = r.branches.main;

    const fBase = r._makeCommit([a],
      { "config.txt": "mode=dev\nport=8080\nname=demo\n" },
      "添加 config.txt");
    r.branches.main = fBase;

    const main1 = r._makeCommit([fBase],
      { "config.txt": "mode=prod\nport=8080\nname=demo\n" },
      "main: 切换生产模式");
    r.branches.main = main1;

    // feature 从 fBase 分叉：第一提交与 main 都改 mode 同一行 -> rebase 冲突；
    // 第二提交改另一个文件，用于演示“冲突解决后继续重放后续提交”。
    const f1 = r._makeCommit([fBase],
      { "config.txt": "mode=staging\nport=8080\nname=demo\n" },
      "feature: 切换预发模式");
    const f2 = r._makeCommit([f1],
      { "config.txt": "mode=staging\nport=8080\nname=demo\n",
        "notes.txt": "预发环境说明\n" },
      "feature: 添加预发说明");
    r.branches["feature/config"] = f2;


    // 再准备一个 rebase --onto 的素材：
    // 从 old 分支切出 stale-work，只新增新特性；之后可
    // rebase --onto main old 把新特性搬到 main，同时甩掉 old。
    const staleBase = r._makeCommit([fBase], { "old.txt": "旧体系代码\n" }, "old: 旧模块起点");
    r.branches["old"] = staleBase;
    const stale1 = r._makeCommit([staleBase],
      { "new-feature.txt": "新特性 A\n" },
      "在旧分支上开发新特性 A");
    r.branches["stale-work"] = stale1;

    r.head = { detached: false, ref: "feature/config", sha: null };
    r.worktree = r.treeAt(f2);
    return {
      repo: r,
      hint: "当前在 feature/config。点「rebase」并选择 main：第一个提交与 main 在 mode 同一行冲突，" +
            "弹出冲突解决界面。解决并继续后，第二个提交会接着重放，最终提交全部获得新 SHA。" +
            "另可切到 stale-work 试 rebase --onto（onto=main, upstream=old）。",
      preselect: null
    };
  }

  // 示例 3：cherry-pick 依赖
  // area.js 依赖 helper.js。直接摘 area -> 依赖冲突；先摘 helper 再摘 area -> 干净。
  function cherry() {
    const r = fresh();
    const a = r.branches.main;

    const base = r._makeCommit([a],
      { "math.js": "// math 工具库\nexport function add(a,b){ return a+b; }\n\n\n\n// 预留扩展区\n" },
      "添加 math.js");
    r.branches.main = base;

    // feature：先加依赖（在文件中部插入 sub），再加使用它的 area
    const dep = r._makeCommit([base],
      {
        "math.js": "// math 工具库\nexport function add(a,b){ return a+b; }\nexport function sub(a,b){ return a-b; }\n\n\n\n// 预留扩展区\n",
        "helper.js": "import { sub } from './math.js';\nexport function diff(a,b){ return sub(a,b); }\n"
      },
      "helper: 引入 sub 与 diff");
    const use = r._makeCommit([dep],
      {
        "math.js": "// math 工具库\nexport function add(a,b){ return a+b; }\nexport function sub(a,b){ return a-b; }\n\n\n\n// 预留扩展区\n",
        "helper.js": "import { sub } from './math.js';\nexport function diff(a,b){ return sub(a,b); }\n",
        "area.js": "import { diff } from './helper.js';\n// 矩形边框宽度差\nexport function border(w,h){ return diff(w,h); }\n"
      },
      "area: 用 helper.diff 实现 border");
    r.branches["feature/area"] = use;

    // main 在文件尾部扩展区新增 mul（与 feature 的改动相距很远，自动合并不冲突）
    const main1 = r._makeCommit([base],
      { "math.js": "// math 工具库\nexport function add(a,b){ return a+b; }\n\n\n\n// 预留扩展区\nexport function mul(a,b){ return a*b; }\n" },
      "main: math 增加 mul");
    r.branches.main = main1;

    r.tags["base-v1"] = base;
    r.worktree = r.treeAt(main1);
    return {
      repo: r,
      hint: "当前在 main。直接在图中选中「area: 用 helper.diff 实现 border」并 cherry-pick：" +
            "它依赖的 helper.js 在 main 上不存在，会报“依赖冲突”。" +
            "正确顺序：先摘「helper: 引入 sub 与 diff」，再摘 area，即可干净落地。",
      preselect: use
    };
  }

  global.Examples = { diverge, conflict, cherry, names: {
    diverge: "分叉与 octopus 合并",
    conflict: "rebase 冲突",
    cherry: "cherry-pick 依赖"
  } };
})(window);
