// Run from the project root:  node --test tests/markdown.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../public/markdown.js");

test("escapes raw HTML and scripts", () => {
  const html = M.render('<script>alert(1)</script> <img src=x onerror=alert(1)> **ok**');
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<img/i.test(html));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("<strong>ok</strong>"));
});

test("only http, https and mailto links are allowed", () => {
  const good = M.render("[Groq](https://groq.com/docs?a=1&b=2)");
  assert.ok(good.includes('<a href="https://groq.com/docs?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">Groq</a>'));
  for (const bad of ["javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "JaVaScRiPt:alert(1)"]) {
    const html = M.render(`[click](${bad})`);
    assert.ok(!html.includes("<a "), bad);
    assert.ok(!/href=/i.test(html), bad);
  }
});

test("a quote in a link label or url cannot break out of the attribute", () => {
  const html = M.render('[x" onmouseover="alert(1)](https://a.com/"onload="x)');
  assert.ok(!/onmouseover="/.test(html.replace(/&quot;/g, "")) || !html.includes('" onmouseover="'));
  assert.ok(!html.includes('" onmouseover'));
});

test("headings, lists and paragraphs", () => {
  const html = M.render("# Title\n\nHello *world* and `code`\n\n- one\n- two\n\n1. a\n2. b");
  assert.ok(html.includes("<h3>Title</h3>"));
  assert.ok(html.includes("<em>world</em>"));
  assert.ok(html.includes("<code>code</code>"));
  assert.ok(html.includes("<ul><li>one</li><li>two</li></ul>"));
  assert.ok(html.includes("<ol><li>a</li><li>b</li></ol>"));
});

test("nested lists", () => {
  const html = M.render("- fruit\n  - apple\n  - pear\n- veg");
  assert.equal(html, "<ul><li>fruit<ul><li>apple</li><li>pear</li></ul></li><li>veg</li></ul>");
});

test("lists separated by blank lines stay one list", () => {
  const html = M.render("1. first\n\n2. second\n\n3. third");
  assert.equal(html, "<ol><li>first</li><li>second</li><li>third</li></ol>");
});

test("code blocks keep their content, escape HTML and get a copy button", () => {
  const html = M.render("Before\n```python\nprint('<b>hi</b>')\n# **not bold**\n```\nAfter");
  assert.ok(html.includes('<span>python</span>'));
  assert.ok(html.includes('class="code-copy"'));
  assert.ok(html.includes("print(&#39;&lt;b&gt;hi&lt;/b&gt;&#39;)"));
  assert.ok(html.includes("# **not bold**"));
  assert.ok(!html.includes("<strong>not bold"));
  assert.ok(html.includes("<p>Before</p>") && html.includes("<p>After</p>"));
});

test("an unclosed code fence (streaming) is still rendered as code", () => {
  const html = M.render("Here:\n```js\nconst a = 1;");
  assert.ok(html.includes("<pre><code>const a = 1;</code></pre>"));
});

test("tables", () => {
  const html = M.render("| Name | Qty |\n| --- | ---: |\n| Apple | 3 |\n| <b>Pear</b> | 5 |\n\nDone");
  assert.ok(html.includes("<th>Name</th><th>Qty</th>"));
  assert.ok(html.includes("<td>Apple</td><td>3</td>"));
  assert.ok(html.includes("&lt;b&gt;Pear&lt;/b&gt;"));
  assert.ok(html.includes("<p>Done</p>"));
});

test("a lone pipe line is not a table", () => {
  const html = M.render("a | b | c");
  assert.ok(!html.includes("<table"));
});

test("blockquotes and rules", () => {
  const html = M.render("> quoted **text**\n> more\n\n---\n\nend");
  assert.ok(html.includes("<blockquote><p>quoted <strong>text</strong><br>more</p></blockquote>"));
  assert.ok(html.includes("<hr>"));
});

test("inline code protects its content from formatting", () => {
  const html = M.render("Use `**raw** <tag>` here");
  assert.ok(html.includes("<code>**raw** &lt;tag&gt;</code>"));
});

test("citation markers and brackets pass through unchanged", () => {
  const html = M.render("Refunds take thirty days [1][2, 3].");
  assert.ok(html.includes("[1][2, 3]."));
});

test("reserved placeholder characters in input cannot forge output", () => {
  const html = M.render("\u00010\u0001 and \u00020\u0002 `x`");
  assert.ok(!html.includes("undefined"));
  assert.ok(!html.includes("\u0001") && !html.includes("\u0002"));
});

test("empty and weird input does not throw", () => {
  for (const input of ["", "\n\n", "```", "|", "> ", "- ", "#", "[](", "\u0001\u0002 1 \u0002"]) {
    assert.doesNotThrow(() => M.render(input), JSON.stringify(input));
  }
});
