// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// Static output. No SSR adapter in phase 1. The built ./dist is served later as
// Cloudflare Workers static assets. See README for deploy-later steps.
export default defineConfig({
  site: "https://carriersonnotice.com",
  output: "static",
  trailingSlash: "ignore",
  integrations: [sitemap()],
  build: {
    format: "directory",
  },
});
