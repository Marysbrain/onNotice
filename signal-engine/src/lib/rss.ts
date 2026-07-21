// Tiny RSS/Atom item extractor. No XML dependency. Workers have no DOMParser,
// and pulling a full XML lib risks the 10ms free CPU budget on big feeds, so
// this is a narrow regex reader over <item>/<entry> blocks. Good enough for the
// FTC feeds, which are well-formed and small.

export interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
  // Decode first: FTC feeds ship HTML-encoded markup, and stripping before
  // decoding lets tags reappear in the "clean" text.
  return decodeEntities(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function firstTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m && m[1] !== undefined ? m[1] : "";
}

// Atom links use <link href="..."/>. RSS uses <link>...</link>.
function extractLink(block: string): string {
  const rss = firstTag(block, "link");
  if (rss.trim()) return decodeEntities(rss.trim());
  const atom = block.match(/<link[^>]*href="([^"]+)"[^>]*\/?>(?:<\/link>)?/i);
  return atom && atom[1] ? decodeEntities(atom[1]) : "";
}

export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  // Match both RSS <item> and Atom <entry>.
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) ?? [];
  for (const block of blocks) {
    const title = stripTags(firstTag(block, "title"));
    const link = extractLink(block);
    const rawDesc =
      firstTag(block, "description") ||
      firstTag(block, "summary") ||
      firstTag(block, "content");
    const description = stripTags(rawDesc);
    const pubDate =
      stripTags(firstTag(block, "pubDate")) ||
      stripTags(firstTag(block, "updated")) ||
      undefined;
    if (!title && !link) continue;
    items.push({ title, link, description, pubDate });
  }
  return items;
}

// excerpt = title + trimmed description. Kept short. No full-text copy.
export function buildExcerpt(item: FeedItem, maxDesc = 400): string {
  const desc = item.description.length > maxDesc
    ? item.description.slice(0, maxDesc).trimEnd() + "..."
    : item.description;
  return desc ? `${item.title} - ${desc}` : item.title;
}
