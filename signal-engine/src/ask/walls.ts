// The three guard walls, checked before any retrieval. Pure functions so each
// phrasing is unit testable. Order is fixed: founder first, then employee, then
// opinion. Founder and employee are hard walls (refused, zero retrieval). Opinion
// is soft: it prepends a sentence but retrieval may still run.

import { containsTerm } from "../lib/taxonomy.js";

export type WallKind = "founder" | "employee" | "opinion";

export interface WallHit {
  wall: WallKind;
  sentence: string;
  hard: boolean; // hard = refuse with the sentence and do zero retrieval
}

// Fixed sentences. Verbatim from the spec. No elaboration is ever appended to a
// hard wall.
const FOUNDER_SENTENCE =
  "I don't discuss anyone's personal matters, including the founder's. The library documents company practices with public records.";
const EMPLOYEE_SENTENCE =
  "I only discuss company practices, never individual employees.";
const OPINION_SENTENCE =
  "I report what the records show. The commentary on this site is Michael's, and it's labeled as his.";

// Founder / personal-case wall. Catches the founder by name and role, plus the
// sneaky "who runs this site" framings, plus anyone fishing for a personal
// dispute, case, or settlement. This is the hard wall protecting rule 3: the
// founder's own AT&T matter never appears in platform content.
const FOUNDER_WORDS = ["michael", "hipp", "founder", "creator"];
const FOUNDER_PHRASES = [
  "your creator",
  "who runs this",
  "runs this site",
  "runs the site",
  "run this site",
  "guy who runs",
  "person who runs",
  "behind this site",
  "behind this website",
  "behind the site",
  "person behind this",
  "who made this site",
  "who built this site",
  "who created this site",
  "who started this site",
  "personal case",
  "personal matter",
  "personal dispute",
  "his dispute",
  "your dispute",
  "own dispute",
  "his case",
  "your case",
  "own case",
  "his settlement",
  "your settlement",
];

// Individual-employee wall. Any question about a person who works for a carrier,
// or asking us to name one, is refused. Aim stays at practices and companies
// (rule 2).
const EMPLOYEE_WORDS = [
  "employee", "employees", "rep", "reps", "representative", "representatives",
  "agent", "agents", "manager", "managers", "cashier", "cashiers",
  "salesperson", "salespeople", "clerk", "clerks", "associate", "associates",
  "staff", "worker", "workers",
];
const EMPLOYEE_PHRASES = [
  "name a person", "name the person", "who is the person", "which person",
  "name a specific", "name the specific", "who helped me", "which employee",
  "name the rep", "name the employee", "name the manager", "who is the rep",
  "name of the rep", "name of the employee", "name of the manager",
  "name of the person", "name of the salesperson",
];

// Opinion wall. Fishing for what "you" think or feel, or for a fairness or moral
// verdict. Soft: the sentence is prepended, then records may still be attached.
const OPINION_PHRASES = [
  "what do you think", "do you think", "your opinion", "in your opinion",
  "is it fair", "is that fair", "is this fair", "was it fair",
  "are they evil", "are they bad", "are they good", "are they corrupt",
  "do you hate", "do you like", "do you love", "your take", "how do you feel",
  "who is worse", "which is worse", "worst carrier", "best carrier",
];

function anyWord(hay: string, words: string[]): boolean {
  return words.some((w) => containsTerm(hay, w));
}

function anyPhrase(hay: string, phrases: string[]): boolean {
  return phrases.some((p) => hay.includes(p));
}

// Return the first wall the question trips, or null. Founder beats employee beats
// opinion, so a founder-flavored employee question still routes to the founder
// wall.
export function checkWall(question: string): WallHit | null {
  const hay = question.toLowerCase();

  if (anyWord(hay, FOUNDER_WORDS) || anyPhrase(hay, FOUNDER_PHRASES)) {
    return { wall: "founder", sentence: FOUNDER_SENTENCE, hard: true };
  }
  if (anyWord(hay, EMPLOYEE_WORDS) || anyPhrase(hay, EMPLOYEE_PHRASES)) {
    return { wall: "employee", sentence: EMPLOYEE_SENTENCE, hard: true };
  }
  if (anyPhrase(hay, OPINION_PHRASES)) {
    return { wall: "opinion", sentence: OPINION_SENTENCE, hard: false };
  }
  return null;
}
