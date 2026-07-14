/* 純粋ロジック（DOM・DB非依存。node でテスト可能） */

const Logic = {

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
   * 出題セットを構築。mode: "random" | "category"
   * count 0 は全問。図版問題（has_figure）は P1 では除外。
   * onlyWrong/onlyUnsure: questionStats（perQuestionStats の返値）を使い、
   * 直近の解答が不正解／自信度が「迷い」「勘」だった問題のみに絞り込む（未解答は対象外）。
   * 絞り込み時は該当問題を間違えた回数（wrongCount）が多い順に優先する。
   * 絞り込みなしの場合は、questionStats があれば出題回数（times）が少ない問題を優先し、
   * ランダム出題の偏り（同じ問題ばかり出る）を防いでまんべんなく出題する。
   */
  buildQuizSet(questions, { mode, category, subcategory, count, onlyWrong, onlyUnsure, questionStats }, rng = Math.random) {
    let pool = questions.filter(q => !q.has_figure);
    if (mode === "category" && category) {
      pool = pool.filter(q => q.category === category);
      if (subcategory) pool = pool.filter(q => q.subcategory === subcategory);
    }
    if (onlyWrong || onlyUnsure) {
      pool = pool.filter(q => {
        const s = questionStats && questionStats.get(q.id);
        if (!s) return false;
        return (onlyWrong && s.lastCorrect === false) ||
               (onlyUnsure && (s.lastConfidence === "unsure" || s.lastConfidence === "guess"));
      });
    }
    pool = this.shuffle(pool, rng);
    if (onlyWrong || onlyUnsure) {
      if (questionStats) pool.sort((a, b) => questionStats.get(b.id).wrongCount - questionStats.get(a.id).wrongCount);
    } else if (questionStats) {
      // 絞り込みなしの通常出題では、出題回数が少ない問題（未出題含む）を優先し偏りを防ぐ
      pool.sort((a, b) => (questionStats.get(a.id)?.times || 0) - (questionStats.get(b.id)?.times || 0));
    }
    return count > 0 ? pool.slice(0, count) : pool;
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
      if (q.has_figure) continue;
      if (!byCat.has(q.category)) {
        byCat.set(q.category, {
          category: q.category, totalQuestions: 0, attemptedQuestions: 0,
          totalAttempts: 0, correctAttempts: 0, wrongNow: 0,
        });
      }
      const c = byCat.get(q.category);
      c.totalQuestions++;
      const s = perQ.get(q.id);
      if (s) {
        c.attemptedQuestions++;
        c.totalAttempts += s.times;
        c.correctAttempts += s.correctCount;
        if (s.lastCorrect === false) c.wrongNow++;
      }
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

  confidenceLabel(code) {
    return { sure: "確信", unsure: "迷い", guess: "勘" }[code] || code;
  },
};

/* node テスト用 */
if (typeof module !== "undefined" && module.exports) module.exports = Logic;
