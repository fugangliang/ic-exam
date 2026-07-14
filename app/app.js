/* UI 制御（画面遷移・出題フロー・データ管理） */

(() => {
  // ---- 状態 ----
  let questions = [];            // 全問題
  let questionsById = new Map();
  let session = null;            // {list, index, attempts, pendingChoice, qStart, timerId}
  let mode = "random";

  const $ = sel => document.querySelector(sel);
  const $$ = sel => document.querySelectorAll(sel);

  // ---- 画面遷移 ----
  function show(name) {
    $$(".screen").forEach(s => s.classList.remove("active"));
    $("#screen-" + name).classList.add("active");
    window.scrollTo(0, 0);
  }

  document.addEventListener("click", e => {
    const nav = e.target.closest("[data-nav]");
    if (nav) {
      if (nav.dataset.nav === "home") refreshHome();
      show(nav.dataset.nav);
    }
  });

  // ---- ホーム ----
  async function refreshHome() {
    questions = await DB.getAllQuestions();
    questionsById = new Map(questions.map(q => [q.id, q]));
    const attempts = await DB.getAllAttempts();
    const st = Logic.overallStats(attempts);
    const usable = questions.filter(q => !q.has_figure).length;
    $("#home-stats").innerHTML = "";
    addChip(`収録 <b>${usable}</b> 問`);
    addChip(`累計正答率 <b>${st.rate}%</b>（${st.correct}/${st.total}）`);
    addChip(`今日 <b>${st.todayCount}</b> 問`);
    buildCategorySelectors();
    renderCategoryStats(Logic.categoryStats(questions, attempts));
    await updateFilterCount();
    $("#home-message").textContent = usable === 0
      ? "問題データがありません。右上の⚙からJSONをimportしてください。" : "";
  }

  function addChip(html) {
    const d = document.createElement("div");
    d.className = "stat-chip";
    d.innerHTML = html; // 内部生成文字列のみ（ユーザーデータは含めない）
    $("#home-stats").appendChild(d);
  }

  /** 分野別の得意・不得意テーブル（全履歴ベース。苦手＝直近不正解が多い分野を先頭に表示） */
  function renderCategoryStats(list) {
    const el = $("#category-stats");
    el.innerHTML = "";
    if (list.length === 0) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "問題データがありません。";
      el.appendChild(p);
      return;
    }
    const table = document.createElement("table");
    table.className = "summary-table";
    table.innerHTML = "<tr><th>分野</th><th>総問題数</th><th>正答率</th><th>要復習</th></tr>";
    for (const c of list) {
      const tr = document.createElement("tr");
      const accuracyText = c.accuracy === null ? "―" : `${c.accuracy}%`;
      const reviewText = c.attemptedQuestions > 0 ? `${c.wrongNow}/${c.attemptedQuestions}問` : "―";
      [c.category, `${c.totalQuestions}問`, accuracyText, reviewText].forEach(t => {
        const td = document.createElement("td");
        td.textContent = t;
        tr.appendChild(td);
      });
      table.appendChild(tr);
    }
    el.appendChild(table);
  }

  /** 絞り込み（直近不正解のみ／自信なしのみ）チェック時の対象問題数をリアルタイム表示 */
  async function updateFilterCount() {
    const onlyWrong = $("#filter-wrong").checked;
    const onlyUnsure = $("#filter-unsure").checked;
    if (!onlyWrong && !onlyUnsure) { $("#filter-count").textContent = ""; return; }
    const attempts = await DB.getAllAttempts();
    const questionStats = Logic.perQuestionStats(attempts);
    const list = Logic.buildQuizSet(questions, {
      mode,
      category: $("#sel-category").value,
      subcategory: $("#sel-subcategory").value,
      count: 0,
      onlyWrong, onlyUnsure, questionStats,
    });
    $("#filter-count").textContent = `対象 ${list.length} 問`;
  }

  function buildCategorySelectors() {
    const tree = Logic.categoryTree(questions.filter(q => !q.has_figure));
    const catSel = $("#sel-category");
    const prev = catSel.value;
    catSel.innerHTML = "";
    for (const cat of tree.keys()) {
      const o = document.createElement("option");
      o.value = o.textContent = cat;
      catSel.appendChild(o);
    }
    if (prev && tree.has(prev)) catSel.value = prev;
    buildSubcategorySelector(tree);
    catSel.onchange = () => { buildSubcategorySelector(tree); updateFilterCount(); };
  }

  function buildSubcategorySelector(tree) {
    const subSel = $("#sel-subcategory");
    subSel.innerHTML = '<option value="">すべて</option>';
    const subs = tree.get($("#sel-category").value);
    if (subs) for (const s of subs) {
      const o = document.createElement("option");
      o.value = o.textContent = s;
      subSel.appendChild(o);
    }
    subSel.onchange = updateFilterCount;
  }

  $$(".mode-tab").forEach(btn => btn.addEventListener("click", () => {
    $$(".mode-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mode = btn.dataset.mode;
    $("#category-selectors").classList.toggle("hidden", mode !== "category");
    updateFilterCount();
  }));

  $("#filter-wrong").addEventListener("change", updateFilterCount);
  $("#filter-unsure").addEventListener("change", updateFilterCount);

  // ---- 出題セッション ----
  $("#btn-start").addEventListener("click", async () => {
    const onlyWrong = $("#filter-wrong").checked;
    const onlyUnsure = $("#filter-unsure").checked;
    // 絞り込みの有無に関わらず取得する: 通常出題でも出題回数の少ない問題を優先するため
    const questionStats = Logic.perQuestionStats(await DB.getAllAttempts());
    const list = Logic.buildQuizSet(questions, {
      mode,
      category: $("#sel-category").value,
      subcategory: $("#sel-subcategory").value,
      count: parseInt($("#sel-count").value, 10),
      onlyWrong, onlyUnsure, questionStats,
    });
    if (list.length === 0) {
      $("#home-message").textContent = "条件に合う問題がありません。";
      return;
    }
    session = { list, index: 0, attempts: [], pendingChoice: null, qStart: 0, timerId: null };
    show("quiz");
    renderQuestion();
  });

  $("#btn-quit").addEventListener("click", () => {
    if (session && session.index < session.list.length &&
        !confirm("演習を中断しますか？（解答済み分の履歴は保存されています）")) return;
    stopTimer();
    session = null;
    refreshHome();
    show("home");
  });

  function renderQuestion() {
    const q = session.list[session.index];
    session.pendingChoice = null;
    $("#quiz-progress").textContent = `${session.index + 1} / ${session.list.length}`;
    $("#quiz-meta").textContent =
      `${q.category}${q.subcategory ? " › " + q.subcategory : ""}｜出典: ${q.source || "―"}`;
    $("#quiz-body").textContent = q.body;

    const box = $("#quiz-choices");
    box.innerHTML = "";
    q.choices.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = "choice-btn";
      const num = document.createElement("span");
      num.className = "choice-num";
      num.textContent = String(i + 1);
      b.appendChild(num);
      b.appendChild(document.createTextNode(c));
      b.addEventListener("click", () => onChoice(i));
      box.appendChild(b);
    });

    $("#confidence-panel").classList.add("hidden");
    $("#result-panel").classList.add("hidden");
    startTimer();
    window.scrollTo(0, 0);
  }

  function startTimer() {
    session.qStart = Date.now();
    stopTimer();
    session.timerId = setInterval(() => {
      const s = Math.floor((Date.now() - session.qStart) / 1000);
      $("#quiz-timer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 500);
    $("#quiz-timer").textContent = "0:00";
  }

  function stopTimer() {
    if (session && session.timerId) { clearInterval(session.timerId); session.timerId = null; }
  }

  /** タップ1: 選択肢 → タイマー停止・自信度パネル表示（正誤はまだ見せない） */
  function onChoice(i) {
    if (session.pendingChoice !== null) return;
    session.pendingChoice = { choice: i, timeSec: Math.round((Date.now() - session.qStart) / 1000) };
    stopTimer();
    $$("#quiz-choices .choice-btn").forEach((b, j) => {
      b.disabled = true;
      if (j === i) b.classList.add("selected");
    });
    $("#confidence-panel").classList.remove("hidden");
  }

  /** タップ2: 自信度 → 履歴保存・正誤と解説を表示 */
  $$(".conf-btn").forEach(btn => btn.addEventListener("click", async () => {
    if (!session || session.pendingChoice === null) return;
    const q = session.list[session.index];
    const { choice, timeSec } = session.pendingChoice;
    const correct = choice === q.answer;
    const attempt = {
      question_id: q.id,
      timestamp: Date.now(),
      correct,
      time_sec: timeSec,
      confidence: btn.dataset.conf,
    };
    session.attempts.push(attempt);
    await DB.addAttempt(attempt);

    $("#confidence-panel").classList.add("hidden");
    $$("#quiz-choices .choice-btn").forEach((b, j) => {
      if (j === q.answer) b.classList.add("correct");
      else if (j === choice) b.classList.add("wrong");
    });
    const v = $("#result-verdict");
    v.textContent = correct ? "◯ 正解" : "✕ 不正解";
    v.className = correct ? "ok" : "ng";
    const exp = $("#result-explanation");
    exp.innerHTML = "";
    const head = document.createElement("div");
    head.className = "exp-head";
    head.textContent = "解説";
    exp.appendChild(head);
    exp.appendChild(document.createTextNode(q.explanation || "（解説未収録）"));
    $("#result-panel").classList.remove("hidden");
    $("#btn-next").textContent =
      session.index + 1 < session.list.length ? "次の問題" : "結果を見る";
  }));

  /** タップ3: 次問 or 結果 */
  $("#btn-next").addEventListener("click", () => {
    session.index++;
    if (session.index < session.list.length) renderQuestion();
    else showSummary();
  });

  // ---- 結果 ----
  function showSummary() {
    const { total, correct, byCat } = Logic.summarize(session.attempts, questionsById);
    const rate = total ? Math.round(correct / total * 100) : 0;
    const el = $("#summary-content");
    el.innerHTML = "";

    const score = document.createElement("div");
    score.className = "summary-score";
    score.textContent = `${correct} / ${total}（${rate}%）`;
    el.appendChild(score);

    const note = document.createElement("p");
    note.className = "muted";
    note.style.textAlign = "center";
    note.textContent = "合格ライン目安: 70〜75%";
    el.appendChild(note);

    const table = document.createElement("table");
    table.className = "summary-table";
    table.innerHTML = "<tr><th>分野</th><th>正答</th><th>平均時間</th></tr>";
    for (const [cat, c] of byCat) {
      const tr = document.createElement("tr");
      [cat, `${c.correct}/${c.total}`, `${Math.round(c.time / c.total)}秒`].forEach(t => {
        const td = document.createElement("td");
        td.textContent = t;
        tr.appendChild(td);
      });
      table.appendChild(tr);
    }
    el.appendChild(table);
    session = null;
    show("summary");
  }

  // ---- データ管理 ----
  $("#file-import").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const { questions: valid, errors } = Logic.normalizeImport(parsed);
      const n = await DB.upsertQuestions(valid);
      $("#import-result").textContent =
        `${n}問を登録（追加・上書き）` +
        (errors.length ? `／スキップ ${errors.length} 件: ${errors.slice(0, 3).map(x => `${x.id}(${x.errs[0]})`).join(", ")}${errors.length > 3 ? " ほか" : ""}` : "");
      await refreshHome();
    } catch (err) {
      $("#import-result").textContent = "importに失敗: " + err.message;
    }
    e.target.value = "";
  });

  $("#btn-export").addEventListener("click", async () => {
    const data = {
      exported_at: new Date().toISOString(),
      questions: await DB.getAllQuestions(),
      attempts: await DB.getAllAttempts(),
    };
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ic-exam-backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#file-restore").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const { questions: valid, attempts, errors } = Logic.normalizeImport(parsed);
      if (!attempts) throw new Error("attempts を含むexportファイルではありません");
      if (!confirm(`問題${valid.length}問・履歴${attempts.length}件を復元します。履歴は既存に追加されます（重複注意）。実行しますか？`)) {
        e.target.value = ""; return;
      }
      await DB.upsertQuestions(valid);
      await DB.restoreAttempts(attempts);
      $("#restore-result").textContent =
        `復元完了: 問題${valid.length}問・履歴${attempts.length}件` +
        (errors.length ? `／問題スキップ${errors.length}件` : "");
      await refreshHome();
    } catch (err) {
      $("#restore-result").textContent = "復元に失敗: " + err.message;
    }
    e.target.value = "";
  });

  $("#btn-sample").addEventListener("click", async () => {
    try {
      const res = await fetch("sample_questions.json");
      const { questions: valid, errors } = Logic.normalizeImport(await res.json());
      await DB.upsertQuestions(valid);
      alert(`サンプル${valid.length}問を読み込みました${errors.length ? `（スキップ${errors.length}件）` : ""}`);
      await refreshHome();
    } catch (err) {
      alert("サンプル読み込みに失敗: " + err.message);
    }
  });

  $("#btn-clear-attempts").addEventListener("click", async () => {
    if (!confirm("解答履歴を全削除します。よろしいですか？")) return;
    await DB.clearAttempts();
    await refreshHome();
    alert("解答履歴を削除しました");
  });

  $("#btn-clear-all").addEventListener("click", async () => {
    if (!confirm("問題・履歴の全データを削除します。よろしいですか？")) return;
    await DB.clearAll();
    await refreshHome();
    alert("全データを削除しました");
  });

  // ---- 起動 ----
  // ?nosw はヘッドレス検証用（SW登録がdump-domのvirtual timeを止めるため）
  if ("serviceWorker" in navigator && !location.search.includes("nosw")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  refreshHome();
})();
