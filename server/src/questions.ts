import { getDb } from "./db.js";

/**
 * Questions a colleague's conversation could not answer on its own.
 *
 * A colleague can read and explain, and nothing else. Without this the agent's
 * only honest response to anything further is "I'd have to ask" — and then
 * nobody asks. This carries the question to the primary user and the answer
 * back to the person who asked, so the refusal turns into a round trip instead
 * of a dead end.
 *
 * The id is short and typed by a human in a chat, so it is four characters.
 */

export interface QuestionRow {
  id: string;
  session_id: string;
  person_key: string;
  person_name: string;
  /** Where the answer goes back to — the asking conversation, not the asker. */
  channel_slug: string;
  channel_key: string;
  question: string;
  asked_at: string;
  answered_at: string | null;
  answer: string | null;
  /** Set when the agent is asking permission rather than an opinion. */
  action_tool: string | null;
  action: string | null;
}

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/**
 * Unique in the whole table: answered rows are kept, and the id is the primary
 * key, so one reused for a new question would make the insert fail.
 */
function freeId(): string {
  const used = getDb().prepare("SELECT 1 FROM questions WHERE id = ?");
  for (let attempt = 0; attempt < 500; attempt++) {
    let id = "";
    for (let i = 0; i < 4; i++) id += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!used.get(id)) return id;
  }
  throw new Error("No free question id");
}

export function askQuestion(input: {
  sessionId: string;
  personKey: string;
  personName: string;
  channelSlug: string;
  channelKey: string;
  question: string;
  actionTool?: string | null;
  action?: string | null;
}): QuestionRow {
  const id = freeId();
  getDb()
    .prepare(
      `INSERT INTO questions
         (id, session_id, person_key, person_name, channel_slug, channel_key, question,
          action_tool, action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.sessionId,
      input.personKey,
      input.personName,
      input.channelSlug,
      input.channelKey,
      input.question,
      input.action ? (input.actionTool || "bash") : null,
      input.action || null
    );
  return getQuestion(id)!;
}

/**
 * What the primary user is shown of a question beside its words: the action it
 * would allow, exactly as it would run, and how to answer, so that an approval
 * is always one of something they have read.
 */
export function offerOf(q: QuestionRow): string {
  if (!q.action) return `Reply with "#${q.id} <your answer>" and I will pass it back to them.`;
  return (
    `It wants to run, exactly once:\n\n    ${q.action.replace(/\n/g, "\n    ")}\n\nApproving runs that and nothing else.\n\n` +
    `Reply "#${q.id} approve" for this once, "#${q.id} always" to permit it from now on, or "#${q.id} no".`
  );
}

/** A question that could not be put to anybody: it waits for nobody, and nobody is asked to answer it. */
export function dropQuestion(id: string): void {
  getDb().prepare("DELETE FROM questions WHERE id = ?").run(id);
}

export const getQuestion = (id: string): QuestionRow | undefined =>
  getDb().prepare("SELECT * FROM questions WHERE id = ?").get(id) as QuestionRow | undefined;

export function recordAnswer(id: string, answer: string): void {
  getDb()
    .prepare("UPDATE questions SET answered_at = ?, answer = ? WHERE id = ?")
    .run(new Date().toISOString(), answer, id);
}

/**
 * Approval has to be a word, not a mood.
 *
 * Exactly the words the question and its buttons offer, and nothing that merely
 * begins with one: "ok, but not before Friday", "yes, after the release" and "do
 * it yourself, Priya" are answers, relayed as such, and authorise nothing, so an
 * ambiguous reply can never be read as a yes. A full stop or an exclamation mark
 * after the word does not change it.
 */
const APPROVES = /^(approve|always)[.!]*$/i;

/**
 * Standing permission, which is a different promise from "approve".
 *
 * Kept to one unmistakable word: a rule that outlives the conversation should
 * never be created by a reply that merely sounded enthusiastic, and "always check
 * with me first" is the opposite of it.
 */
const ALWAYS = /^always[.!]*$/i;

/**
 * Is this message from the primary user an answer to a waiting question?
 *
 * Matched only at the start of a message and only against an id that is
 * actually waiting, so "#tea break in 5" reaches the agent as a message rather
 * than being swallowed as an answer to something.
 */
export function readAnswer(
  text: string
): { question: QuestionRow; answer: string; approves: boolean; always: boolean } | null {
  const m = /^#([a-z2-9]{4})\b[\s:,-]*([\s\S]*)$/i.exec(text.trim());
  if (!m) return null;
  const question = getQuestion(m[1].toLowerCase());
  if (!question || question.answered_at) return null;
  const answer = m[2].trim();
  if (!answer) return null;
  return { question, answer, approves: APPROVES.test(answer), always: ALWAYS.test(answer) };
}
