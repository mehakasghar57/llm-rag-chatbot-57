/* Browser-side document search (BM25 ranking). No embeddings, no external service.
 *
 * Usage:
 *   const index = Retrieval.buildIndex(chunks);       // chunks: [{docId, filename, page, chunk, text}]
 *   const hits  = Retrieval.search(index, "refund policy", 5);   // [{...chunk, score}] score: 0..1
 *
 * Works in the browser (window.Retrieval) and in Node (module.exports) so it can be unit tested.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Retrieval = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STOP = new Set(
    ("a an and are as at be but by can did do does for from had has have how i if in into is it its me my no not of on or " +
      "our so than that the their them then there these they this to us was we were what when where which who whom why will " +
      "with would you your about please tell give show explain").split(" ")
  );

  // Very light stemming so "refunds", "refunded" and "refunding" match "refund".
  function stem(w) {
    if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
    if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
    if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
    if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
    return w;
  }

  function tokenize(text) {
    const words = String(text).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^\p{L}\p{N}]+/u);
    const out = [];
    for (const w of words) {
      if (!w || STOP.has(w)) continue;
      if (w.length < 2 && !/\d/.test(w)) continue;
      out.push(stem(w));
    }
    return out;
  }

  function buildIndex(chunks) {
    const docs = [];
    const df = new Map();
    let totalLen = 0;
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.text);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
      docs.push({ chunk, tf, len: tokens.length });
      totalLen += tokens.length;
    }
    return { docs, df, n: docs.length, avgLen: docs.length ? totalLen / docs.length : 0 };
  }

  const K1 = 1.4;
  const B = 0.75;

  function search(index, query, k) {
    if (!index || index.n === 0) return [];
    const terms = Array.from(new Set(tokenize(query)));
    if (terms.length === 0) return [];

    const scored = [];
    for (const doc of index.docs) {
      let score = 0;
      for (const term of terms) {
        const f = doc.tf.get(term);
        if (!f) continue;
        const n = index.df.get(term) || 0;
        const idf = Math.log(1 + (index.n - n + 0.5) / (n + 0.5));
        score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * doc.len) / (index.avgLen || 1)));
      }
      if (score > 0) scored.push({ chunk: doc.chunk, score });
    }
    if (scored.length === 0) return [];

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0].score;
    return scored.slice(0, k).map((s) => Object.assign({}, s.chunk, { score: s.score / best }));
  }

  return { tokenize, stem, buildIndex, search };
});
