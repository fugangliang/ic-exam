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

console.log("all logic tests passed");
