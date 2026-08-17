import { defineConfig } from "vitest/config";

/**
 * Coverage is measured against the modules a bug can actually hide in.
 *
 * `src/ui/**` is excluded because it is React rendered by the Paperclip host;
 * there is no DOM harness here and asserting on it would measure JSX, not
 * behaviour. `src/index.ts` and `src/manifest.ts` are declaration surfaces —
 * they are re-exports and a literal, and covering them inflates the number
 * without testing a decision.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/ui/**", "src/index.ts", "src/manifest.ts", "src/**/*.d.ts"],

      /**
       * A ratchet, not a target. These are set just under what the suite
       * currently achieves, so the build fails when coverage DROPS — the
       * failure mode worth catching is a change that quietly ships untested.
       *
       * The global number is low because two large modules are largely
       * untested (`worker.ts`, `acp-bridge.ts`). Raise these as that changes;
       * do not lower them to make a red build green.
       */
      thresholds: {
        statements: 53,
        branches: 74,
        functions: 73,
        lines: 53,

        // Modules where a regression is a user-visible failure, held higher.
        "src/decisions.ts": { statements: 95, functions: 80 },
        "src/telegram-api.ts": { statements: 85, functions: 85 },
        "src/secret-ref-validation.ts": { statements: 100, functions: 100 },
        "src/allowlist.ts": { statements: 100, functions: 100 },
      },
    },
  },
});
