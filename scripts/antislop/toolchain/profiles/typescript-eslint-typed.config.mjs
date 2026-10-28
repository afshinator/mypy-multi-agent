/**
 * Type-aware lint profile for audit runs.
 *
 * Lives in the toolchain, never in a scanned repo: it is copied to the prefix by
 * provision.sh so its imports resolve against the pinned packages rather than the
 * repo's own install. `AUDIT_TSCONFIG_ROOT` points the project service at the tree
 * under audit.
 */
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const root = process.env.AUDIT_TSCONFIG_ROOT;
if (root === undefined) {
  throw new Error("AUDIT_TSCONFIG_ROOT is required: set it to the scanned tree root");
}

export default [
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: root },
    },
    // Declared so the repo's own `eslint-disable react-hooks/...` directives resolve;
    // without it every such directive reports "Definition for rule was not found".
    plugins: { "@typescript-eslint": tseslint.plugin, "react-hooks": reactHooks },
    rules: {
      // The four families the coverage run (#110) identified as behavioural and
      // invisible to the syntactic stack, plus the two that catch a type that lies.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/restrict-template-expressions": "error",
      "@typescript-eslint/no-base-to-string": "error",
    },
  },
];
