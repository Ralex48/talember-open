import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".wrangler/**", "coverage/**", "dist/**", "node_modules/**", "public/scripts/**", "worker-configuration.d.ts", "test-results/**"] },
  {
    files: ["app/**/*.ts", "tests/service/**/*.ts"],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended]
  }
);
