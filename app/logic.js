/* 純粋ロジック（DOM・DB非依存。node でテスト可能） */

const Logic = {

  /** 出題対象か。図版問題（has_figure）は図データ（figure_data）が入っているものだけ出題対象
      （RF指摘 2026-10-11「図そのものを入れないと意味がない」。画像なしの図版問題は再撮影→埋め込み後に自動で対象になる） */
  usable(q) { return !!q && (!q.has_figure || typeof q.figure_data === "string" && q.figure_data.startsWith("data:image/")); },

  /** 問題1件のスキーマ検証。エラー文字列の配列を返す（空＝妥当） */
  validateQuestion(q) {
    const errs = [];
    if (!q || typeof q !== "object") return ["not an object"];
    if (typeof q.id !== "string" || !q.id.trim()) errs.push("id が空");
    if (typeof q.category !== "string" || !q.category.trim()) errs.push("category が空");
    if (typeof q.body !== "string" || !q.body.trim()) errs.push("body が空");
    if (!Array.isArray(q.choices) || q.choices.length < 2) errs.push("choices が2件未満");
    else if (q.choices.some(c => typeof c !== "string" || !c.trim())) errs.push("choices に空要素");
    if (!Number.isInteger(q.answer) || q.answer < 0 ||
        (Array.isArray(q.choices) && q.answer >= q.choices.length)) errs.push("answer が choices の範囲外");
    if (typeof q.explanation !== "string") errs.push("explanation がない");
    return errs;
  },

  /**
   * import ファイルの解析結果を正規化する。
   * 受理形式: 問題配列 / {questions:[...]} / {questions:[...], attempts:[...]}（フルバックアップ）
   * 返値: {questions, attempts, errors}  errors は {index, id, errs} の配列
   */
  normalizeImport(parsed) {
    let questions = null, attempts = null;
    if (Array.isArray(parsed)) {
      questions = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.questions)) {
      questions = parsed.questions;
      if (Array.isArray(parsed.attempts)) attempts = parsed.attempts;
    } else {
      return { questions: [], attempts: null, errors: [{ index: -1, id: "", errs: ["形式不正: 配列または {questions:[...]} が必要"] }] };
    }
    const errors = [];
    const seen = new Set();
    const valid = [];
    questions.forEach((q, i) => {
      const errs = this.validateQuestion(q);
      if (q && typeof q.id === "string") {
        if (seen.has(q.id)) errs.push("ファイル内で id 重複");
        seen.add(q.id);
      }
      if (errs.length) errors.push({ index: i, id: (q && q.id) || "?", errs });
      else valid.push(q);
    });
    return { questions: valid, attempts, errors };
  },

  /** Fisher–Yates。rng は差し替え可能（テスト用） */
  shuffle(arr, rng = Math.random) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  /**
   * 出題セットを構築。mode: "random" | "category"。count 0 は全問。
   * 各問題の状態（Logic.status: アプリの解答 > 模試 > 紙の順で直近結果を採用）で
   * 不正解 → 未消化 → 自信なし → 正解 の順に出す（RF指示 2026-10-11）。
   * onlyWrong/onlyUnsure は状態 "wrong" / "unsure" に絞る。
   */
  buildQuizSet(questions, { mode, category, subcategory, count, onlyWrong, onlyUnsure, questionStats }, rng = Math.random) {
    let pool = questions.filter(q => Logic.usable(q));
    if (mode === "category" && category) {
      pool = pool.filter(q => q.category === category);
      if (subcategory) pool = pool.filter(q => q.subcategory === subcategory);
    }
    const st = q => this.status(q, questionStats);
    if (onlyWrong || onlyUnsure) {
      pool = pool.filter(q => (onlyWrong && st(q) === "wrong") || (onlyUnsure && st(q) === "unsure"));
    }
    // 優先順: 未消化・不正解 ＞ 自信なし ＞ 正解済。同じ段の中は、過去の正答率が低い問題ほど出やすい重み付きランダム
    // （重み = 1 + 2×(1−正答率)。全敗=3、記録なし=2（正答率0.5扱い）、全勝=1。正答率はアプリの解答＋紙・模試の記録で計算）
    const tiers = [[], [], []];
    for (const q of pool) tiers[this.STATUS_ORDER[st(q)]].push(q);
    const out = [];
    for (const t of tiers) {
      if (count > 0 && out.length >= count) break;
      const need = count > 0 ? count - out.length : t.length;
      out.push(...this.weightedSample(t, need, q => 1 + 2 * (1 - this.accuracy(q, questionStats)), rng));
    }
    return out;
  },

  /** 問題の通算正答率（アプリの解答＋prior の紙・模試）。記録なしは 0.5 扱い（重みは中間） */
  accuracy(q, stats) {
    const s = stats && stats.get(q.id);
    const prior = Array.isArray(q.prior) ? q.prior : [];
    const n = (s ? s.times : 0) + prior.length;
    if (!n) return 0.5;
    const c = (s ? s.correctCount : 0) + prior.filter(p => p.correct).length;
    return c / n;
  },

  /** 重み付き非復元サンプリング。weightFn(q) > 0 */
  weightedSample(list, k, weightFn, rng = Math.random) {
    const items = list.map(q => ({ q, w: Math.max(0.01, weightFn(q)) }));
    const out = [];
    while (out.length < k && items.length) {
      let total = 0; for (const it of items) total += it.w;
      let r = rng() * total, i = 0;
      for (; i < items.length - 1; i++) { r -= items[i].w; if (r <= 0) break; }
      out.push(items.splice(i, 1)[0].q);
    }
    return out;
  },

  /**
   * 問題ID単位の解答統計を全履歴（attempts）から集計する。
   * 返値: Map(question_id -> {times, correctCount, wrongCount, lastCorrect, lastConfidence, lastTimestamp})
   */
  perQuestionStats(attempts) {
    const map = new Map();
    for (const a of attempts) {
      let s = map.get(a.question_id);
      if (!s) {
        s = { times: 0, correctCount: 0, wrongCount: 0, lastCorrect: null, lastConfidence: null, lastTimestamp: -Infinity };
        map.set(a.question_id, s);
      }
      s.times++;
      if (a.correct) s.correctCount++; else s.wrongCount++;
      if (a.timestamp >= s.lastTimestamp) {
        s.lastTimestamp = a.timestamp;
        s.lastCorrect = a.correct;
        s.lastConfidence = a.confidence;
      }
    }
    return map;
  },

  /**
   * 分野別の得意・不得意集計（全履歴ベース）。has_figure問題は出題対象外のため除外。
   * wrongNow: 直近の解答が不正解のままの問題数（＝今の苦手数）。この降順→正答率昇順で並べる。
   */
  categoryStats(questions, attempts) {
    const perQ = this.perQuestionStats(attempts);
    const byCat = new Map();
    for (const q of questions) {
      if (!Logic.usable(q)) continue;
      if (!byCat.has(q.category)) {
        byCat.set(q.category, {
          category: q.category, totalQuestions: 0, attemptedQuestions: 0,
          totalAttempts: 0, correctAttempts: 0, wrongNow: 0,
        });
      }
      const c = byCat.get(q.category);
      c.totalQuestions++;
      const s = perQ.get(q.id);
      const st = this.status(q, perQ);
      if (st !== "new") c.attemptedQuestions++;
      if (st === "wrong") c.wrongNow++;
      if (s) { c.totalAttempts += s.times; c.correctAttempts += s.correctCount; }
      else if (st !== "new") { c.totalAttempts += 1; c.correctAttempts += st === "correct" ? 1 : 0; }
    }
    const list = [...byCat.values()].map(c => ({
      ...c,
      accuracy: c.totalAttempts ? Math.round(c.correctAttempts / c.totalAttempts * 100) : null,
    }));
    list.sort((a, b) => {
      if (b.wrongNow !== a.wrongNow) return b.wrongNow - a.wrongNow;
      return (a.accuracy ?? 101) - (b.accuracy ?? 101);
    });
    return list;
  },

  /** 分野→小分類の一覧を抽出（セレクタ用） */
  categoryTree(questions) {
    const tree = new Map();
    for (const q of questions) {
      if (!tree.has(q.category)) tree.set(q.category, new Set());
      if (q.subcategory) tree.get(q.category).add(q.subcategory);
    }
    return tree;
  },

  /** セッション結果の分野別集計 */
  summarize(sessionAttempts, questionsById) {
    const total = sessionAttempts.length;
    const correct = sessionAttempts.filter(a => a.correct).length;
    const byCat = new Map();
    for (const a of sessionAttempts) {
      const q = questionsById.get(a.question_id);
      const cat = q ? q.category : "不明";
      if (!byCat.has(cat)) byCat.set(cat, { total: 0, correct: 0, time: 0 });
      const c = byCat.get(cat);
      c.total++; if (a.correct) c.correct++; c.time += a.time_sec;
    }
    return { total, correct, byCat };
  },

  /** 全履歴の簡易統計（ホーム表示用） */
  overallStats(attempts) {
    const total = attempts.length;
    const correct = attempts.filter(a => a.correct).length;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayCount = attempts.filter(a => a.timestamp >= today.getTime()).length;
    return { total, correct, rate: total ? Math.round(correct / total * 100) : 0, todayCount };
  },

  /** 自信度は「確信」「自信なし」の2択（2026-10-11）。旧データの "guess"（勘）は自信なしとして扱う */
  confidenceLabel(code) {
    return { sure: "確信", unsure: "自信なし", guess: "自信なし" }[code] || code;
  },

  /**
   * 不正解時、選んだ肢の語が解説文中のどこで説明されているかを強調表示するための検索語を作る。
   * 肢テキストから括弧書き（読み仮名等）を除いた本体を返す。
   * 強調が意味をなさない肢（正誤2択・1文字以下）は null（強調しない）。
   */
  explanationHighlightKey(choice) {
    if (typeof choice !== "string") return null;
    const t = choice.split(/[（(]/)[0].trim();
    if (t.length < 2 || t === "正しい" || t === "誤り") return null;
    return t;
  },

  /**
   * 不正解時、選んだ肢がなぜ誤りかの説明部分を解説文から抜粋する（データ改変なし・表示用）。
   * 一次: 肢番号の丸数字（①〜⑤）から次の丸数字（or 文末）までの区間。
   *       不正解時のみ呼ばれる前提のため、解説冒頭の「正答は◯…」の丸数字は正答肢の番号であり
   *       選んだ肢の番号とは一致せず誤ヒットしない。
   * 二次: 丸数字が無い解説では、肢の語（括弧書き除去）を含む最初の文。
   * どちらも見つからなければ null（抜粋表示なし＝従来表示のみ）。
   */
  choiceExplanationExcerpt(explanation, choiceIndex, choiceText) {
    if (typeof explanation !== "string" || !explanation) return null;
    const marks = ["①", "②", "③", "④", "⑤"];
    const mark = marks[choiceIndex];
    if (mark) {
      const i = explanation.indexOf(mark);
      if (i >= 0) {
        let end = explanation.length;
        for (const m of marks) {
          if (m === mark) continue;
          const j = explanation.indexOf(m, i + 1);
          if (j >= 0 && j < end) end = j;
        }
        const seg = explanation.slice(i, end).trim().replace(/[、\s]+$/, "");
        if (seg.length >= 4) return seg;
      }
    }
    const key = this.explanationHighlightKey(choiceText);
    if (key) {
      const k = explanation.indexOf(key);
      if (k >= 0) {
        const start = explanation.lastIndexOf("。", k) + 1;
        let end = explanation.indexOf("。", k);
        end = end < 0 ? explanation.length : end + 1;
        const seg = explanation.slice(start, end).trim();
        if (seg.length >= 4) return seg;
      }
    }
    return null;
  },
  // ===================== P2/P3: 模試・ダッシュボード・弱点集中・SRS =====================

  /**
   * CBT本番の規格（協会公表: 36問・120分）。問題集データは1大問を空欄ごとに分解しているため
   * （実データ215大問中204が4空欄）、アプリ内の1問＝1空欄として 36×4＝144単位を本番相当とする。
   */
  MOCK: { fullProblems: 36, unitsPerProblem: 4, fullMinutes: 120 },

  /** 模試プリセット。secPerQ は本番の 120分/144単位 = 50秒 で全プリセット共通 */
  mockPresets() {
    const m = this.MOCK;
    const fullCount = m.fullProblems * m.unitsPerProblem;
    const secPerQ = Math.round(m.fullMinutes * 60 / fullCount);
    const mk = (key, label, count) => ({ key, label, count, minutes: Math.round(count * secPerQ / 60), secPerQ });
    return [
      mk("full", "本番相当", fullCount),
      mk("half", "ハーフ", fullCount / 2),
      mk("quick", "クイック", fullCount / 4),
    ];
  },

  /** 本番の1問あたり時間予算（秒）。解答時間分布の「超過」判定にも使う */
  mockSecPerQuestion() { return this.mockPresets()[0].secPerQ; },

  /**
   * 模試セット: 分野構成比を問題バンクの収録比に合わせた層化抽出（出題配分の近似）。
   * 各分野の割当は比例配分→端数は大きい順に配る。分野内は出題回数の少ない問題を優先し、同回数内はランダム。
   */
  buildMockSet(questions, count, questionStats, rng = Math.random) {
    const pool = questions.filter(q => Logic.usable(q));
    if (count <= 0 || count >= pool.length) return this.shuffle(pool, rng);
    const byCat = new Map();
    for (const q of pool) {
      if (!byCat.has(q.category)) byCat.set(q.category, []);
      byCat.get(q.category).push(q);
    }
    const cats = [...byCat.entries()].map(([cat, qs]) => {
      const exact = count * qs.length / pool.length;
      return { cat, qs, exact, n: Math.floor(exact) };
    });
    let rest = count - cats.reduce((s, c) => s + c.n, 0);
    cats.sort((a, b) => (b.exact - b.n) - (a.exact - a.n));
    for (const c of cats) { if (rest <= 0) break; if (c.n < c.qs.length) { c.n++; rest--; } }
    let out = [];
    for (const c of cats) {
      let qs = this.shuffle(c.qs, rng);
      if (questionStats) qs.sort((a, b) => (questionStats.get(a.id)?.times || 0) - (questionStats.get(b.id)?.times || 0));
      out = out.concat(qs.slice(0, c.n));
    }
    return this.shuffle(out, rng);
  },

  /**
   * 模試の採点。answers: [{question_id, choice(null=未解答), time_sec}]
   * 未解答は不正解扱い（本番同様）。返値は attempts（DB保存形式）＋集計。
   */
  gradeMock(list, answers, sessionId, timestamp) {
    const attempts = list.map((q, i) => {
      const a = answers[i] || {};
      const skipped = a.choice === null || a.choice === undefined;
      return {
        question_id: q.id, timestamp: timestamp + i, // 同一模試内で順序が保てるよう1ms刻み
        correct: !skipped && a.choice === q.answer,
        time_sec: a.time_sec || 0,
        confidence: null, mode: "mock", session_id: sessionId,
        choice: skipped ? null : a.choice, skipped,
      };
    });
    const correct = attempts.filter(a => a.correct).length;
    return { attempts, total: list.length, correct, skipped: attempts.filter(a => a.skipped).length,
      rate: list.length ? Math.round(correct / list.length * 100) : 0,
      timeSec: attempts.reduce((s, a) => s + a.time_sec, 0) };
  },

  /** 模試の時系列（ダッシュボード「正答率推移」用）。attempts の mode==="mock" を session_id で束ねる */
  mockSeries(attempts) {
    const map = new Map();
    for (const a of attempts) {
      if (a.mode !== "mock" || !a.session_id) continue;
      let s = map.get(a.session_id);
      if (!s) { s = { session_id: a.session_id, timestamp: a.timestamp, total: 0, correct: 0, timeSec: 0 }; map.set(a.session_id, s); }
      s.total++; if (a.correct) s.correct++; s.timeSec += a.time_sec || 0;
      if (a.timestamp < s.timestamp) s.timestamp = a.timestamp;
    }
    return [...map.values()].map(s => ({ ...s, rate: s.total ? Math.round(s.correct / s.total * 100) : 0 }))
      .sort((a, b) => a.timestamp - b.timestamp);
  },

  // ---- SRS（SM-2簡易版。状態は保存せず全履歴から再生する＝DBスキーマ変更なし） ----

  /** 解答→SM-2品質(0〜5)。確信誤答=0（誤知識の定着）、自信なしの誤答=1、正解は確信5/自信なし4（旧「勘」3）、模試（自信度なし）正解=4 */
  srsQuality(a) {
    if (!a.correct) return a.confidence === "sure" ? 0 : 1;
    return { sure: 5, unsure: 4, guess: 3 }[a.confidence] ?? 4;
  },

  /**
   * 問題ごとの SRS 状態を履歴から再生する。
   * 返値: Map(question_id -> {reps, interval(日), ease, nextDue(ms), lastTimestamp})
   */
  srsStates(attempts) {
    const DAY = 86400000;
    const sorted = attempts.slice().sort((a, b) => a.timestamp - b.timestamp);
    const map = new Map();
    for (const a of sorted) {
      let s = map.get(a.question_id);
      if (!s) { s = { reps: 0, interval: 0, ease: 2.5, nextDue: 0, lastTimestamp: 0 }; map.set(a.question_id, s); }
      const q = this.srsQuality(a);
      if (q < 3) { s.reps = 0; s.interval = 1; }
      else {
        s.reps++;
        s.interval = s.reps === 1 ? 1 : s.reps === 2 ? 6 : Math.round(s.interval * s.ease);
      }
      s.ease = Math.max(1.3, s.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
      s.lastTimestamp = a.timestamp;
      s.nextDue = a.timestamp + s.interval * DAY;
    }
    return map;
  },

  /** 本日復習すべき問題（nextDue到来）。期限超過が大きい順。has_figure は除外 */
  srsDueQuestions(questions, attempts, now = Date.now()) {
    const states = this.srsStates(attempts);
    return questions.filter(q => Logic.usable(q) && states.has(q.id) && states.get(q.id).nextDue <= now)
      .sort((a, b) => states.get(a.id).nextDue - states.get(b.id).nextDue);
  },

  // ---- ダッシュボード集計 ----

  /** 問題ごとの最新解答（timestamp最大）。模試・演習を区別しない */
  latestAttempts(attempts) {
    const map = new Map();
    for (const a of attempts) {
      const cur = map.get(a.question_id);
      if (!cur || a.timestamp >= cur.timestamp) map.set(a.question_id, a);
    }
    return map;
  },

  /**
   * 自信度×正誤マトリクス。4象限は「自信度付きの最新解答」（演習）で判定する。
   * 模試は自信度を記録しないため、模試で直近解答していても演習時の自信度判定を保持する
   * （模試全問受験でマトリクスが空になるのを防ぐ）。演習履歴が無く模試のみの問題は noConf* に分ける。
   * sureWrong=確信誤答（最優先）、guessCorrect=勘・迷いで正解（実質未習得）。各象限に問題IDを持つ。
   */
  confidenceMatrix(questions, attempts) {
    const latestConf = this.latestAttempts(attempts.filter(a => a.confidence));
    const latestAny = this.latestAttempts(attempts);
    const m = { sureCorrect: [], guessCorrect: [], sureWrong: [], guessWrong: [], noConfCorrect: [], noConfWrong: [] };
    for (const q of questions) {
      if (!Logic.usable(q)) continue;
      const a = latestConf.get(q.id);
      if (a) {
        if (a.confidence === "sure") (a.correct ? m.sureCorrect : m.sureWrong).push(q.id);
        else (a.correct ? m.guessCorrect : m.guessWrong).push(q.id);
        continue;
      }
      const b = latestAny.get(q.id);
      if (b) (b.correct ? m.noConfCorrect : m.noConfWrong).push(q.id);
    }
    return m;
  },

  /**
   * 分野×小分類ヒートマップ行。各行: total, attempted, accuracy(全解答), latestAccuracy(最新解答の正答率),
   * wrongNow, sureWrong, avgTime, priority（弱点優先度スコア）。
   * 優先度 = (1 − 最新正答率) × (1 + 確信誤答率) × 出題頻度重み。
   * 出題頻度重みは分野の収録問題数シェア÷平均シェア（問題集の収録配分を例年の出題配分の近似とする）。
   * 未着手の小分類は最新正答率を0.5（未知）として中位に置く。
   */
  heatmapRows(questions, attempts) {
    const usable = questions.filter(q => Logic.usable(q));
    const perQ = this.perQuestionStats(attempts);
    const latest = this.latestAttempts(attempts);
    const catCount = new Map();
    for (const q of usable) catCount.set(q.category, (catCount.get(q.category) || 0) + 1);
    const meanShare = catCount.size ? 1 / catCount.size : 1;
    const rows = new Map();
    for (const q of usable) {
      const key = q.category + "\u0000" + (q.subcategory || "");
      if (!rows.has(key)) rows.set(key, { category: q.category, subcategory: q.subcategory || "", total: 0, attempted: 0,
        attemptsN: 0, correctN: 0, latestCorrect: 0, wrongNow: 0, sureWrong: 0, timeSum: 0, timeN: 0 });
      const r = rows.get(key);
      r.total++;
      const st = this.status(q, perQ);
      if (st === "new") continue;
      r.attempted++;
      const s = perQ.get(q.id);
      if (s) { r.attemptsN += s.times; r.correctN += s.correctCount; }
      else { r.attemptsN += 1; r.correctN += st === "correct" ? 1 : 0; }
      if (st === "wrong") { r.wrongNow++; const a = latest.get(q.id); if (a && a.confidence === "sure") r.sureWrong++; }
      else r.latestCorrect++;
    }
    const keyOf = new Map(usable.map(q => [q.id, q.category + "\u0000" + (q.subcategory || "")]));
    for (const a of attempts) {
      const r = rows.get(keyOf.get(a.question_id));
      if (!r) continue;
      if (typeof a.time_sec === "number") { r.timeSum += a.time_sec; r.timeN++; }
    }
    const out = [...rows.values()].map(r => {
      const weight = (catCount.get(r.category) / usable.length) / meanShare;
      const latestAcc = r.attempted ? r.latestCorrect / r.attempted : 0.5;
      const sureWrongRate = r.attempted ? r.sureWrong / r.attempted : 0;
      return { ...r,
        accuracy: r.attemptsN ? Math.round(r.correctN / r.attemptsN * 100) : null,
        latestAccuracy: r.attempted ? Math.round(latestAcc * 100) : null,
        avgTime: r.timeN ? Math.round(r.timeSum / r.timeN) : null,
        weight: Math.round(weight * 100) / 100,
        priority: Math.round((1 - latestAcc) * (1 + sureWrongRate) * weight * 100) / 100,
      };
    });
    out.sort((a, b) => b.priority - a.priority || a.category.localeCompare(b.category, "ja"));
    return out;
  },

  /** ヒートマップ色階調（0〜4、null=未着手→-1）。閾値: <50 / <65 / <75 / <85 / ≥85 */
  heatLevel(acc) {
    if (acc === null || acc === undefined) return -1;
    return acc < 50 ? 0 : acc < 65 ? 1 : acc < 75 ? 2 : acc < 85 ? 3 : 4;
  },

  /**
   * 弱点集中モードの出題セット。
   * 問題スコア = 小分類の優先度 + 個別事情（確信誤答 +1.5／その他誤答 +1.0／自信なし正解 +0.5／未着手 +0.3／確信正解 0）。
   * 同点はランダム。count 0 は全問。
   */
  buildWeakSet(questions, attempts, count, rng = Math.random) {
    const rows = this.heatmapRows(questions, attempts);
    const prio = new Map(rows.map(r => [r.category + "\u0000" + r.subcategory, r.priority]));
    const latest = this.latestAttempts(attempts);
    const perQ = this.perQuestionStats(attempts);
    const scored = this.shuffle(questions.filter(q => Logic.usable(q)), rng).map(q => {
      const a = latest.get(q.id);
      const st = this.status(q, perQ);
      let bonus = 0.3;                                        // 未消化
      if (st === "wrong") bonus = (a && a.confidence === "sure") ? 1.5 : (a ? 1.0 : (this.paperMark(q) === "xx" ? 1.2 : 0.9));
      else if (st === "unsure") bonus = 0.5;
      else if (st === "correct") bonus = a ? 0 : 0.2;        // 模試・紙で正解のみ（アプリ未解答）は少し残す
      return { q, score: (prio.get(q.category + "\u0000" + (q.subcategory || "")) || 0) + bonus };
    });
    scored.sort((a, b) => b.score - a.score);
    const list = scored.map(x => x.q);
    return count > 0 ? list.slice(0, count) : list;
  },

  /**
   * 解答時間分布（分野別）。budgetSec を超えた解答の割合（overRate）と、正解なのに超過した割合（correctOverRate）。
   * 「正解でも時間超過傾向」＝CBT時間管理上の要注意分野。
   */
  timeDistribution(questions, attempts, budgetSec) {
    const catOf = new Map(questions.filter(q => Logic.usable(q)).map(q => [q.id, q.category]));
    const byCat = new Map();
    for (const a of attempts) {
      const cat = catOf.get(a.question_id);
      if (!cat || typeof a.time_sec !== "number") continue;
      if (!byCat.has(cat)) byCat.set(cat, { category: cat, n: 0, timeSum: 0, over: 0, correctOver: 0, correct: 0 });
      const c = byCat.get(cat);
      c.n++; c.timeSum += a.time_sec;
      if (a.time_sec > budgetSec) { c.over++; if (a.correct) c.correctOver++; }
      if (a.correct) c.correct++;
    }
    return [...byCat.values()].map(c => ({ ...c,
      avgTime: Math.round(c.timeSum / c.n),
      overRate: Math.round(c.over / c.n * 100),
      correctOverRate: c.correct ? Math.round(c.correctOver / c.correct * 100) : 0,
    })).sort((a, b) => b.overRate - a.overRate || b.avgTime - a.avgTime);
  },

  /** 日別正答率（直近 days 日、解答があった日のみ）。演習・模試を含む */
  dailyAccuracy(attempts, days = 14, now = Date.now()) {
    const from = new Date(now); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - (days - 1));
    const map = new Map();
    for (const a of attempts) {
      if (a.timestamp < from.getTime()) continue;
      const d = new Date(a.timestamp);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (!map.has(key)) map.set(key, { date: key, total: 0, correct: 0 });
      const r = map.get(key); r.total++; if (a.correct) r.correct++;
    }
    return [...map.values()].map(r => ({ ...r, rate: Math.round(r.correct / r.total * 100) }))
      .sort((a, b) => a.date.localeCompare(b.date));
  },

  /**
   * 外部の解答結果（問題データ同梱の prior: [{source:"paper"|"mock", correct, ...}] 古い順）の直近1件。
   * prior が無い旧データでは paper_results（○×）から組み立てる。無ければ null
   */
  priorOutcome(q) {
    if (Array.isArray(q.prior) && q.prior.length) return q.prior[q.prior.length - 1];
    const pr = (q.paper_results || []).filter(m => m === "○" || m === "×");
    return pr.length ? { source: "paper", correct: pr[pr.length - 1] === "○" } : null;
  },

  /**
   * 問題の学習状態（出題優先順の基礎）。アプリの解答があればそれを最優先、無ければ外部結果（模試・紙）。
   *   "wrong"   直近の結果が不正解
   *   "new"     記録なし（未消化）
   *   "unsure"  アプリで自信なしで正解（実質未習得）
   *   "correct" 正解（確信、または模試・紙で正解）
   */
  status(q, stats) {
    const s = stats && stats.get(q.id);
    if (s) {
      if (s.lastCorrect === false) return "wrong";
      if (s.lastConfidence === "unsure" || s.lastConfidence === "guess") return "unsure";
      return "correct";
    }
    const p = this.priorOutcome(q);
    if (!p) return "new";
    return p.correct ? "correct" : "wrong";
  },

  /** 出題優先順（RF指示 2026-10-11）: 未消化・不正解（紙・模試・アプリを区別しない）＞ 自信なし ＞ 正解済 */
  STATUS_ORDER: { wrong: 0, new: 0, unsure: 1, correct: 2 },

  /** 紙演習の手書き○×（paper_results）を要約: "xx"=直近2周とも×, "x"=直近×, "o"=直近○, null=記録なし */
  paperMark(q) {
    const pr = (q.paper_results || []).filter(m => m === "○" || m === "×");
    if (!pr.length) return null;
    if (pr[pr.length - 1] === "×") return pr.length >= 2 && pr[pr.length - 2] === "×" ? "xx" : "x";
    return "o";
  },

  /** 分野別の紙演習統計 Map(category -> {marked, latestX, xx}) */
  paperStats(questions) {
    const map = new Map();
    for (const q of questions) {
      if (!Logic.usable(q)) continue;
      const pm = this.paperMark(q);
      if (!pm) continue;
      if (!map.has(q.category)) map.set(q.category, { marked: 0, latestX: 0, xx: 0 });
      const c = map.get(q.category);
      c.marked++; if (pm !== "o") c.latestX++; if (pm === "xx") c.xx++;
    }
    return map;
  },

  /**
   * 傾向サマリー（ホーム上部に簡潔表示するための集計）。
   * - coverage: 着手率、latestMock/prevMock: 直近2回の模試、passGap: 合格ライン70%までの差（ポイント）
   * - week/prevWeek: 直近7日と前7日の正答率（演習＋模試）
   * - priorities: 分野別の優先度上位3（アプリの最新正答率・確信誤答・紙演習×率・出題配分から算出）
   * - sureWrong: 確信誤答の問題数、due: 本日のSRS復習数
   */
  trendSummary(questions, attempts, now = Date.now()) {
    const DAY = 86400000;
    const usable = questions.filter(q => Logic.usable(q));
    const perQ = this.perQuestionStats(attempts);
    const mocks = this.mockSeries(attempts);
    const latestMock = mocks[mocks.length - 1] || null;
    const prevMock = mocks[mocks.length - 2] || null;
    const win = (from, to) => {
      const a = attempts.filter(x => x.timestamp >= from && x.timestamp < to);
      return { n: a.length, rate: a.length ? Math.round(a.filter(x => x.correct).length / a.length * 100) : null };
    };
    const week = win(now - 7 * DAY, now + 1), prevWeek = win(now - 14 * DAY, now - 7 * DAY);
    const rows = this.heatmapRows(questions, attempts);
    const paper = this.paperStats(questions);
    const byCat = new Map();
    for (const r of rows) {
      if (!byCat.has(r.category)) byCat.set(r.category, { category: r.category, total: 0, attempted: 0, latestCorrect: 0, sureWrong: 0, weight: r.weight });
      const c = byCat.get(r.category);
      c.total += r.total; c.attempted += r.attempted; c.latestCorrect += r.latestCorrect; c.sureWrong += r.sureWrong;
    }
    const priorities = [...byCat.values()].map(c => {
      const p = paper.get(c.category);
      const appAcc = c.attempted ? c.latestCorrect / c.attempted : null;
      const paperX = p ? p.latestX / p.marked : null;
      // 弱さ = アプリ最新誤答率と紙×率の平均（片方しか無ければその値、両方無ければ0.5）
      const vals = [appAcc === null ? null : 1 - appAcc, paperX].filter(v => v !== null);
      const weakness = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0.5;
      const sureWrongRate = c.attempted ? c.sureWrong / c.attempted : 0;
      const reasons = [];
      if (appAcc !== null) reasons.push(`アプリ正答率${Math.round(appAcc * 100)}%`);
      if (paperX !== null) reasons.push(`紙×率${Math.round(paperX * 100)}%`);
      if (c.sureWrong) reasons.push(`確信誤答${c.sureWrong}問`);
      if (!reasons.length) reasons.push("未着手");
      return { category: c.category, score: Math.round(weakness * (1 + sureWrongRate) * c.weight * 100) / 100, appAccuracy: appAcc === null ? null : Math.round(appAcc * 100), paperXRate: paperX === null ? null : Math.round(paperX * 100), sureWrong: c.sureWrong, weight: c.weight, reasons };
    }).sort((a, b) => b.score - a.score);
    const m = this.confidenceMatrix(questions, attempts);
    const attempted = usable.filter(q => this.status(q, perQ) !== "new").length; // 模試・紙の結果も着手に含める
    return {
      total: usable.length, attempted,
      coverage: usable.length ? Math.round(attempted / usable.length * 100) : 0,
      latestMock, prevMock,
      passGap: latestMock ? 70 - latestMock.rate : null,
      week, prevWeek,
      priorities: priorities.slice(0, 3),
      sureWrong: m.sureWrong.length, guessCorrect: m.guessCorrect.length,
      due: this.srsDueQuestions(questions, attempts, now).length,
    };
  },

  fmtClock(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + ":" + String(s).padStart(2, "0");
  },
};

/* node テスト用 */
if (typeof module !== "undefined" && module.exports) module.exports = Logic;
