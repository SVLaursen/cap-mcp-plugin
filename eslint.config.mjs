import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["lib/**", "coverage/**", "node_modules/**", "demo/gen/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // v1 had 76 `as any`. v2 keeps casts visible and rare.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='global'][property.name='cds']",
          message: "Do not read global.cds. Receive `cds` as a parameter (see ADR 0005).",
        },
      ],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='jest'][callee.property.name='mock'][arguments.0.value='@sap/cds']",
          message:
            "Never mock @sap/cds. Use cds.test or compile a CDS snippet (see docs/testing.md).",
        },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        process: "readonly",
        __dirname: "readonly",
        console: "readonly",
        // CAP query globals
        SELECT: "readonly",
        INSERT: "readonly",
        UPSERT: "readonly",
        UPDATE: "readonly",
        DELETE: "readonly",
      },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
