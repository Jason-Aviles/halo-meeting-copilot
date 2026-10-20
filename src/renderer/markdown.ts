/**
 * Renders the small Markdown subset meeting notes use: headings, bullet and
 * numbered lists, tables, bold, italics and inline code. Builds DOM nodes from
 * text, never HTML strings, so model output can't inject markup.
 */
export function renderMarkdown(target: HTMLElement, markdown: string): void {
  target.replaceChildren(...blocks(markdown.replace(/\r\n/g, "\n").split("\n")));
}

function blocks(lines: string[]): Node[] {
  const out: Node[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const h = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
      h.className = "md-h";
      h.append(...inline(heading[2]));
      out.push(h);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push(document.createElement("hr"));
      i++;
      continue;
    }

    if (trimmed.startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(lines[i++].trim());
      out.push(table(rows));
      continue;
    }

    const listMatch = /^([-*+]|\d+[.)])\s+/.exec(trimmed);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[1]);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        const li = document.createElement("li");
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(m[2]);
        if (task) {
          li.className = "md-task";
          li.dataset.done = String(task[1] !== " ");
          li.append(...inline(task[2]));
        } else {
          li.append(...inline(m[2]));
        }
        list.append(li);
        i++;
      }
      out.push(list);
      continue;
    }

    // A paragraph runs until a blank line or another block starts.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i].trim())) {
      para.push(lines[i++].trim());
    }
    if (para.length === 0) para.push(lines[i++].trim());
    const p = document.createElement("p");
    para.forEach((text, n) => {
      if (n > 0) p.append(document.createElement("br"));
      p.append(...inline(text));
    });
    out.push(p);
  }
  return out;
}

function cells(row: string): string[] {
  return row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function table(rows: string[]): Node {
  const wrap = document.createElement("div");
  wrap.className = "md-table";
  const t = document.createElement("table");
  const isRule = (r: string) => /^\|?[\s:|-]+\|?$/.test(r) && r.includes("-");
  const [head, ...rest] = rows;
  const body = rest.filter((r) => !isRule(r));

  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  for (const c of cells(head)) {
    const th = document.createElement("th");
    th.append(...inline(c));
    tr.append(th);
  }
  thead.append(tr);

  const tbody = document.createElement("tbody");
  for (const r of body) {
    const row = document.createElement("tr");
    for (const c of cells(r)) {
      const td = document.createElement("td");
      td.append(...inline(c));
      row.append(td);
    }
    tbody.append(row);
  }
  t.append(thead, tbody);
  wrap.append(t);
  return wrap;
}

function inline(text: string): Node[] {
  const nodes: Node[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index! > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
    const token = m[0];
    let el: HTMLElement;
    if (token.startsWith("**")) {
      el = document.createElement("strong");
      el.textContent = token.slice(2, -2);
    } else if (token.startsWith("`")) {
      el = document.createElement("code");
      el.textContent = token.slice(1, -1);
    } else {
      el = document.createElement("em");
      el.textContent = token.slice(1, -1);
    }
    nodes.push(el);
    last = m.index! + token.length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}
