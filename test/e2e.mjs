import puppeteer from "puppeteer-core";
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const URL = "file:///D:/GSB/9-20-07/B/index.html";

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name, extra !== undefined ? String(extra) : ""); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: edge, headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  const ev = fn => page.evaluate(fn);
  const clickPrimary = () => page.evaluate(() => document.querySelector("#modal-foot .primary").click());
  const pickChoice = text => page.evaluate((t) => {
    const el = [...document.querySelectorAll(".choice .c-name")].find(x => x.innerText.trim() === t);
    if (el) el.closest(".choice").click();
    return !!el;
  }, text);

  // ===== 示例1：分叉 / ff / octopus / 撤销 =====
await page.goto(URL + "?t=0a", { waitUntil: "networkidle0" });
  await sleep(500);
  ok("svg nodes drawn", await ev(() => document.querySelectorAll(".commit-node").length >= 6));
  ok("refs listed", await ev(() => document.querySelectorAll("#ref-list .ref-item").length >= 5));

  await ev(() => window.__app.clickAct("merge"));
  ok("merge modal", await ev(() => window.__app.modalVisible()));
  await page.evaluate(() => document.querySelectorAll(".cb-branch").forEach(c => { c.checked = c.dataset.name === "feature/ui"; }));
  await page.evaluate(() => { window.__n0 = Object.keys(window.__app.repo.commits).length; });
  await clickPrimary();
  await sleep(200);
  ok("merge +1 commit", await ev(() => Object.keys(window.__app.repo.commits).length === window.__n0 + 1));
  ok("2 parents", await ev(() => window.__app.repo.commits[window.__app.repo.headSha()].parents.length === 2));

  await ev(() => window.__app.clickAct("undo"));
  ok("undo", await ev(() => Object.keys(window.__app.repo.commits).length === window.__n0));
  await ev(() => window.__app.clickAct("redo"));
  ok("redo", await ev(() => window.__app.repo.commits[window.__app.repo.headSha()].parents.length === 2));

  await ev(() => window.__app.clickAct("merge"));
  await page.evaluate(() => document.querySelectorAll(".cb-branch").forEach(c => { c.checked = ["feature/auth", "hotfix"].includes(c.dataset.name); }));
  await clickPrimary();
  await sleep(200);
  ok("octopus 3 parents", await ev(() => window.__app.repo.commits[window.__app.repo.headSha()].parents.length === 3));

  // ===== 示例2：rebase 冲突 =====
  await page.goto(URL + "?t=1" + "#conflict", { waitUntil: "networkidle0" });
  await sleep(500);
  ok("on feature/config", await ev(() => window.__app.repo.head.ref === "feature/config"));
  await ev(() => window.__app.clickAct("rebase"));
  ok("main picked", await pickChoice("⑂ main"));
  await clickPrimary();
  await sleep(400);
  ok("conflict modal", await ev(() => window.__app.modalVisible() && window.__app.modalText().includes("冲突")));
  ok("one editor", await ev(() => document.querySelectorAll(".conf-editor").length === 1));
  await page.evaluate(() => { document.querySelector(".conf-editor").value = "mode=staging\nport=8080\nname=demo\n"; });
  await page.evaluate(() => document.querySelector('button[data-act="mark"]').click());
  await sleep(200);
  await clickPrimary();
  await sleep(400);
  ok("modal closed after continue", await ev(() => !window.__app.modalVisible()));
  ok("pending null", await ev(() => window.__app.repo.pending === null));
  ok("later commit replayed", await ev(() => window.__app.repo.worktree["notes.txt"] === "预发环境说明\n"));
  ok("rebased onto main", await ev(() => {
    const r = window.__app.repo; const c = r.commits[r.headSha()];
    return r.isAncestor(r.branches.main, c.sha) && c.sha !== r.branches.main;
  }));

  // abort 路径
  await page.goto(URL + "?t=2" + "#conflict", { waitUntil: "networkidle0" });
  await sleep(400);
  await ev(() => { window.__origTip = window.__app.repo.headSha(); });
  await ev(() => window.__app.clickAct("rebase"));
  await pickChoice("⑂ main");
  await clickPrimary();
  await sleep(400);
  ok("conflict again", await ev(() => window.__app.modalVisible()));
  await page.evaluate(() => [...document.querySelectorAll("#modal-foot button")].find(b => b.innerText.includes("abort")).click());
  await sleep(200);
  ok("abort restores", await ev(() => window.__app.repo.pending === null && window.__app.repo.headSha() === window.__origTip));

  // ===== 示例3：cherry-pick 依赖 =====
  await page.goto(URL + "?t=3" + "#cherry", { waitUntil: "networkidle0" });
  await sleep(400);
  ok("use preselected", await ev(() => window.__app.repo.commits[window.__app.view.selectedSha].message.includes("border")));
  await ev(() => window.__app.clickAct("cherry-pick"));
  await sleep(300);
  ok("dependency conflict", await ev(() => {
  const txt = window.__app.modalText();
  return window.__app.modalVisible() && (txt.includes("冲突") || txt.includes("Cherry-pick"));
}));
  await page.evaluate(() => [...document.querySelectorAll("#modal-foot button")].find(b => b.innerText.includes("abort")).click());
  await sleep(200);

  await page.evaluate(() => {
    const dep = Object.values(window.__app.repo.commits).find(c => c.message.includes("diff"));
    window.__app.view.select(dep.sha);
  });
  await ev(() => window.__app.clickAct("cherry-pick"));
  await sleep(300);
  ok("dep clean", await ev(() => !window.__app.modalVisible() && !!window.__app.repo.worktree["helper.js"]));

  await page.evaluate(() => {
    const use = Object.values(window.__app.repo.commits).find(c => c.message.includes("border"));
    window.__app.view.select(use.sha);
  });
  await ev(() => window.__app.clickAct("cherry-pick"));
  await sleep(300);
  ok("area clean after dep", await ev(() => !window.__app.modalVisible() && !!window.__app.repo.worktree["area.js"]));

  // revert：选中第一个摘过来的 dep 新提交做 revert（回退 helper+sub）
  // ===== detached HEAD =====
await page.goto(URL + "?t=9z", { waitUntil: "networkidle0" });
  await sleep(400);
  await ev(() => window.__app.clickAct("detach"));
  await sleep(100);
  ok("detached", await ev(() => window.__app.repo.head.detached));
  await ev(() => window.__app.repo.saveWorkFile("det.txt", "x"));
  await ev(() => window.__app.clickAct("commit"));
  await page.evaluate(() => { document.getElementById("dlg-input").value = "detached work"; });
  await clickPrimary();
  await sleep(150);
  ok("commit detached", await ev(() => {
    const r = window.__app.repo; return r.head.detached && r.commits[r.headSha()].message === "detached work";
  }));

  await ev(() => { window.__preReset = window.__app.repo.headSha(); });
  await ev(() => window.__app.clickAct("reset-hard"));
  await sleep(100);
  await clickPrimary();
  await sleep(150);
  ok("hard reset", await ev(() => window.__app.repo.headSha() !== window.__preReset && !("det.txt" in window.__app.repo.worktree)));

  // 缩放 / 适应
  await ev(() => { window.__z0 = window.__app.view.scale; window.__app.view.zoomIn(); });
  ok("zoom in", await ev(() => window.__app.view.scale > window.__z0));
  await ev(() => window.__app.view.fit());
  ok("fit", await ev(() => window.__app.view.scale > 0));

  // 标签与分支按钮
  await ev(() => window.__app.clickAct("tag"));
  await page.evaluate(() => { document.getElementById("dlg-input").value = "vtest"; });
  await clickPrimary();
  await sleep(100);
  ok("tag created", await ev(() => !!window.__app.repo.tags["vtest"]));

  ok("zero js errors", errors.length === 0, errors.join("\n"));

  await browser.close();
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
