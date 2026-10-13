import type { CallRecord, HistoryItem, HistoryPage, ParacatApi } from "../shared/types";

/** Searching is local and fast, so a short pause after typing is enough. */
const SEARCH_DEBOUNCE_MS = 250;
const MARK_START = "\u0002";
const MARK_END = "\u0003";

export type View = "main" | "settings" | "history" | "call";

const views: Record<View, string> = {
  main: "view-main",
  settings: "view-settings",
  history: "view-history",
  call: "view-call",
};

export function showView(view: View): void {
  for (const [name, id] of Object.entries(views)) {
    document.getElementById(id)!.hidden = name !== view;
  }
}

function currentView(): View {
  for (const [name, id] of Object.entries(views)) {
    if (!document.getElementById(id)!.hidden) return name as View;
  }
  return "main";
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function describeTime(item: { startedAt: number; endedAt: number; meetingApp: string | null }): string {
  const minutes = Math.max(1, Math.round((item.endedAt - item.startedAt) / 60_000));
  return [dateFormat.format(item.startedAt), `${minutes} min`, item.meetingApp]
    .filter(Boolean)
    .join(" · ");
}

/** Builds a snippet as text nodes, wrapping highlighted terms in <mark> (no innerHTML). */
function snippetNodes(snippet: string): Node[] {
  const nodes: Node[] = [];
  let rest = snippet;
  while (rest) {
    const start = rest.indexOf(MARK_START);
    if (start < 0) {
      nodes.push(document.createTextNode(rest));
      break;
    }
    const end = rest.indexOf(MARK_END, start + 1);
    if (start > 0) nodes.push(document.createTextNode(rest.slice(0, start)));
    const mark = document.createElement("mark");
    mark.textContent = rest.slice(start + 1, end < 0 ? undefined : end);
    nodes.push(mark);
    rest = end < 0 ? "" : rest.slice(end + 1);
  }
  return nodes;
}

export function initHistory(api: ParacatApi, opts: { onError(message: string): void }): void {
  const el = {
    search: $<HTMLInputElement>("history-search"),
    clear: $<HTMLButtonElement>("history-clear"),
    count: $("history-count"),
    list: $<HTMLUListElement>("history-list"),
    empty: $("history-empty"),
    more: $<HTMLButtonElement>("history-more"),
    callTitle: $("call-title"),
    callMeta: $("call-meta"),
    callNotes: $("call-notes"),
    callTranscript: $("call-transcript"),
  };

  let query = "";
  let nextOffset: number | null = null;
  /** Responses can arrive out of order while typing; only the latest request renders. */
  let requestSeq = 0;
  let debounceTimer: number | undefined;
  let openCallId: number | null = null;

  function renderItem(item: HistoryItem): HTMLLIElement {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";

    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = item.title;

    const meta = document.createElement("span");
    meta.className = "history-meta";
    meta.textContent = describeTime(item);

    button.append(title, meta);
    if (item.snippet) {
      const snippet = document.createElement("span");
      snippet.className = "history-snippet";
      snippet.append(...snippetNodes(item.snippet));
      button.append(snippet);
    }
    button.addEventListener("click", () => void openCall(item.id));
    li.append(button);
    return li;
  }

  function renderPage(page: HistoryPage, append: boolean): void {
    if (!append) el.list.replaceChildren();
    el.list.append(...page.items.map(renderItem));
    nextOffset = page.nextOffset;
    el.more.hidden = nextOffset === null;

    const searching = query.trim() !== "";
    el.count.textContent =
      page.total === 0 ? "" : searching ? `${page.total} matching ${page.total === 1 ? "call" : "calls"}` : `${page.total} saved ${page.total === 1 ? "call" : "calls"}`;
    el.empty.hidden = page.total !== 0;
    el.empty.textContent = searching
      ? "No matching calls. Try a different search term or check the spelling."
      : "No calls saved yet. Calls are saved here when you stop listening.";
  }

  async function load(append: boolean): Promise<void> {
    const seq = ++requestSeq;
    try {
      const page = await api.searchCalls({ query, offset: append ? (nextOffset ?? 0) : 0 });
      if (seq === requestSeq) renderPage(page, append);
    } catch (err) {
      if (seq === requestSeq) opts.onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openCall(id: number): Promise<void> {
    let call: CallRecord | null;
    try {
      call = await api.getCall(id);
    } catch (err) {
      opts.onError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!call) {
      void load(false);
      return;
    }
    openCallId = call.id;
    el.callTitle.textContent = call.title;
    el.callMeta.textContent = describeTime(call);
    el.callNotes.textContent = call.notes || "No notes. Press Summarize during a call to add them.";

    el.callTranscript.replaceChildren(
      ...call.transcript.map((line) => {
        const p = document.createElement("p");
        p.className = line.speaker;
        const who = document.createElement("span");
        who.className = "who";
        who.textContent = line.speaker === "them" ? "Them" : "You";
        p.append(who, document.createTextNode(line.text));
        return p;
      }),
    );
    showView("call");
  }

  function openHistory(): void {
    showView("history");
    void load(false);
    el.search.focus();
  }

  el.search.addEventListener("input", () => {
    el.clear.hidden = el.search.value === "";
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      const next = el.search.value.trim();
      if (next === query) return;
      query = next;
      void load(false);
    }, SEARCH_DEBOUNCE_MS);
  });

  el.search.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && el.search.value) {
      event.preventDefault();
      el.clear.click();
    }
  });

  el.clear.addEventListener("click", () => {
    window.clearTimeout(debounceTimer);
    el.search.value = "";
    el.clear.hidden = true;
    query = "";
    void load(false);
    el.search.focus();
  });

  el.more.addEventListener("click", () => void load(true));

  $("call-back").addEventListener("click", () => {
    showView("history");
    void load(false);
  });

  $("call-delete").addEventListener("click", async () => {
    if (openCallId === null) return;
    try {
      await api.deleteCall(openCallId);
    } catch (err) {
      opts.onError(err instanceof Error ? err.message : String(err));
      return;
    }
    openCallId = null;
    showView("history");
    void load(false);
  });

  $("btn-history").addEventListener("click", () => {
    const view = currentView();
    if (view === "history" || view === "call") showView("main");
    else openHistory();
  });
}
