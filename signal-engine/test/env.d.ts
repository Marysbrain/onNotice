/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { Env as WorkerEnv } from "../src/env.js";
import type { D1Migration } from "cloudflare:test";

// `env` from cloudflare:test is typed as Cloudflare.Env. Give it our worker
// bindings plus the migrations binding we inject in vitest.config.ts.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
