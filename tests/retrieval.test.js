// Run from the project root:  node --test tests/retrieval.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../public/retrieval.js");

const chunks = [
  { docId: "a", filename: "policy.txt", page: 0, chunk: 0, text: "Refund policy: customers may request a refund within thirty days of purchase." },
  { docId: "a", filename: "policy.txt", page: 0, chunk: 1, text: "Shipping policy: standard shipping takes five to seven business days." },
  { docId: "a", filename: "policy.txt", page: 0, chunk: 2, text: "Warranty: every product includes a one year limited warranty for defects." },
  { docId: "b", filename: "handbook.pdf", page: 2, chunk: 0, text: "Remote work is allowed on Fridays with manager approval." },
];
const index = R.buildIndex(chunks);

test("tokenize drops stop words, punctuation and applies light stemming", () => {
  assert.deepEqual(R.tokenize("The Refunds, were REFUNDED!"), ["refund", "refund"]);
  assert.deepEqual(R.tokenize("What is the policy?"), ["policy"]);
  assert.deepEqual(R.tokenize("Café Zürich 2024"), ["cafe", "zurich", "2024"]);
});

test("ranks the most relevant chunk first and scores are 0..1", () => {
  const hits = R.search(index, "How do I get a refund?", 3);
  assert.equal(hits[0].chunk, 0);
  assert.equal(hits[0].filename, "policy.txt");
  assert.equal(hits[0].score, 1);
  assert.ok(hits.every((h) => h.score > 0 && h.score <= 1));
});

test("stemming lets plural and verb forms match", () => {
  assert.equal(R.search(index, "refunds", 1)[0].chunk, 0);
  assert.equal(R.search(index, "working remotely on fridays", 1)[0].docId, "b");
});

test("returns page info and respects k", () => {
  const hit = R.search(index, "manager approval", 5)[0];
  assert.equal(hit.page, 2);
  assert.ok(R.search(index, "policy", 1).length === 1);
});

test("no match, empty query and empty index return nothing", () => {
  assert.deepEqual(R.search(index, "quantum physics", 3), []);
  assert.deepEqual(R.search(index, "the and of", 3), []);
  assert.deepEqual(R.search(R.buildIndex([]), "refund", 3), []);
  assert.deepEqual(R.search(null, "refund", 3), []);
});

test("rarer words weigh more than common ones", () => {
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ docId: "x", filename: "x.txt", page: 0, chunk: i, text: `common word number ${i}` });
  many.push({ docId: "x", filename: "x.txt", page: 0, chunk: 99, text: "common word zebra" });
  const hits = R.search(R.buildIndex(many), "common zebra", 1);
  assert.equal(hits[0].chunk, 99);
});

test("handles a large index quickly", () => {
  const big = [];
  for (let i = 0; i < 5000; i++) big.push({ docId: "d", filename: "d.txt", page: 0, chunk: i, text: `section ${i} lorem ipsum dolor sit amet consectetur ${i % 50}` });
  big.push({ docId: "d", filename: "d.txt", page: 0, chunk: 9999, text: "the special keyword hydroponics appears here" });
  const idx = R.buildIndex(big);
  const t0 = Date.now();
  const hits = R.search(idx, "hydroponics", 3);
  assert.equal(hits[0].chunk, 9999);
  assert.ok(Date.now() - t0 < 500);
});
