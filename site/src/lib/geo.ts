// Build time geography. Reads the US states TopoJSON and the published map.json,
// then produces SVG path strings and centroids using d3-geo. This runs in Node
// during the Astro build, so the choropleth ships as static SVG with no client
// JavaScript required to see it. The map island enhances this same SVG.
//
// The choropleth is the FCC layer: wireless billing complaint concentration for
// all carriers. It is never per carrier. The source dataset has no carrier
// name field.

import { geoAlbersUsa, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { FeatureCollection, Feature } from "geojson";
import type { Topology, GeometryCollection } from "topojson-specification";
import topo from "../../public/data/us-states-10m.json";
import mapData from "../../public/aggregates/map.json";

// FIPS state code to USPS two letter abbreviation.
const FIPS_TO_USPS: Record<string, string> = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO",
  "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI",
  "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
  "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
  "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
  "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
  "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
  "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
  "54": "WV", "55": "WI", "56": "WY",
};

export const WIDTH = 960;
export const HEIGHT = 600;

// Five class colorblind safe sequential bins (ColorBrewer YlGnBu direction).
// Meaning is never carried by color alone. The value is always shown too.
export const BIN_VARS = [
  "var(--seq-0)",
  "var(--seq-1)",
  "var(--seq-2)",
  "var(--seq-3)",
  "var(--seq-4)",
];

export interface StateShape {
  abbr: string;
  name: string;
  path: string;
  count: number;
  bin: number; // 0..4 index into BIN_VARS, or -1 for no data
  cx: number; // centroid x, for flame placement
  cy: number;
}

export interface ChoroplethModel {
  states: StateShape[];
  thresholds: number[]; // upper bounds of bins 0..3
  maxCount: number;
  generatedAt: number;
}

function binFor(count: number, thresholds: number[]): number {
  if (count <= 0) return -1;
  for (let i = 0; i < thresholds.length; i++) {
    if (count <= thresholds[i]) return i;
  }
  return thresholds.length; // top bin
}

export function buildChoropleth(): ChoroplethModel {
  const counts = new Map<string, number>();
  for (const row of mapData.byState) counts.set(row.state, row.count);

  const topology = topo as unknown as Topology;
  const statesObj = topology.objects.states as GeometryCollection;
  const fc = feature(topology, statesObj) as unknown as FeatureCollection;

  const projection = geoAlbersUsa().fitSize([WIDTH, HEIGHT], fc);
  const path = geoPath(projection);

  const maxCount = Math.max(1, ...mapData.byState.map((r) => r.count));
  // Even quantile style thresholds across the observed range.
  const thresholds = [
    Math.round(maxCount * 0.2),
    Math.round(maxCount * 0.4),
    Math.round(maxCount * 0.6),
    Math.round(maxCount * 0.8),
  ];

  const states: StateShape[] = [];
  for (const f of fc.features as Feature[]) {
    const fips = String(f.id).padStart(2, "0");
    const abbr = FIPS_TO_USPS[fips];
    if (!abbr) continue; // territories not in the counts set
    const name = (f.properties?.name as string) ?? abbr;
    const d = path(f) ?? "";
    const centroid = path.centroid(f);
    const count = counts.get(abbr) ?? 0;
    states.push({
      abbr,
      name,
      path: d,
      count,
      bin: binFor(count, thresholds),
      cx: Number.isFinite(centroid[0]) ? Math.round(centroid[0]) : -100,
      cy: Number.isFinite(centroid[1]) ? Math.round(centroid[1]) : -100,
    });
  }

  states.sort((a, b) => a.name.localeCompare(b.name));

  return {
    states,
    thresholds,
    maxCount,
    generatedAt: mapData.generated_at,
  };
}

export function fillFor(bin: number): string {
  if (bin < 0) return "var(--surface)";
  return BIN_VARS[Math.min(bin, BIN_VARS.length - 1)];
}
