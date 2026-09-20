# Git 提交图与变基可视化器

纯原生前端（HTML + CSS + JavaScript，零依赖、零构建）实现的 Git 提交图与变基教学工具。
直接用浏览器打开 `index.html` 即可运行。

## 支持的操作

| 类别 | 能力 |
| --- | --- |
| 提交与引用 | 普通提交、创建分支、轻量标签、切换分支、删除引用 |
| 合并 | fast-forward、非快进合并、**octopus merge**（多分支）、冲突检测 |
| 变基 | `rebase`、`rebase --onto upstream onto`、逐提交重放（生成全新 SHA）、空补丁跳过 |
| 摘取 | `cherry-pick`、`revert`（反向补丁三方合并）、**跨文件依赖冲突检测** |
| 重置 | `reset --soft / --mixed / --hard` |
| HEAD | attached / **detached HEAD**、游离状态下提交 |
| 冲突解决 | 行级三路冲突编辑、采用 ours/theirs、修改/删除(modify/delete)裁决、skip、abort |
| 历史 | **每个操作（含多步冲突解决全过程）均可整体撤销 / 重做** |
| 图形 | 无交叉泳道布局、贝塞尔分支线、分支配色、引用标签、游离提交虚线、滚轮缩放、拖拽平移、双击适应窗口 |

## 文件结构

```
index.html          页面骨架
css/style.css       深色主题与全部样式
js/diff3.js         基于 LCS 的逐行 diff 与三路合并（输出冲突标记）
js/repo.js          Git 引擎：对象模型、引用、merge/rebase/cherry-pick/revert/reset、冲突状态机、撤销栈
js/layout.js        提交图泳道布局（拓扑排序 + 分支线避让）
js/examples.js      三个内置示例
js/graph.js         SVG 渲染、配色、缩放拖拽
js/ui.js            对话框、冲突解决界面、侧栏
js/main.js          操作分发与装配
test/smoke.js       Node 引擎冒烟测试（57 项）
test/e2e.mjs        浏览器端到端测试（29 项，puppeteer-core + 本地 Edge）
```

## 内置示例（右上角下拉框载入）

1. **分叉与 octopus 合并** — 多条分支、标签；演示 fast-forward、两两合并、多分支 octopus。
2. **rebase 冲突** — 当前分支与主线修改同一行，rebase 首提交即冲突；解决后继续重放后续提交；
   另含 `stale-work / old / main` 三条分支用于演示 `rebase --onto main old`。
3. **cherry-pick 依赖** — `area.js` 依赖尚未摘过来的 `helper.js`：直接摘取报依赖冲突，
   先摘依赖提交再摘取目标提交即可干净落地。

## 引擎模型（简化但语义自洽）

- 每个提交保存相对第一父提交的文件增量 `{path: content | null}`，完整快照沿第一父链重放。
- SHA 为由单调计数器派生的 7 位短哈希；`counter` 同时充当逻辑时间戳，决定拓扑次序。
- 合并用逐文件三方规则（base/ours/theirs），内容冲突走 LCS-diff3；
  相邻改动自动合并，重叠改动写 `<<<<<<< / ======= / >>>>>>>` 标记；
  额外检测 add/add、modify/delete，以及“补丁新增文件引用了仅补丁侧存在的本地模块”的依赖冲突。
- rebase 把“不在 upstream 上的提交”按时间序逐个作为补丁重放到 onto 之上，每步可冲突、可跳过、可中止。
- 撤销基于整仓快照（含 `pending` 多步操作状态），一次操作对应一条可整体回滚的历史记录。

## 运行测试

```powershell
node test/smoke.js                 # 引擎逻辑测试
node test/e2e.mjs                  # 浏览器 E2E（需要本机 Edge；会尝试 require puppeteer-core）
```

快捷键：`Ctrl+Z` 撤销，`Ctrl+Y` / `Ctrl+Shift+Z` 重做。
