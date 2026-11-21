import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/supabase/service.ts"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: "Identifier[name='SUPABASE_SERVICE_ROLE_KEY'], Literal[value='SUPABASE_SERVICE_ROLE_KEY']",
          message: "Construct service-role clients only in src/lib/supabase/service.ts." },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "next-env.d.ts", "node_modules/**"]),
]);
