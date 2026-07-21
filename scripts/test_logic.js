/* logic.js の単体テスト。実行: node scripts/test_logic.js */
const Logic = require("../app/logic.js");
const assert = require("node:assert");

const q = (id, cat, sub, extra = {}) => ({
  id, category: cat, subcategory: sub, source: "test",
  body: "本文", choices: ["a", "b", "c", "d"], answer: 0,
  explanation: "解説", has_figure: false, ...extra,
});

// validateQuestion
assert.deepStrictEqual(Logic.validateQuestion(q("1", "法規", "建基法")), []);
assert.ok(Logic.validateQuestion({}).length > 0);
assert.ok(Logic.validateQuestion(q("1", "法規", "s", { answer: 4 })).some(e => e.includes("answer")));
assert.ok(Logic.validateQuestion(q("1", "法規", "s", { choices: ["only"] })).some(e => e.includes("choices")));
assert.ok(Logic.validateQuestion(q("", "法規", "s")).some(e => e.includes("id")));

// normalizeImport: 配列形式
let r = Logic.normalizeImport([q("1", "A", "x"), q("2", "B", "y")]);
assert.strictEqual(r.questions.length, 2);
assert.strictEqual(r.attempts, null);
assert.strictEqual(r.errors.length, 0);

// normalizeImport: id重複はスキップ
r = Logic.normalizeImport([q("1", "A", "x"), q("1", "A", "x")]);
assert.strictEqual(r.questions.length, 1);
assert.strictEqual(r.errors.length, 1);

// normalizeImport: {questions, attempts} フルバックアップ形式
r = Logic.normalizeImport({ questions: [q("1", "A", "x")], attempts: [{ question_id: "1", timestamp: 1, correct: true, time_sec: 5, confidence: "sure" }] });
assert.strictEqual(r.questions.length, 1);
assert.strictEqual(r.attempts.length, 1);

// normalizeImport: 不正形式
r = Logic.normalizeImport("garbage");
assert.strictEqual(r.questions.length, 0);
assert.ok(r.errors.length > 0);

// buildQuizSet: 図版除外・分野/小分類フィルタ・件数制限
const pool = [
  q("1", "法規", "建基法"), q("2", "法規", "消防法"),
  q("3", "歴史", "様式"), q("4", "法規", "建基法", { has_figure: true }),
];
const rng = () => 0.5;
assert.strictEqual(Logic.buildQuizSet(pool, { mode: "random", count: 0 }, rng).length, 3); // 図版除外
assert.strictEqual(Logic.buildQuizSet(pool, { mode: "category", category: "法規", subcategory: "", count: 0 }, rng).length, 2);
assert.strictEqual(Logic.buildQuizSet(pool, { mode: "category", category: "法規", subcategory: "建基法", count: 0 }, rng).length, 1);
assert.strictEqual(Logic.buildQuizSet(pool, { mode: "random", count: 2 }, rng).length, 2);

// shuffle: 元配列を破壊しない・要素保存
const orig = [1, 2, 3, 4, 5];
const shuffled = Logic.shuffle(orig);
assert.deepStrictEqual(orig, [1, 2, 3, 4, 5]);
assert.deepStrictEqual(shuffled.slice().sort(), [1, 2, 3, 4, 5]);

// categoryTree
const tree = Logic.categoryTree(pool);
assert.deepStrictEqual([...tree.get("法規")], ["建基法", "消防法"]);

// summarize
const byId = new Map(pool.map(x => [x.id, x]));
const s = Logic.summarize([
  { question_id: "1", correct: true, time_sec: 10 },
  { question_id: "2", correct: false, time_sec: 20 },
  { question_id: "3", correct: true, time_sec: 30 },
], byId);
assert.strictEqual(s.total, 3);
assert.strictEqual(s.correct, 2);
assert.strictEqual(s.byCat.get("法規").total, 2);
assert.strictEqual(s.byCat.get("法規").correct, 1);

// overallStats
const now = Date.now();
const st = Logic.overallStats([
  { correct: true, timestamp: now },
  { correct: false, timestamp: now - 86400000 * 3 },
]);
assert.strictEqual(st.total, 2);
assert.strictEqual(st.rate, 50);
assert.strictEqual(st.todayCount, 1);

// perQuestionStats: 全履歴を蓄積し、最新の解答（timestamp最大）を lastCorrect/lastConfidence に反映
const pq = Logic.perQuestionStats([
  { question_id: "1", correct: true, timestamp: 100, confidence: "sure" },
  { question_id: "1", correct: false, timestamp: 200, confidence: "guess" },
  { question_id: "2", correct: true, timestamp: 150, confidence: "unsure" },
]);
assert.strictEqual(pq.get("1").times, 2);
assert.strictEqual(pq.get("1").correctCount, 1);
assert.strictEqual(pq.get("1").wrongCount, 1);
assert.strictEqual(pq.get("1").lastCorrect, false);
assert.strictEqual(pq.get("1").lastConfidence, "guess");
assert.strictEqual(pq.get("2").lastCorrect, true);
assert.strictEqual(pq.get("3"), undefined);

// categoryStats: 分野別に全履歴の正答率と「直近不正解」件数を集計し、苦手（wrongNow多い）順に並べる
const csPool = [q("1", "法規", "建基法"), q("2", "法規", "消防法"), q("3", "歴史", "様式")];
const cs = Logic.categoryStats(csPool, [
  { question_id: "1", correct: false, timestamp: 1, confidence: "guess" },
  { question_id: "1", correct: false, timestamp: 2, confidence: "guess" },
  { question_id: "2", correct: true, timestamp: 1, confidence: "sure" },
]);
const lawStats = cs.find(c => c.category === "法規");
assert.strictEqual(lawStats.totalQuestions, 2);
assert.strictEqual(lawStats.attemptedQuestions, 2);
assert.strictEqual(lawStats.wrongNow, 1);
assert.strictEqual(lawStats.accuracy, 33);
const historyStats = cs.find(c => c.category === "歴史");
assert.strictEqual(historyStats.attemptedQuestions, 0);
assert.strictEqual(historyStats.accuracy, null);
assert.strictEqual(cs[0].category, "法規"); // wrongNowが多い分野が先頭

// buildQuizSet: onlyWrong/onlyUnsure で直近解答に基づき抽出（未解答は対象外）
const qStats = Logic.perQuestionStats([
  { question_id: "1", correct: false, timestamp: 1, confidence: "guess" },
  { question_id: "2", correct: true, timestamp: 1, confidence: "sure" },
  { question_id: "3", correct: true, timestamp: 1, confidence: "unsure" },
]);
const wrongSet = Logic.buildQuizSet(pool, { mode: "random", count: 0, onlyWrong: true, questionStats: qStats }, rng);
assert.strictEqual(wrongSet.length, 1);
assert.strictEqual(wrongSet[0].id, "1");
// onlyUnsure は「迷い」「勘」の両方を対象とする（id1=勘で不正解、id3=迷いで正解、の2件がヒット）
const unsureSet = Logic.buildQuizSet(pool, { mode: "random", count: 0, onlyUnsure: true, questionStats: qStats }, rng);
assert.strictEqual(unsureSet.length, 2);
assert.deepStrictEqual(unsureSet.map(q => q.id).sort(), ["1", "3"]);
const noneSet = Logic.buildQuizSet(pool, { mode: "random", count: 0, onlyWrong: true, onlyUnsure: true, questionStats: new Map() }, rng);
assert.strictEqual(noneSet.length, 0); // 統計が空なら全問未解答扱いで対象外

// buildQuizSet: 絞り込みなしでも questionStats があれば出題回数の少ない問題を優先（偏り防止）
const freqStats = Logic.perQuestionStats([
  { question_id: "1", correct: true, timestamp: 1, confidence: "sure" },
  { question_id: "1", correct: true, timestamp: 2, confidence: "sure" },
  { question_id: "1", correct: true, timestamp: 3, confidence: "sure" },
  { question_id: "2", correct: true, timestamp: 1, confidence: "sure" },
  // id "3" は未出題（questionStatsに存在しない） → times=0扱いで最優先
]);
const balanced = Logic.buildQuizSet(pool, { mode: "random", count: 2, questionStats: freqStats }, rng);
assert.deepStrictEqual(balanced.map(q => q.id).sort(), ["2", "3"]); // 出題0〜1回の2問が、3回出題済みの"1"より優先される

// explanationHighlightKey: 括弧書き（読み仮名等）を除いた本体を返す
assert.strictEqual(Logic.explanationHighlightKey("卓袱台（ちゃぶだい）"), "卓袱台");
assert.strictEqual(Logic.explanationHighlightKey("箱膳"), "箱膳");
assert.strictEqual(Logic.explanationHighlightKey("ウィンドウトリートメント"), "ウィンドウトリートメント");
// 正誤2択・1文字以下・非文字列は強調対象外（null）
assert.strictEqual(Logic.explanationHighlightKey("正しい"), null);
assert.strictEqual(Logic.explanationHighlightKey("誤り"), null);
assert.strictEqual(Logic.explanationHighlightKey("木"), null);
assert.strictEqual(Logic.explanationHighlightKey(null), null);
assert.strictEqual(Logic.explanationHighlightKey("（注記のみ）"), null);

// choiceExplanationExcerpt: 丸数字パターン（選んだ肢②の説明区間を、次の丸数字の手前まで抜粋）
const expText = "正答は③無垢材。框戸は框組に鏡板をはめ込んだ構造の戸。①構造用合板は耐力部材として使用できる合板。②縁甲板は長手方向の側面に実はぎ加工が施された長尺の板。床材のほか壁や天井にも用いる。";
assert.strictEqual(
  Logic.choiceExplanationExcerpt(expText, 1, "縁甲板"),
  "②縁甲板は長手方向の側面に実はぎ加工が施された長尺の板。床材のほか壁や天井にも用いる。");
assert.strictEqual(
  Logic.choiceExplanationExcerpt(expText, 0, "構造用合板"),
  "①構造用合板は耐力部材として使用できる合板。");
// 丸数字が無い解説では、肢の語（括弧書き除去）を含む文を抜粋
const expPlain = "鴨居は開口部の上側の部材。長押（なげし）は柱の上部を水平につなぐ化粧材である。敷居は下側の部材。";
assert.strictEqual(
  Logic.choiceExplanationExcerpt(expPlain, 0, "長押（なげし）"),
  "長押（なげし）は柱の上部を水平につなぐ化粧材である。");
// 該当なし・正誤2択・空解説は null（抜粋表示なし）
assert.strictEqual(Logic.choiceExplanationExcerpt(expPlain, 2, "回り縁"), null);
assert.strictEqual(Logic.choiceExplanationExcerpt("この記述は誤りである。", 0, "誤り"), null);
assert.strictEqual(Logic.choiceExplanationExcerpt("", 1, "縁甲板"), null);
assert.strictEqual(Logic.choiceExplanationExcerpt(null, 1, "縁甲板"), null);

console.log("all logic tests passed");
