/* UI 制御（画面遷移・出題フロー・模試・ダッシュボード・データ管理） */

(() => {
  // ---- 状態 ----
  let questions = [];            // 全問題
  let questionsById = new Map();
  let attemptsCache = [];        // refreshHome 時点の全履歴（情報パネル用）
  let session = null;            // 演習: {kind:"practice", list, index, attempts, pendingChoice, qStart, timerId, answered}
                                 // 模試: {kind:"mock", list, index, answers, qStart, deadline, timerId, sessionId, preset}
  let mode = "random";

  const $ = sel => document.querySelector(sel);
  const $$ = sel => document.querySelectorAll(sel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

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
      if (nav.dataset.nav === "dashboard") renderDashboard();
      show(nav.dataset.nav);
    }
  });

  // ---- ホーム ----
  async function refreshHome() {
    questions = await DB.getAllQuestions();
    questionsById = new Map(questions.map(q => [q.id, q]));
    attemptsCache = await DB.getAllAttempts();
    const attempts = attemptsCache;
    const st = Logic.overallStats(attempts);
    const usable = questions.filter(q => Logic.usable(q)).length;
    const trend = Logic.trendSummary(questions, attempts);
    $("#home-stats").innerHTML = "";
    addChip(`収録 <b>${usable}</b> 問`);
    addChip(`消化 <b>${trend.coverage}%</b>（${trend.attempted}/${usable}）`);
    addChip(`累計正答率 <b>${st.rate}%</b>（${st.correct}/${st.total}）`);
    addChip(`今日 <b>${st.todayCount}</b> 問`);
    renderTrend(trend);
    buildCategorySelectors();
    buildMockPresetSelector();
    renderCategoryStats(Logic.categoryStats(questions, attempts));
    renderModePanels();
    await updateFilterCount();
    $("#home-message").textContent = usable === 0
      ? "問題データがありません。右上の⚙からJSONをimportしてください。" : "";
  }

  function addChip(html) {
    const d = el("div", "stat-chip");
    d.innerHTML = html; // 内部生成文字列のみ（ユーザーデータは含めない）
    $("#home-stats").appendChild(d);
  }

  /** 傾向サマリー（簡潔表示）: 現在地→優先分野→次の一手。優先分野の演習をワンタップで開始できる */
  function renderTrend(t) {
    const box = $("#trend-content");
    box.innerHTML = "";
    if (t.total === 0) { box.appendChild(el("p", "muted", "問題データがありません。")); return; }
    const line = (label, text, cls) => {
      const d = el("div", "trend-line");
      d.appendChild(el("span", "trend-label", label));
      d.appendChild(el("span", "trend-text" + (cls ? " " + cls : ""), text));
      box.appendChild(d);
    };
    // 現在地
    if (t.latestMock) {
      const d = new Date(t.latestMock.timestamp).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
      const delta = t.prevMock ? `（前回${t.prevMock.rate}%→${t.latestMock.rate - t.prevMock.rate >= 0 ? "+" : ""}${t.latestMock.rate - t.prevMock.rate}）` : "";
      const gap = t.passGap > 0 ? `合格ライン70%まで あと${t.passGap}ポイント` : "合格ライン70%に到達";
      line("現在地", `直近の模試 ${t.latestMock.rate}%（${d}）${delta}。${gap}`, t.passGap > 0 ? "ng-text" : "ok-text");
    } else {
      line("現在地", `模試の記録なし。着手率${t.coverage}%（${t.attempted}/${t.total}問）`);
    }
    if (t.week.n) {
      const diff = t.prevWeek.rate === null ? "" : `（前週${t.prevWeek.rate}%→${t.week.rate - t.prevWeek.rate >= 0 ? "+" : ""}${t.week.rate - t.prevWeek.rate}）`;
      line("直近7日", `${t.week.n}問・正答率${t.week.rate}%${diff}`);
    }
    // 優先分野
    const pr = t.priorities.filter(p => p.score > 0);
    if (pr.length) {
      line("優先分野", pr.map((p, i) => `${i + 1}. ${p.category}（${p.reasons.join("・")}）`).join("　"));
    }
    // 次の一手
    const next = [];
    if (t.sureWrong) next.push(`確信誤答${t.sureWrong}問`);
    if (t.due) next.push(`本日のSRS復習${t.due}問`);
    if (t.guessCorrect) next.push(`勘・迷いで正解${t.guessCorrect}問`);
    line("次の一手", next.length ? next.join("／") + " を優先的に潰す" : "弱点集中モードで優先分野を回す");
    if (pr.length) {
      const b = el("button", "secondary-btn trend-btn", `優先分野「${pr[0].category}」を弱点集中で20問`);
      b.addEventListener("click", () => {
        const list = Logic.buildWeakSet(questions.filter(q => q.category === pr[0].category), attemptsCache, 20);
        if (list.length) startPractice(list);
      });
      box.appendChild(b);
    }
  }

  /** 分野別の得意・不得意テーブル（全履歴ベース。苦手＝直近不正解が多い分野を先頭に表示） */
  function renderCategoryStats(list) {
    const box = $("#category-stats");
    box.innerHTML = "";
    if (list.length === 0) { box.appendChild(el("p", "muted", "問題データがありません。")); return; }
    const table = el("table", "summary-table");
    table.innerHTML = "<tr><th>分野</th><th>消化</th><th>正答率</th><th>要復習</th></tr>";
    for (const c of list) {
      const tr = el("tr");
      const accuracyText = c.accuracy === null ? "―" : `${c.accuracy}%`;
      const reviewText = c.attemptedQuestions > 0 ? `${c.wrongNow}問` : "―";
      [c.category, `${c.attemptedQuestions}/${c.totalQuestions}`, accuracyText, reviewText]
        .forEach(t => tr.appendChild(el("td", null, t)));
      table.appendChild(tr);
    }
    box.appendChild(table);
  }

  /** モードごとの補助パネル表示（弱点集中＝優先小分類、SRS＝本日の復習数） */
  function renderModePanels() {
    $("#category-selectors").classList.toggle("hidden", mode !== "category");
    $("#weak-info").classList.toggle("hidden", mode !== "weak");
    $("#srs-info").classList.toggle("hidden", mode !== "srs");
    $("#mock-settings").classList.toggle("hidden", mode !== "mock");
    $("#filter-row").classList.toggle("hidden", mode !== "random" && mode !== "category");
    $("#count-row").classList.toggle("hidden", mode === "mock");
    $("#count-note").classList.toggle("hidden", mode !== "random" && mode !== "category");
    $("#btn-start").textContent = mode === "mock" ? "模試を開始" : "開始";

    if (mode === "weak") {
      const box = $("#weak-info"); box.innerHTML = "";
      const rows = Logic.heatmapRows(questions, attemptsCache).filter(r => r.priority > 0).slice(0, 5);
      box.appendChild(el("p", "mode-info-head", "優先度の高い小分類（確信誤答・直近正答率・出題配分から算出）"));
      if (rows.length === 0) box.appendChild(el("p", "muted", "履歴がまだありません。まずランダム出題で全体を1周してください。"));
      for (const r of rows) {
        box.appendChild(el("p", "mode-info-row",
          `${r.category} › ${r.subcategory || "―"}：最新正答率 ${r.latestAccuracy === null ? "未着手" : r.latestAccuracy + "%"}／確信誤答 ${r.sureWrong}問`));
      }
    }
    if (mode === "srs") {
      const box = $("#srs-info"); box.innerHTML = "";
      const due = Logic.srsDueQuestions(questions, attemptsCache);
      box.appendChild(el("p", "mode-info-head", `本日の復習予定: ${due.length} 問`));
      box.appendChild(el("p", "muted",
        "SM-2簡易版。正解を重ねるほど間隔が延び（1日→6日→…）、誤答で1日に戻ります。確信誤答は最も強く戻します。期限超過が大きい問題から出題。"));
    }
  }

  /** 絞り込み（直近不正解のみ／自信なしのみ）チェック時の対象問題数をリアルタイム表示 */
  async function updateFilterCount() {
    const onlyWrong = $("#filter-wrong").checked;
    const onlyUnsure = $("#filter-unsure").checked;
    const applies = (mode === "random" || mode === "category") && (onlyWrong || onlyUnsure);
    if (!applies) { $("#filter-count").textContent = ""; return; }
    const questionStats = Logic.perQuestionStats(attemptsCache);
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
    const tree = Logic.categoryTree(questions.filter(q => Logic.usable(q)));
    const catSel = $("#sel-category");
    const prev = catSel.value;
    catSel.innerHTML = "";
    for (const cat of tree.keys()) {
      const o = el("option", null, cat); o.value = cat;
      catSel.appendChild(o);
    }
    if (prev && tree.has(prev)) catSel.value = prev;
    buildSubcategorySelector(tree);
    catSel.onchange = () => { buildSubcategorySelector(tree); updateFilterCount(); };
  }

  function buildSubcategorySelector(tree) {
    const subSel = $("#sel-subcategory");
    const prev = subSel.value;
    subSel.innerHTML = '<option value="">すべて</option>';
    const subs = tree.get($("#sel-category").value);
    if (subs) for (const s of subs) {
      const o = el("option", null, s); o.value = s;
      subSel.appendChild(o);
    }
    if (prev && subs && subs.has(prev)) subSel.value = prev;
    subSel.onchange = updateFilterCount;
  }

  function buildMockPresetSelector() {
    const sel = $("#sel-mock-preset");
    if (sel.options.length) return;
    for (const p of Logic.mockPresets()) {
      const o = el("option", null, `${p.label}（${p.count}問・${p.minutes}分）`); o.value = p.key;
      sel.appendChild(o);
    }
  }

  $$(".mode-tab").forEach(btn => btn.addEventListener("click", () => {
    $$(".mode-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mode = btn.dataset.mode;
    renderModePanels();
    updateFilterCount();
  }));

  $("#filter-wrong").addEventListener("change", updateFilterCount);
  $("#filter-unsure").addEventListener("change", updateFilterCount);

  // ---- 出題セッション開始 ----
  $("#btn-start").addEventListener("click", async () => {
    const attempts = await DB.getAllAttempts();
    attemptsCache = attempts;
    const count = parseInt($("#sel-count").value, 10);
    let list;
    if (mode === "mock") {
      const preset = Logic.mockPresets().find(p => p.key === $("#sel-mock-preset").value) || Logic.mockPresets()[0];
      list = Logic.buildMockSet(questions, preset.count, Logic.perQuestionStats(attempts));
      if (list.length === 0) { $("#home-message").textContent = "問題データがありません。"; return; }
      if (list.length < preset.count) {
        $("#home-message").textContent = `収録数が不足のため ${list.length} 問で実施します。`;
      }
      startMock(list, preset);
      return;
    }
    if (mode === "weak") {
      list = Logic.buildWeakSet(questions, attempts, count);
    } else if (mode === "srs") {
      list = Logic.srsDueQuestions(questions, attempts);
      if (count > 0) list = list.slice(0, count);
      if (list.length === 0) { $("#home-message").textContent = "本日の復習予定はありません。"; return; }
    } else {
      list = Logic.buildQuizSet(questions, {
        mode,
        category: $("#sel-category").value,
        subcategory: $("#sel-subcategory").value,
        count,
        onlyWrong: $("#filter-wrong").checked,
        onlyUnsure: $("#filter-unsure").checked,
        questionStats: Logic.perQuestionStats(attempts),
      });
    }
    if (list.length === 0) { $("#home-message").textContent = "条件に合う問題がありません。"; return; }
    startPractice(list);
  });

  function startPractice(list) {
    session = { kind: "practice", list, index: 0, attempts: [], pendingChoice: null, qStart: 0, timerId: null };
    $("#quiz-timer").classList.remove("warn");
    show("quiz");
    renderQuestion();
  }

  $("#btn-quit").addEventListener("click", () => {
    if (!session) { show("home"); return; }
    const msg = session.kind === "mock"
      ? "模試を中断しますか？（採点されず、履歴にも残りません）"
      : "演習を中断しますか？（解答済み分の履歴は保存されています）";
    if (session.index < session.list.length && !confirm(msg)) return;
    stopTimer();
    session = null;
    refreshHome();
    show("home");
  });

  // ---- 演習（1問ごとに正誤・解説） ----
  function renderQuestion() {
    const q = session.list[session.index];
    session.pendingChoice = null;
    session.answered = false;
    $("#quiz-progress").textContent = `${session.index + 1} / ${session.list.length}`;
    const pr = (q.paper_results || []).filter(m => m === "○" || m === "×").join("");
    $("#quiz-meta").textContent =
      `${q.category}${q.subcategory ? " › " + q.subcategory : ""}｜出典: ${q.source || "―"}${pr ? "｜紙: " + pr : ""}`;
    renderChoices(q, i => onChoice(i), null);
    $("#confidence-panel").classList.add("hidden");
    $("#result-panel").classList.add("hidden");
    $("#mock-nav").classList.add("hidden");
    startTimer();
    window.scrollTo(0, 0);
  }

  /** 図版ブロック: figure_data（data URI）があれば画像、無ければ「図は原本参照」注記。textNode/img のみでHTML注入なし */
  function figureBlock(q) {
    if (!q.has_figure && !q.figure_data) return null;
    const box = el("div", "figure-box");
    if (q.figure_data && /^data:image\//.test(q.figure_data)) {
      const img = el("img", "figure-img");
      img.src = q.figure_data; img.alt = q.figure_ref || "図";
      img.addEventListener("click", () => img.classList.toggle("zoom"));
      box.appendChild(img);
      if (q.figure_ref) box.appendChild(el("div", "figure-cap", q.figure_ref));
    } else {
      box.appendChild(el("div", "figure-cap", `図版あり（画像未収録・原本参照${q.figure_ref ? ": " + q.figure_ref : ""}）`));
    }
    return box;
  }

  function renderChoices(q, onTap, selected) {
    $("#quiz-body").textContent = q.body;
    const old = $("#quiz-figure"); if (old) old.remove();
    const fb = figureBlock(q);
    if (fb) { fb.id = "quiz-figure"; $("#quiz-body").after(fb); }
    const box = $("#quiz-choices");
    box.innerHTML = "";
    q.choices.forEach((c, i) => {
      const b = el("button", "choice-btn");
      b.appendChild(el("span", "choice-num", String(i + 1)));
      b.appendChild(document.createTextNode(c));
      if (selected === i) b.classList.add("selected");
      b.addEventListener("click", () => onTap(i));
      box.appendChild(b);
    });
  }

  function fmtTime(s) { return Logic.fmtClock(s); }

  function startTimer() {
    session.qStart = Date.now();
    stopTimer();
    session.timerId = setInterval(() => {
      $("#quiz-timer").textContent = fmtTime(Math.floor((Date.now() - session.qStart) / 1000));
    }, 500);
    $("#quiz-timer").textContent = "0:00";
  }

  function stopTimer() {
    if (session && session.timerId) { clearInterval(session.timerId); session.timerId = null; }
  }

  /** タップ1: 選択肢 → タイマー停止・自信度パネル表示（正誤はまだ見せない）。
      自信度タップ（＝確定）までは何度でも選び直せる。解答時間は最後の選択時点まで */
  function onChoice(i) {
    if (session.answered) return;
    session.pendingChoice = { choice: i, timeSec: Math.round((Date.now() - session.qStart) / 1000) };
    stopTimer();
    $("#quiz-timer").textContent = fmtTime(session.pendingChoice.timeSec);
    $$("#quiz-choices .choice-btn").forEach((b, j) => b.classList.toggle("selected", j === i));
    $("#confidence-panel").classList.remove("hidden");
  }

  /** タップ2: 自信度（＝解答確定） → 履歴保存・正誤と解説を表示 */
  $$(".conf-btn").forEach(btn => btn.addEventListener("click", async () => {
    if (!session || session.kind !== "practice" || session.pendingChoice === null || session.answered) return;
    session.answered = true;
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
      b.disabled = true;
      if (j === q.answer) b.classList.add("correct");
      else if (j === choice) b.classList.add("wrong");
    });
    const v = $("#result-verdict");
    v.textContent = correct ? "◯ 正解" : "✕ 不正解";
    v.className = correct ? "ok" : "ng";
    const exp = $("#result-explanation");
    exp.innerHTML = "";
    fillExplanation(exp, q, choice, correct);
    $("#result-panel").classList.remove("hidden");
    $("#btn-next").textContent =
      session.index + 1 < session.list.length ? "次の問題" : "結果を見る";
  }));

  /** 解説ブロックを組み立てる（演習の結果パネル・模試の見直しで共用）。choice=null は未解答 */
  function fillExplanation(exp, q, choice, correct) {
    exp.appendChild(el("div", "exp-head", "解説"));
    if (!correct) {
      const yours = choice === null || choice === undefined ? "未解答" : `${choice + 1}「${q.choices[choice]}」`;
      exp.appendChild(el("div", "exp-your-answer", `あなたの解答: ${yours}／正答: ${q.answer + 1}「${q.choices[q.answer]}」`));
      if (choice !== null && choice !== undefined) {
        const excerpt = Logic.choiceExplanationExcerpt(q.explanation || "", choice, q.choices[choice]);
        if (excerpt) {
          const yc = el("div", "exp-your-choice");
          yc.appendChild(el("span", "exp-your-choice-label", "選んだ肢の解説: "));
          yc.appendChild(document.createTextNode(excerpt));
          exp.appendChild(yc);
        }
      }
    }
    const term = (!correct && choice !== null && choice !== undefined) ? Logic.explanationHighlightKey(q.choices[choice]) : null;
    appendExplanation(exp, q.explanation || "（解説未収録）", term);
  }

  /** 解説本文を表示。不正解時、選んだ肢の語（term）が本文中にあれば <mark> で強調し、
      自分の肢がなぜ誤りかの説明箇所を見つけやすくする（textNodeで組むためHTML注入なし） */
  function appendExplanation(box, text, term) {
    if (!term || !text.includes(term)) {
      box.appendChild(document.createTextNode(text));
      return;
    }
    text.split(term).forEach((part, i) => {
      if (i > 0) box.appendChild(el("mark", null, term));
      box.appendChild(document.createTextNode(part));
    });
  }

  /** タップ3: 次問 or 結果 */
  $("#btn-next").addEventListener("click", () => {
    session.index++;
    if (session.index < session.list.length) renderQuestion();
    else showSummary();
  });

  // ---- 演習結果 ----
  function showSummary() {
    const { total, correct, byCat } = Logic.summarize(session.attempts, questionsById);
    const rate = total ? Math.round(correct / total * 100) : 0;
    const box = $("#summary-content");
    box.innerHTML = "";
    $("#summary-title").textContent = "結果";
    box.appendChild(el("div", "summary-score", `${correct} / ${total}（${rate}%）`));
    const note = el("p", "muted", "合格ライン目安: 70〜75%");
    note.style.textAlign = "center";
    box.appendChild(note);
    box.appendChild(categoryTable(byCat));
    session = null;
    show("summary");
  }

  function categoryTable(byCat) {
    const table = el("table", "summary-table");
    table.innerHTML = "<tr><th>分野</th><th>正答</th><th>平均時間</th></tr>";
    for (const [cat, c] of byCat) {
      const tr = el("tr");
      [cat, `${c.correct}/${c.total}`, `${Math.round(c.time / c.total)}秒`].forEach(t => tr.appendChild(el("td", null, t)));
      table.appendChild(tr);
    }
    return table;
  }

  // ---- 模試（CBT本番形式: 制限時間・正誤非表示・前後移動可・終了後に一括採点＋見直し） ----
  function startMock(list, preset) {
    const now = Date.now();
    session = {
      kind: "mock", list, index: 0, preset,
      answers: list.map(() => ({ choice: null, time_sec: 0 })),
      qStart: now, deadline: now + preset.minutes * 60000, timerId: null,
      sessionId: `mock-${new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
    };
    $("#confidence-panel").classList.add("hidden");
    $("#result-panel").classList.add("hidden");
    show("quiz");
    renderMockQuestion();
    session.timerId = setInterval(tickMock, 500);
    tickMock();
  }

  function tickMock() {
    if (!session || session.kind !== "mock") return;
    const remain = Math.ceil((session.deadline - Date.now()) / 1000);
    const t = $("#quiz-timer");
    t.textContent = "残 " + fmtTime(remain);
    t.classList.toggle("warn", remain <= 300);
    if (remain <= 0) finishMock(true);
  }

  function renderMockQuestion() {
    const q = session.list[session.index];
    const a = session.answers[session.index];
    session.qStart = Date.now();
    $("#quiz-progress").textContent = `問 ${session.index + 1} / ${session.list.length}`;
    $("#quiz-meta").textContent = `模試（${session.preset.label}）`;
    renderChoices(q, i => {
      a.choice = a.choice === i ? null : i; // 同じ肢の再タップで解答取消
      $$("#quiz-choices .choice-btn").forEach((b, j) => b.classList.toggle("selected", j === a.choice));
      updateMockStatus();
    }, a.choice);
    $("#mock-nav").classList.remove("hidden");
    $("#btn-mock-prev").disabled = session.index === 0;
    $("#btn-mock-next").textContent = session.index + 1 < session.list.length ? "次へ →" : "採点へ";
    updateMockStatus();
    window.scrollTo(0, 0);
  }

  function updateMockStatus() {
    const answered = session.answers.filter(a => a.choice !== null).length;
    $("#mock-status").textContent = `解答済み ${answered} / ${session.list.length}（未解答は不正解扱い）`;
  }

  /** 現在の問題の滞在時間を積み上げる（前後移動・終了時に呼ぶ） */
  function accumulateMockTime() {
    const a = session.answers[session.index];
    a.time_sec += Math.round((Date.now() - session.qStart) / 1000);
    session.qStart = Date.now();
  }

  $("#btn-mock-prev").addEventListener("click", () => {
    if (!session || session.kind !== "mock" || session.index === 0) return;
    accumulateMockTime();
    session.index--;
    renderMockQuestion();
  });

  $("#btn-mock-next").addEventListener("click", () => {
    if (!session || session.kind !== "mock") return;
    accumulateMockTime();
    if (session.index + 1 < session.list.length) { session.index++; renderMockQuestion(); return; }
    confirmFinishMock();
  });

  $("#btn-mock-finish").addEventListener("click", () => {
    if (!session || session.kind !== "mock") return;
    accumulateMockTime();
    confirmFinishMock();
  });

  function confirmFinishMock() {
    const left = session.answers.filter(a => a.choice === null).length;
    const msg = left ? `未解答が ${left} 問あります（不正解扱い）。採点して終了しますか？` : "採点して終了しますか？";
    if (confirm(msg)) finishMock(false);
  }

  async function finishMock(timeUp) {
    if (!session || session.kind !== "mock" || session.finishing) return;
    session.finishing = true;
    stopTimer();
    if (!timeUp) accumulateMockTime(); // 時間切れは直前のtickで経過が確定しているためそのまま
    else accumulateMockTime();
    const s = session;
    const result = Logic.gradeMock(s.list, s.answers, s.sessionId, Date.now());
    await DB.addAttempts(result.attempts);
    session = null;
    showMockSummary(s, result, timeUp);
  }

  function showMockSummary(s, result, timeUp) {
    const box = $("#summary-content");
    box.innerHTML = "";
    $("#summary-title").textContent = `模試結果（${s.preset.label}）`;
    const score = el("div", "summary-score", `${result.correct} / ${result.total}（${result.rate}%）`);
    score.classList.add(result.rate >= 75 ? "pass" : result.rate >= 70 ? "border" : "fail");
    box.appendChild(score);
    const verdict = result.rate >= 75 ? "合格ライン（70〜75%）を上回っています" :
      result.rate >= 70 ? "合格ラインの境目です" : "合格ライン（70〜75%）に未達";
    const note = el("p", "muted", `${verdict}${timeUp ? "／時間切れで自動採点" : ""}`);
    note.style.textAlign = "center";
    box.appendChild(note);

    const chips = el("div", "stats-bar");
    const chip = html => { const d = el("div", "stat-chip"); d.innerHTML = html; chips.appendChild(d); };
    chip(`所要 <b>${fmtTime(result.timeSec)}</b> / ${s.preset.minutes}:00`);
    chip(`1問平均 <b>${result.total ? Math.round(result.timeSec / result.total) : 0}秒</b>（予算${s.preset.secPerQ}秒）`);
    chip(`未解答 <b>${result.skipped}</b> 問`);
    box.appendChild(chips);

    const sum = Logic.summarize(result.attempts, questionsById);
    const card = el("div", "card");
    card.appendChild(el("h2", null, "分野別"));
    card.appendChild(categoryTable(sum.byCat));
    box.appendChild(card);

    // 見直し: 不正解・未解答を解説付きで一覧
    const wrong = s.list.map((q, i) => ({ q, a: result.attempts[i] })).filter(x => !x.a.correct);
    const rv = el("div", "card");
    rv.appendChild(el("h2", null, `見直し（不正解・未解答 ${wrong.length} 問）`));
    if (wrong.length === 0) rv.appendChild(el("p", "muted", "全問正解です。"));
    for (const { q, a } of wrong) {
      const d = el("details", "review-item");
      const sm = el("summary");
      sm.appendChild(el("span", "review-tag", a.skipped ? "未解答" : "✕"));
      sm.appendChild(document.createTextNode(`${q.category}${q.subcategory ? " › " + q.subcategory : ""}：${q.body.slice(0, 60)}${q.body.length > 60 ? "…" : ""}`));
      d.appendChild(sm);
      d.appendChild(el("div", "question-body review-body", q.body));
      const rfb = figureBlock(q); if (rfb) d.appendChild(rfb);
      const ch = el("ol", "review-choices");
      q.choices.forEach((c, i) => {
        const li = el("li", null, c);
        if (i === q.answer) li.classList.add("correct");
        else if (i === a.choice) li.classList.add("wrong");
        ch.appendChild(li);
      });
      d.appendChild(ch);
      const exp = el("div", "explanation");
      fillExplanation(exp, q, a.choice, false);
      d.appendChild(exp);
      rv.appendChild(d);
    }
    box.appendChild(rv);
    show("summary");
  }

  // ---- 弱点ダッシュボード ----
  async function renderDashboard() {
    questions = await DB.getAllQuestions();
    questionsById = new Map(questions.map(q => [q.id, q]));
    attemptsCache = await DB.getAllAttempts();
    const attempts = attemptsCache;
    const box = $("#dash-content");
    box.innerHTML = "";
    const usable = questions.filter(q => Logic.usable(q));
    if (usable.length === 0) { box.appendChild(el("p", "muted", "問題データがありません。")); return; }

    const perQ = Logic.perQuestionStats(attempts);
    const st = Logic.overallStats(attempts);
    const series = Logic.mockSeries(attempts);
    const due = Logic.srsDueQuestions(questions, attempts);
    const budget = Logic.mockSecPerQuestion();

    // 概況チップ
    const chips = el("div", "stats-bar");
    const chip = html => { const d = el("div", "stat-chip"); d.innerHTML = html; chips.appendChild(d); };
    const trend = Logic.trendSummary(questions, attempts);
    chip(`消化率 <b>${trend.coverage}%</b>（${trend.attempted}/${usable.length}問）`);
    const paper = Logic.paperStats(questions);
    const pm = [...paper.values()].reduce((a, c) => ({ marked: a.marked + c.marked, x: a.x + c.latestX }), { marked: 0, x: 0 });
    if (pm.marked) chip(`紙演習 直近× <b>${pm.x}</b>/${pm.marked}問`);
    chip(`累計正答率 <b>${st.rate}%</b>（${st.total}解答）`);
    chip(`模試 <b>${series.length}</b> 回`);
    chip(`本日の復習 <b>${due.length}</b> 問`);
    box.appendChild(chips);

    // 1. 自信度×正誤マトリクス
    const m = Logic.confidenceMatrix(questions, attempts);
    const c1 = el("div", "card");
    c1.appendChild(el("h2", null, "自信度 × 正誤（問題ごとの最新解答）"));
    const grid = el("div", "matrix");
    const cell = (cls, label, ids, hint, startable) => {
      const d = el("div", "matrix-cell " + cls);
      d.appendChild(el("div", "matrix-label", label));
      d.appendChild(el("div", "matrix-num", `${ids.length}問`));
      d.appendChild(el("div", "matrix-hint", hint));
      if (startable && ids.length) {
        const b = el("button", "mini-btn", "この問題を演習");
        b.addEventListener("click", () => startPractice(Logic.shuffle(ids.map(id => questionsById.get(id)).filter(Boolean))));
        d.appendChild(b);
      }
      grid.appendChild(d);
    };
    cell("mx-sure-ok", "確信 ◯", m.sureCorrect, "習得済み", false);
    cell("mx-guess-ok", "勘・迷い ◯", m.guessCorrect, "実質未習得", true);
    cell("mx-sure-ng", "確信 ✕", m.sureWrong, "誤知識の定着＝最優先", true);
    cell("mx-guess-ng", "勘・迷い ✕", m.guessWrong, "未習得", true);
    c1.appendChild(grid);
    const noConf = m.noConfCorrect.length + m.noConfWrong.length;
    if (noConf) c1.appendChild(el("p", "muted", `模試のみで解答（自信度なし）: ${noConf}問（うち不正解 ${m.noConfWrong.length}問）`));
    box.appendChild(c1);

    // 2. 正答率推移（模試）＋日別
    const c2 = el("div", "card");
    c2.appendChild(el("h2", null, "正答率推移と合格ラインとの距離"));
    if (series.length === 0) c2.appendChild(el("p", "muted", "模試の記録がありません。ホームの「模試」から実施すると推移が表示されます。"));
    else {
      c2.appendChild(el("p", "mode-info-head", "模試（破線 = 合格ライン 70〜75%）"));
      c2.appendChild(barChart(series.map(s => ({
        label: new Date(s.timestamp).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" }),
        value: s.rate, sub: `${s.correct}/${s.total}`,
      }))));
    }
    const daily = Logic.dailyAccuracy(attempts, 14);
    if (daily.length) {
      c2.appendChild(el("p", "mode-info-head", "日別正答率（直近14日・演習＋模試）"));
      c2.appendChild(barChart(daily.map(d => ({ label: d.date.slice(5).replace("-", "/"), value: d.rate, sub: `${d.total}問` }))));
    }
    box.appendChild(c2);

    // 3. 分野×小分類ヒートマップ
    const rows = Logic.heatmapRows(questions, attempts);
    const c3 = el("div", "card");
    c3.appendChild(el("h2", null, "分野 × 小分類 ヒートマップ（優先度順）"));
    c3.appendChild(el("p", "muted", "色＝最新解答の正答率（赤50%未満→緑85%以上、灰＝未着手）。優先度＝(1−最新正答率)×(1+確信誤答率)×出題配分重み。"));
    const ht = el("table", "summary-table heatmap");
    ht.innerHTML = "<tr><th>分野 › 小分類</th><th>消化</th><th>最新</th><th>累計</th><th>確信✕</th><th>紙✕</th><th>秒</th><th></th></tr>";
    const paperBySub = new Map();
    for (const q of usable) {
      const pmk = Logic.paperMark(q); if (!pmk) continue;
      const k = q.category + "\u0000" + (q.subcategory || "");
      if (!paperBySub.has(k)) paperBySub.set(k, { marked: 0, x: 0 });
      const c = paperBySub.get(k); c.marked++; if (pmk !== "o") c.x++;
    }
    for (const r of rows) {
      const tr = el("tr");
      tr.appendChild(el("td", "heat-name", `${r.category} › ${r.subcategory || "―"}`));
      tr.appendChild(el("td", null, `${r.attempted}/${r.total}`));
      const tdL = el("td", `heat heat-${Logic.heatLevel(r.latestAccuracy)}`, r.latestAccuracy === null ? "―" : `${r.latestAccuracy}%`);
      tr.appendChild(tdL);
      tr.appendChild(el("td", `heat heat-${Logic.heatLevel(r.accuracy)}`, r.accuracy === null ? "―" : `${r.accuracy}%`));
      tr.appendChild(el("td", null, r.sureWrong ? String(r.sureWrong) : "―"));
      const pp = paperBySub.get(r.category + "\u0000" + r.subcategory);
      tr.appendChild(el("td", null, pp ? `${pp.x}/${pp.marked}` : "―"));
      tr.appendChild(el("td", null, r.avgTime === null ? "―" : String(r.avgTime)));
      const tdB = el("td");
      const b = el("button", "mini-btn", "演習");
      b.addEventListener("click", () => {
        const list = Logic.buildWeakSet(questions.filter(q => q.category === r.category && (q.subcategory || "") === r.subcategory), attempts, 0);
        if (list.length) startPractice(list);
      });
      tdB.appendChild(b);
      tr.appendChild(tdB);
      ht.appendChild(tr);
    }
    c3.appendChild(ht);
    box.appendChild(c3);

    // 4. 解答時間分布
    const td = Logic.timeDistribution(questions, attempts, budget);
    const c4 = el("div", "card");
    c4.appendChild(el("h2", null, `解答時間分布（予算 ${budget}秒/問）`));
    if (td.length === 0) c4.appendChild(el("p", "muted", "履歴がありません。"));
    else {
      c4.appendChild(el("p", "muted", "超過率＝予算超過した解答の割合。「正解でも超過」が高い分野は知識はあるが時間がかかる＝CBT時間管理の要注意分野。"));
      const tt = el("table", "summary-table");
      tt.innerHTML = "<tr><th>分野</th><th>平均</th><th>超過率</th><th>正解でも超過</th></tr>";
      for (const c of td) {
        const tr = el("tr");
        [c.category, `${c.avgTime}秒`, `${c.overRate}%`, `${c.correctOverRate}%`].forEach((t, i) => {
          const cellEl = el("td", null, t);
          if (i === 2 && c.overRate >= 50) cellEl.classList.add("ng-text");
          if (i === 3 && c.correctOverRate >= 50) cellEl.classList.add("ng-text");
          tr.appendChild(cellEl);
        });
        tt.appendChild(tr);
      }
      c4.appendChild(tt);
    }
    box.appendChild(c4);

    // 5. SRS キュー
    const c5 = el("div", "card");
    c5.appendChild(el("h2", null, "SRS 復習キュー"));
    const DAY = 86400000;
    const states = Logic.srsStates(attempts);
    const tomorrow = [...states.values()].filter(s => s.nextDue > Date.now() && s.nextDue <= Date.now() + DAY).length;
    c5.appendChild(el("p", "mode-info-row", `本日 ${due.length} 問／明日までに +${tomorrow} 問`));
    if (due.length) {
      const b = el("button", "primary-btn", `今日の復習を開始（${due.length}問）`);
      b.addEventListener("click", () => startPractice(due));
      c5.appendChild(b);
    }
    box.appendChild(c5);
  }

  /** CSSのみの棒グラフ（0〜100%）。70/75% に合格ラインの破線を引く */
  function barChart(items) {
    const wrap = el("div", "bars");
    const line70 = el("div", "bars-line"); line70.style.bottom = "70%"; wrap.appendChild(line70);
    const line75 = el("div", "bars-line"); line75.style.bottom = "75%"; wrap.appendChild(line75);
    for (const it of items.slice(-20)) {
      const col = el("div", "bar-col");
      const bar = el("div", "bar " + (it.value >= 75 ? "ok" : it.value >= 70 ? "mid" : "ng"));
      bar.style.height = `${Math.max(2, it.value)}%`;
      bar.title = `${it.value}%（${it.sub}）`;
      col.appendChild(el("div", "bar-val", `${it.value}`));
      col.appendChild(bar);
      col.appendChild(el("div", "bar-label", it.label));
      wrap.appendChild(col);
    }
    return wrap;
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
