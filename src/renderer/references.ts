import { DEFAULT_JIRA_JQL, type HaloApi, type SourceInfo } from "../shared/types";

/** Matches MAX_REFERENCE_CHARS in the main process: past this, later references are cut. */
const REFERENCE_BUDGET = 200_000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const KIND_LABEL: Record<SourceInfo["kind"], string> = {
  file: "File",
  folder: "Folder",
  github: "GitHub",
  jira: "Jira",
};

const ICONS: Record<SourceInfo["kind"] | "refresh" | "remove", string> = {
  file: '<path d="M4.5 2h5L12 4.5V14h-7.5z" /><path d="M9.5 2v2.5H12" />',
  folder: '<path d="M2 4.5h4l1.2 1.5H14v7.5H2z" />',
  github: '<circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="12" r="1.5" /><circle cx="11" cy="6" r="1.5" /><path d="M5 5.5v5M11 7.5c0 2-2 2.5-6 3" />',
  jira: '<path d="M8 2l6 6-6 6-6-6z" /><path d="M8 5.5L10.5 8 8 10.5 5.5 8z" />',
  refresh: '<path d="M13 8a5 5 0 11-1.5-3.5M13 2.5v2.5h-2.5" />',
  remove: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />',
};

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  // Static markup from the table above, never user text.
  svg.innerHTML = ICONS[name];
  return svg;
}

function size(chars: number): string {
  return chars >= 1000 ? `${Math.round(chars / 1000)}K chars` : `${chars} chars`;
}

function ago(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function describe(s: SourceInfo): string {
  const unit = s.kind === "jira" ? (s.files === 1 ? "ticket" : "tickets") : s.files === 1 ? "file" : "files";
  return `${KIND_LABEL[s.kind]} · ${s.files} ${unit} · ${size(s.chars)} · ${ago(s.refreshedAt)}`;
}

export interface ReferencesOptions {
  getSources(): SourceInfo[];
  /** Called with the new list after every change, so the caller can keep its copy. */
  onChange(sources: SourceInfo[]): void;
  onError(message: string): void;
  /** Opens Settings on the Context tab. */
  onManage(): void;
}

export function initReferences(api: HaloApi, opts: ReferencesOptions) {
  const list = $<HTMLUListElement>("refs-list");
  const empty = $("refs-empty");
  const total = $("refs-total");
  const quick = $<HTMLUListElement>("refs-quick");
  const quickEmpty = $("refs-quick-empty");
  const popover = $("refs-popover");
  const chip = $<HTMLButtonElement>("chip-refs");
  const chipText = $("chip-refs-text");

  /** Runs a change, keeping the button busy until it finishes. */
  async function run(button: HTMLButtonElement | null, work: () => Promise<SourceInfo[]>) {
    if (button) {
      button.disabled = true;
      button.classList.add("busy");
    }
    try {
      opts.onChange(await work());
      render();
      return true;
    } catch (err) {
      opts.onError(String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      return false;
    } finally {
      if (button) {
        button.disabled = false;
        button.classList.remove("busy");
      }
    }
  }

  function toggle(s: SourceInfo, on: boolean) {
    void run(null, () => api.setSourceEnabled(s.id, on));
  }

  function render(): void {
    const sources = opts.getSources();
    const enabled = sources.filter((s) => s.enabled);

    list.replaceChildren(
      ...sources.map((s) => {
        const li = document.createElement("li");
        li.className = "ref";
        li.classList.toggle("off", !s.enabled);

        const check = document.createElement("input");
        check.type = "checkbox";
        check.checked = s.enabled;
        check.title = "Use in answers";
        check.setAttribute("aria-label", `Use ${s.title} in answers`);
        check.addEventListener("change", () => toggle(s, check.checked));

        const kind = document.createElement("span");
        kind.className = `ref-kind ${s.kind}`;
        kind.append(icon(s.kind));

        const text = document.createElement("div");
        text.className = "ref-text";
        const title = document.createElement("span");
        title.className = "ref-title";
        title.textContent = s.title;
        title.title = s.location;
        const meta = document.createElement("span");
        meta.className = "ref-meta";
        meta.textContent = describe(s);
        text.append(title, meta);

        const refresh = document.createElement("button");
        refresh.type = "button";
        refresh.className = "icon";
        refresh.title = "Refresh";
        refresh.setAttribute("aria-label", `Refresh ${s.title}`);
        refresh.append(icon("refresh"));
        refresh.addEventListener("click", () => void run(refresh, () => api.refreshSource(s.id)));

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "icon close";
        remove.title = "Remove";
        remove.setAttribute("aria-label", `Remove ${s.title}`);
        remove.append(icon("remove"));
        remove.addEventListener("click", () => void run(remove, () => api.removeSource(s.id)));

        li.append(check, kind, text, refresh, remove);
        return li;
      }),
    );
    empty.hidden = sources.length > 0;
    const enabledChars = enabled.reduce((n, s) => n + s.chars, 0);
    total.textContent = sources.length ? `${enabled.length} of ${sources.length} on · ${size(enabledChars)}` : "";
    total.classList.toggle("over", enabledChars > REFERENCE_BUDGET);
    total.title =
      enabledChars > REFERENCE_BUDGET
        ? `Over the ${size(REFERENCE_BUDGET)} limit: the last references in the list get cut. Untick some you don't need.`
        : "";

    quick.replaceChildren(
      ...sources.map((s) => {
        const li = document.createElement("li");
        const label = document.createElement("label");
        label.className = "check";
        const check = document.createElement("input");
        check.type = "checkbox";
        check.checked = s.enabled;
        check.addEventListener("change", () => toggle(s, check.checked));
        const kind = document.createElement("span");
        kind.className = `ref-kind ${s.kind}`;
        kind.append(icon(s.kind));
        const title = document.createElement("span");
        title.className = "ref-title";
        title.textContent = s.title;
        label.append(check, kind, title);
        li.append(label);
        return li;
      }),
    );
    quickEmpty.hidden = sources.length > 0;

    chipText.textContent = enabled.length ? `${enabled.length} ref${enabled.length === 1 ? "" : "s"}` : "No refs";
    chip.classList.toggle("on", enabled.length > 0);
  }

  // ---------- adding ----------

  const forms = { github: $("form-github"), jira: $("form-jira") };
  function openForm(name: keyof typeof forms | null) {
    for (const [key, form] of Object.entries(forms)) form.hidden = key !== name;
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-close]")) {
    b.addEventListener("click", () => openForm(null));
  }

  $<HTMLButtonElement>("btn-add-files").addEventListener("click", (e) =>
    void run(e.currentTarget as HTMLButtonElement, () => api.addSourceFiles()),
  );
  $<HTMLButtonElement>("btn-add-folder").addEventListener("click", (e) =>
    void run(e.currentTarget as HTMLButtonElement, () => api.addSourceFolder()),
  );

  const githubUrl = $<HTMLInputElement>("github-url");
  $("btn-add-github").addEventListener("click", () => {
    openForm(forms.github.hidden ? "github" : null);
    githubUrl.focus();
  });
  const addGithub = async () => {
    if (!githubUrl.value.trim()) return githubUrl.focus();
    if (await run($("btn-github-add"), () => api.addSourceGithub(githubUrl.value))) {
      githubUrl.value = "";
      openForm(null);
    }
  };
  $("btn-github-add").addEventListener("click", () => void addGithub());
  githubUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void addGithub();
    }
  });

  const jira = {
    site: $<HTMLInputElement>("jira-site"),
    email: $<HTMLInputElement>("jira-email"),
    token: $<HTMLInputElement>("jira-token"),
    jql: $<HTMLInputElement>("jira-jql"),
  };
  $("btn-add-jira").addEventListener("click", async () => {
    const opening = forms.jira.hidden;
    openForm(opening ? "jira" : null);
    if (!opening) return;
    const s = await api.getSettings();
    jira.site.value = s.jiraSite;
    jira.email.value = s.jiraEmail;
    jira.token.value = "";
    jira.token.placeholder = s.hasJiraToken ? "Saved. Type to replace" : "Paste your token";
    if (!jira.jql.value) jira.jql.value = DEFAULT_JIRA_JQL;
    (s.jiraSite ? jira.jql : jira.site).focus();
  });
  const addJira = async () => {
    const button = $<HTMLButtonElement>("btn-jira-add");
    const ok = await run(button, async () => {
      // Save the connection first; the token is encrypted like the other keys.
      await api.updateSettings({
        jiraSite: jira.site.value,
        jiraEmail: jira.email.value,
        ...(jira.token.value.trim() ? { jiraToken: jira.token.value } : {}),
      });
      return api.addSourceJira(jira.jql.value);
    });
    if (ok) {
      jira.token.value = "";
      openForm(null);
    }
  };
  $("btn-jira-add").addEventListener("click", () => void addJira());
  // Enter would otherwise submit the whole Settings form.
  for (const input of Object.values(jira)) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void addJira();
      }
    });
  }

  // ---------- quick popover on the main view ----------

  function setPopover(open: boolean) {
    // Sit just under the chip, which moves when the chip row wraps on a narrow window.
    if (open) popover.style.top = `${chip.offsetTop + chip.offsetHeight + 6}px`;
    popover.hidden = !open;
    chip.setAttribute("aria-expanded", String(open));
  }
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    setPopover(chip.getAttribute("aria-expanded") !== "true");
  });
  popover.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => setPopover(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setPopover(false);
  });
  $("refs-manage").addEventListener("click", () => {
    setPopover(false);
    opts.onManage();
  });

  return { render };
}
