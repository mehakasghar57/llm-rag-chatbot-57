/* A small, safe Markdown renderer for chat answers.
 *
 * Everything is HTML-escaped first, so model output (or a loaded history file) can never inject
 * HTML or scripts. Supports: headings, bold/italic/strike, inline code, fenced code blocks (with a
 * copy button and a language label), links (http/https/mailto only), bullet/numbered/nested lists,
 * tables, blockquotes and horizontal rules. Unclosed code fences are handled so text can be
 * rendered while it is still streaming in.
 *
 * Works in the browser (window.Markdown) and in Node (module.exports) for unit tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Markdown = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function safeUrl(url) {
    const u = url.trim();
    return /^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(u) ? u : null;
  }

  // Inline formatting. Input is RAW text; output is safe HTML.
  function inline(text) {
    const stash = [];
    text = String(text).replace(/[\u0001\u0002]/g, "");
    const keep = (html) => `\u0001${stash.push(html) - 1}\u0001`;

    let t = String(text);
    t = t.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));
    t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const href = safeUrl(url);
      return href ? keep(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(label)}</a>`) : m;
    });
    t = escapeHtml(t);
    t = t.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, "$1<em>$2</em>");
    t = t.replace(/~~([^~\n]+?)~~/g, "<del>$1</del>");
    return t.replace(/\u0001(\d+)\u0001/g, (_, i) => stash[Number(i)]);
  }

  function splitRow(line) {
    let row = line.trim();
    if (row.startsWith("|")) row = row.slice(1);
    if (row.endsWith("|")) row = row.slice(0, -1);
    return row.split("|").map((c) => c.trim());
  }

  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function codeBlockHtml(lang, code) {
    const label = escapeHtml((lang || "").trim().slice(0, 20) || "code");
    return (
      `<div class="codeblock"><div class="code-head"><span>${label}</span>` +
      `<button type="button" class="code-copy">Copy</button></div>` +
      `<pre><code>${escapeHtml(code)}</code></pre></div>`
    );
  }

  function renderBlocks(src, depth) {
    const lines = src.split("\n");
    const out = [];
    let para = [];
    const lists = []; // stack of {type, indent}

    const flushPara = () => {
      if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; }
    };
    const closeLists = (toIndent) => {
      while (lists.length && lists[lists.length - 1].indent > toIndent) out.push(`</li></${lists.pop().type}>`);
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\s+$/, "");

      const code = line.match(/^\u0002(\d+)\u0002$/);
      if (code) { flushPara(); closeLists(-1); out.push(`\u0002${code[1]}\u0002`); continue; }

      if (line.trim() === "") { flushPara(); continue; }

      const item = line.match(/^(\s*)([-*+•]|\d+[.)])\s+(.*)$/);
      if (item) {
        flushPara();
        const indent = Math.floor(item[1].replace(/\t/g, "  ").length / 2);
        const type = /\d/.test(item[2]) ? "ol" : "ul";
        closeLists(indent);
        const top = lists[lists.length - 1];
        if (top && top.indent === indent && top.type === type) {
          out.push(`</li><li>${inline(item[3])}`);
        } else if (top && top.indent === indent) {
          out.push(`</li></${top.type}>`); lists.pop();
          out.push(`<${type}><li>${inline(item[3])}`); lists.push({ type, indent });
        } else {
          out.push(`<${type}><li>${inline(item[3])}`); lists.push({ type, indent });
        }
        continue;
      }

      if (lists.length && /^\s+\S/.test(line)) { out.push(`<br>${inline(line.trim())}`); continue; } // continuation of an item
      closeLists(-1);

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) { flushPara(); const lv = Math.min(6, heading[1].length + 2); out.push(`<h${lv}>${inline(heading[2])}</h${lv}>`); continue; }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); out.push("<hr>"); continue; }

      if (/^\s*>/.test(line) && depth < 3) {
        flushPara();
        const quote = [line.replace(/^\s*>\s?/, "")];
        while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) quote.push(lines[++i].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${renderBlocks(quote.join("\n"), depth + 1)}</blockquote>`);
        continue;
      }

      if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
        flushPara();
        const head = splitRow(line);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") rows.push(splitRow(lines[i++]));
        i--;
        out.push(
          '<div class="table-wrap"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + head.map((_, k) => `<td>${inline(r[k] || "")}</td>`).join("") + "</tr>").join("") +
          "</tbody></table></div>"
        );
        continue;
      }

      para.push(line);
    }
    flushPara();
    closeLists(-1);
    return out.join("");
  }

  function render(src) {
    const blocks = [];
    src = String(src).replace(/[\u0001\u0002]/g, ""); // reserved for internal placeholders
    // Closed fences, and a final unclosed fence (text that is still streaming in).
    const text = String(src).replace(/\r\n?/g, "\n").replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
      blocks.push(codeBlockHtml(lang, code.replace(/\n$/, "")));
      return `\n\u0002${blocks.length - 1}\u0002\n`;
    });
    return renderBlocks(text, 0).replace(/\u0002(\d+)\u0002/g, (_, i) => blocks[Number(i)]);
  }

  return { render, escapeHtml, inline };
});
