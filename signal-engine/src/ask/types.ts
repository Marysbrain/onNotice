// Shared shapes for the /ask brain.

export interface Citation {
  source_url: string;
  source_id: string;
  record_date: number | null;
}

export interface Tags {
  carrier: string | null;
  topic: string | null;
  sentiment: "positive" | "negative" | "neutral";
}

export interface AskResponse {
  answer: string;
  citations: Citation[];
  tags: Tags;
  refused: boolean;
  disclosure: string;
}

// One record as it flows out of an intent handler. Only the fields the tagger and
// the answer template need. Excerpts here are already sliced short.
export interface ResultRecord {
  carrier: string | null;
  excerpt: string;
}

export const DISCLOSURE =
  "Rylee is an AI. Answers come only from the vetted public evidence library.";

export const METHODOLOGY_CITATION: Citation = {
  source_url: "https://carriersonnotice.com/methodology",
  source_id: "methodology",
  record_date: null,
};
