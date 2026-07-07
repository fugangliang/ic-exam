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
   */
  buildQuizSet(questions, { mode, category, subcategory, count }, rng = Math.random) {
    let pool = questions.filter(q => !q.has_figure);
    if (mode === "category" && category) {
      pool = pool.filter(q => q.category === category);
      if (subcategory) pool = pool.filter(q => q.subcategory === subcategory);
    }
    pool = this.shuffle(pool, rng);
    return count > 0 ? pool.slice(0, count) : pool;
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
