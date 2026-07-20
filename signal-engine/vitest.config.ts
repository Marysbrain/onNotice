import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// Read the D1 migrations at config time and hand them to the test worker as a
// binding. Tests apply them into the local D1 in beforeAll.
const migrations = await readD1Migrations(path.join(here, "migrations"));

// Bindings are declared inline here rather than via wrangler.configPath. That is
// deliberate: the production wrangler.jsonc has a Workers AI binding, and AI has
// no local emulation, so loading it would make every test run open a remote
// connection (network plus credentials). The tests never call AI (they inject a
// stub classifier), so the test worker simply omits that binding. D1, R2, and KV
// all run locally in miniflare.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-07-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { DB: "signal_engine_test" },
        r2Buckets: { RAW: "signal-engine-raw-test" },
        kvNamespaces: { CONFIG: "config_test" },
        bindings: { TEST_MIGRATIONS: migrations, ENVIRONMENT: "test" },
      },
    }),
  ],
});
