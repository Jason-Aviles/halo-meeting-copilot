/**
 * Decides whether what the other side just said is something the user should
 * answer. Speech-to-text often drops question marks and interviewers often ask
 * with statements ("Tell me about a time…"), so "ends with ?" misses most of
 * them. This looks at the last couple of sentences for the shapes questions
 * and prompts take in conversation.
 */

const WH = /^(what|why|how|when|where|who|whom|whose|which)\b/;
/** "Do you…", "Can we…", "Is there…": an auxiliary verb followed by its subject. */
const INVERTED =
  /^(do|does|did|can|could|would|will|should|shall|is|are|was|were|have|has|had|may|might|must|isn't|aren't|don't|doesn't|didn't|won't|wouldn't|can't|couldn't|haven't|hasn't)\s+(you|we|they|i|he|she|it|there|that|this|these|those|your|our|the|any|anyone|anybody|someone|everyone)\b/;
/** Prompts that ask for an answer without being phrased as a question. */
const PROMPTS = [
  /\btell (me|us) (about|more|how|why|what|when|where|who|a bit|a little)\b/,
  /\bwalk (me|us) through\b/,
  /\btalk (me |us )?(through|about)\b/,
  /^(please )?(describe|explain|define|compare|summari[sz]e|elaborate|outline)\b/,
  /\b(can|could|would) you (describe|explain|tell|share|walk|talk|elaborate|clarify|give)\b/,
  /\bgive (me|us) (an|a|some) (example|sense|overview|idea|rundown)\b/,
  /\bshare (an example|a time|a bit|your|how|what)\b/,
  /\bi('d| would) (like|love) to (hear|know|understand|learn)\b/,
  /\bi('m| am) (curious|interested|wondering) (about|how|what|why|whether|if)\b/,
  /\bi (wonder|was wondering) (if|how|what|why|whether)\b/,
  /\b(your|any) (thoughts|take|view|views|opinion|perspective|questions) (on|about|for)\b/,
  /\b(thoughts|questions)\s*$/,
  /^(what|how) about\b/,
  /\bhow would you\b/,
  /\bwhat would you\b/,
  /\bwhy (did|do|would|should) you\b/,
  /\bgo ahead\b/,
  /\bthe floor is yours\b/,
  /\b(over to you|your turn)\b/,
];
/** Tag questions: "…, right?", "…, isn't it". Only counted with a question mark or a clear tag. */
const TAGS = /,?\s*(isn't it|aren't you|don't you|didn't you|wouldn't you|doesn't it|won't you|can't you|is that right|is that correct|does that make sense|you know what i mean)\s*\??$/;
/** Short reactions that end in "?" but don't need an answer from the user. */
const NOT_QUESTIONS = /^(sorry|pardon|what|huh|really|right|okay|ok|yeah|yes|no|hello|hi|hey|hmm|um|uh|oh|wait|you there|can you hear me|are you there)\W*$/;
/** Statements that start like questions: "What I mean is…", "How we did it was…". */
const WH_STATEMENT = /^(what|how|why|when|where|who)\s+(i|we|they|he|she|it|you)\s+[\w']+(\s+[\w']+){0,6}\s+(is|was|are|were)\b/;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalize(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/^(so|and|but|okay|ok|alright|all right|well|now|great|cool|right|yeah|um|uh|and so|so then)[,\s]+/g, "")
    .replace(/^(so|and|but|okay|ok|alright|well|now|um|uh)[,\s]+/g, "")
    .trim();
}

function isQuestionSentence(raw: string): boolean {
  const s = normalize(raw);
  if (s.split(/\s+/).length < 3 && NOT_QUESTIONS.test(s)) return false;
  if (NOT_QUESTIONS.test(s)) return false;
  if (raw.trim().endsWith("?")) return true;
  if (TAGS.test(s)) return true;
  if (WH.test(s) && !WH_STATEMENT.test(s)) return true;
  if (INVERTED.test(s)) return true;
  return PROMPTS.some((p) => p.test(s));
}

/**
 * True when the end of this turn asks the user something. Only the last two
 * sentences count, so a question early in a long monologue doesn't trigger
 * once they've moved on, but "What's your approach? Take your time." does.
 */
export function endsWithQuestion(turn: string): boolean {
  const tail = sentences(turn).slice(-2);
  return tail.some(isQuestionSentence);
}
