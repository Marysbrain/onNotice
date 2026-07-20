// Sample evidence records for the phase 1 library.
//
// These are SAMPLE records. They show the shape of a real evidence record and
// its citation block. The sources and source URLs are real public documents.
// The facts stated are accurate at the general level shown and trace to the
// linked source. Excerpts are short paraphrases, not verbatim quotes, marked
// as paraphrase. No invented facts are presented as real. Every record here
// carries sample: true and the UI shows a SAMPLE badge wherever it displays.
//
// Vetting ladder (see methodology): single_source, corroborated,
// verified_primary. Public counts include only corroborated and
// verified_primary. One single_source sample is included to show a record that
// does not feed the public count.

export type Vetting = "single_source" | "corroborated" | "verified_primary";

export interface EvidenceRecord {
  slug: string;
  title: string;
  // carrier is null when the source carries no carrier name (for example the
  // FCC complaint dataset). Carrier filtering only applies to carrier-tagged
  // records.
  carrier: "att" | "verizon" | "tmobile" | null;
  claimType: string;
  // USPS two letter state, or null for national scope sources.
  state: string | null;
  eventDate: string; // YYYY-MM-DD or YYYY
  vetting: Vetting;
  sample: true;
  claim: string;
  sourceName: string;
  sourceUrl: string;
  captureDate: string; // YYYY-MM-DD
  excerpt: string; // short paraphrase, not a verbatim quote
  archiveUrl: string; // Wayback lookup for the source URL
}

const CARRIER_LABEL: Record<string, string> = {
  att: "AT&T",
  verizon: "Verizon",
  tmobile: "T-Mobile",
};

export function carrierLabel(c: string | null): string {
  if (!c) return "No carrier on this source";
  return CARRIER_LABEL[c] ?? c;
}

export const CLAIM_TYPES = [
  "Unauthorized charges",
  "Data throttling",
  "Billing complaint volume",
  "Promotion terms",
  "Arbitration volume",
  "Regulatory docket",
  "Litigation",
] as const;

export const records: EvidenceRecord[] = [
  {
    slug: "ftc-att-unlimited-throttling-2014",
    title: "FTC action over AT&T unlimited data throttling",
    carrier: "att",
    claimType: "Data throttling",
    state: null,
    eventDate: "2014-10-28",
    vetting: "verified_primary",
    sample: true,
    claim:
      "The FTC alleged that AT&T Mobility reduced data speeds for customers on unlimited plans after they used a set amount of data in a billing cycle, without adequately telling them.",
    sourceName: "Federal Trade Commission, press release",
    sourceUrl:
      "https://www.ftc.gov/news-events/news/press-releases/2014/10/ftc-says-att-has-misled-millions-consumers-unlimited-data-promises",
    captureDate: "2026-07-20",
    excerpt:
      "Paraphrase: the agency says the company slowed data for unlimited plan customers who passed a monthly usage threshold.",
    archiveUrl:
      "https://web.archive.org/web/2024/https://www.ftc.gov/news-events/news/press-releases/2014/10/ftc-says-att-has-misled-millions-consumers-unlimited-data-promises",
  },
  {
    slug: "ftc-att-mobile-cramming-2014",
    title: "AT&T settlement over unauthorized third party charges",
    carrier: "att",
    claimType: "Unauthorized charges",
    state: null,
    eventDate: "2014-10-08",
    vetting: "verified_primary",
    sample: true,
    claim:
      "AT&T agreed to a settlement to provide refunds to consumers the FTC said were billed for unauthorized third party charges, a practice known as mobile cramming.",
    sourceName: "Federal Trade Commission, press release",
    sourceUrl:
      "https://www.ftc.gov/news-events/news/press-releases/2014/10/att-pay-80-million-ftc-provide-refunds-consumers-harmed-mobile-cramming-scheme",
    captureDate: "2026-07-20",
    excerpt:
      "Paraphrase: the company will provide refunds to customers billed for charges they did not authorize.",
    archiveUrl:
      "https://web.archive.org/web/2024/https://www.ftc.gov/news-events/news/press-releases/2014/10/att-pay-80-million-ftc-provide-refunds-consumers-harmed-mobile-cramming-scheme",
  },
  {
    slug: "ftc-tmobile-cramming-2014",
    title: "FTC action over T-Mobile third party charges",
    carrier: "tmobile",
    claimType: "Unauthorized charges",
    state: null,
    eventDate: "2014-07-01",
    vetting: "verified_primary",
    sample: true,
    claim:
      "The FTC alleged that T-Mobile US billed customers for unauthorized third party charges on their phone bills.",
    sourceName: "Federal Trade Commission, press release",
    sourceUrl:
      "https://www.ftc.gov/news-events/news/press-releases/2014/07/ftc-alleges-t-mobile-us-inc-crammed-bogus-charges-onto-customers-phone-bills",
    captureDate: "2026-07-20",
    excerpt:
      "Paraphrase: the agency says the company placed charges from third parties on bills without authorization.",
    archiveUrl:
      "https://web.archive.org/web/2024/https://www.ftc.gov/news-events/news/press-releases/2014/07/ftc-alleges-t-mobile-us-inc-crammed-bogus-charges-onto-customers-phone-bills",
  },
  {
    slug: "fcc-consumer-complaints-dataset",
    title: "FCC consumer complaints open dataset",
    carrier: null,
    claimType: "Billing complaint volume",
    state: null,
    eventDate: "2026",
    vetting: "verified_primary",
    sample: true,
    claim:
      "The FCC publishes informal consumer complaint data with city, state, and ZIP, updated regularly. This dataset has no carrier name field, so it shows wireless billing complaint concentration for all carriers, never per carrier counts.",
    sourceName: "FCC open data portal, CGB Consumer Complaints Data",
    sourceUrl:
      "https://opendata.fcc.gov/Consumer/CGB-Consumer-Complaints-Data/3xyp-aqkj",
    captureDate: "2026-07-20",
    excerpt:
      "Paraphrase: the open dataset records informal complaints by location and issue, without naming the company complained about.",
    archiveUrl:
      "https://web.archive.org/web/2024/https://opendata.fcc.gov/Consumer/CGB-Consumer-Complaints-Data/3xyp-aqkj",
  },
  {
    slug: "aaa-consumer-arbitration-data",
    title: "AAA consumer arbitration case data",
    carrier: null,
    claimType: "Arbitration volume",
    state: null,
    eventDate: "2026",
    vetting: "corroborated",
    sample: true,
    claim:
      "The American Arbitration Association publishes consumer arbitration case data. Because the respondent company is named in these filings, this source can support per company dispute counts, unlike the FCC complaint dataset.",
    sourceName: "American Arbitration Association, consumer resources",
    sourceUrl: "https://www.adr.org/consumer",
    captureDate: "2026-07-20",
    excerpt:
      "Paraphrase: the provider makes consumer arbitration case information available, with the responding business named.",
    archiveUrl: "https://web.archive.org/web/2024/https://www.adr.org/consumer",
  },
  {
    slug: "fcc-truth-in-billing-docket",
    title: "FCC Truth in Billing docket CC 98-170",
    carrier: null,
    claimType: "Regulatory docket",
    state: null,
    eventDate: "2026",
    vetting: "corroborated",
    sample: true,
    claim:
      "The FCC maintains a public docket on truth in billing and billing format. Filings in the docket are public and searchable through the Electronic Comment Filing System.",
    sourceName: "FCC Electronic Comment Filing System",
    sourceUrl: "https://www.fcc.gov/ecfs/search/search-filings/results?q=(proceedings.name:%2298-170%22)",
    captureDate: "2026-07-20",
    excerpt:
      "Paraphrase: the proceeding addresses how carriers present charges on consumer bills, with public filings on the record.",
    archiveUrl:
      "https://web.archive.org/web/2024/https://www.fcc.gov/ecfs/",
  },
  {
    slug: "sec-edgar-carrier-disclosures",
    title: "Carrier device financing disclosures in SEC filings",
    carrier: "verizon",
    claimType: "Promotion terms",
    state: null,
    eventDate: "2026",
    vetting: "corroborated",
    sample: true,
    claim:
      "Wireless carriers disclose device promotion and equipment installment economics in their SEC filings. These filings are public and full text searchable through EDGAR.",
    sourceName: "US Securities and Exchange Commission, EDGAR full text search",
    sourceUrl: "https://efts.sec.gov/LATEST/search-index?q=%22device+promotion%22",
    captureDate: "2026-07-20",
    excerpt:
      "Paraphrase: annual and quarterly filings describe how device promotions and installment billing work for the company.",
    archiveUrl:
      "https://web.archive.org/web/2024/https://www.sec.gov/cgi-bin/browse-edgar",
  },
  {
    slug: "courtlistener-wireless-promotion-docket",
    title: "Filed wireless promotion complaint on CourtListener",
    carrier: "att",
    claimType: "Litigation",
    state: "CA",
    eventDate: "2026",
    vetting: "single_source",
    sample: true,
    claim:
      "CourtListener hosts filed federal complaints and dockets that name companies. A filed complaint is an allegation, not a finding. This record is single source and does not feed the public verified count.",
    sourceName: "CourtListener, Free Law Project",
    sourceUrl: "https://www.courtlistener.com/?q=wireless%20device%20promotion",
    captureDate: "2026-07-20",
    excerpt:
      "Paraphrase: a complaint on the public docket alleges a wireless device promotion practice. Allegation only.",
    archiveUrl:
      "https://web.archive.org/web/2024/https://www.courtlistener.com/",
  },
];

export function getRecord(slug: string): EvidenceRecord | undefined {
  return records.find((r) => r.slug === slug);
}
