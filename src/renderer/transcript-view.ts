import type { Speaker, TranscriptLine } from "../shared/types";

/**
 * Keeps the transcript DOM in step with the data, touching only what changed.
 * Partial results arrive several times a second per speaker, so rebuilding
 * every line on each one gets slower the longer the call runs.
 */
export class TranscriptView {
  private rows: HTMLParagraphElement[] = [];
  private partial: Partial<Record<Speaker, HTMLParagraphElement>> = {};

  constructor(
    private readonly root: HTMLElement,
    private readonly placeholder: HTMLElement,
  ) {}

  /** Redraws everything. Only for starting a call or clearing. */
  reset(lines: TranscriptLine[]): void {
    this.rows = lines.map((l) => this.row(l.speaker, l.text, false));
    this.partial = {};
    this.root.replaceChildren(...this.rows);
    this.syncPlaceholder();
  }

  /** Adds a committed line above any partial lines. */
  append(line: TranscriptLine): void {
    this.keepScrolled(() => {
      const p = this.row(line.speaker, line.text, false);
      this.rows.push(p);
      this.root.insertBefore(p, this.root.querySelector(".interim"));
    });
  }

  /** Replaces the text of the last committed line (consecutive lines from one speaker are merged). */
  updateLast(text: string): void {
    const p = this.rows[this.rows.length - 1];
    if (p) this.keepScrolled(() => this.setText(p, text));
  }

  /** Shows, updates or (with "") removes a speaker's partial line. */
  setPartial(speaker: Speaker, text: string): void {
    this.keepScrolled(() => {
      const p = this.partial[speaker];
      if (!text) {
        p?.remove();
        delete this.partial[speaker];
      } else if (p) {
        this.setText(p, text);
      } else {
        const row = this.row(speaker, text, true);
        this.partial[speaker] = row;
        this.root.append(row);
      }
    });
  }

  private row(speaker: Speaker, text: string, partial: boolean): HTMLParagraphElement {
    const p = document.createElement("p");
    p.className = partial ? `${speaker} interim` : speaker;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = speaker === "them" ? "Them" : "You";
    p.append(who, document.createTextNode(text));
    return p;
  }

  private setText(p: HTMLParagraphElement, text: string): void {
    (p.lastChild as Text).data = text;
  }

  /** Runs a change, then stays pinned to the bottom if the view was already there. */
  private keepScrolled(change: () => void): void {
    const r = this.root;
    const atBottom = r.scrollHeight - r.scrollTop - r.clientHeight < 40;
    change();
    this.syncPlaceholder();
    if (atBottom) r.scrollTop = r.scrollHeight;
  }

  private syncPlaceholder(): void {
    const empty = this.rows.length === 0 && !this.partial.them && !this.partial.you;
    if (empty && !this.placeholder.isConnected) this.root.append(this.placeholder);
    else if (!empty) this.placeholder.remove();
  }
}
