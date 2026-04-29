// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: [
            "dist/**",
            "dist-test/**",
            "node_modules/**",
            "*.vsix",
            "media/**",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            // The codebase relies on the `import * as vscode from "vscode"`
            // namespace pattern; named imports would force every call site to
            // list each enum/class individually. Allow it.
            "@typescript-eslint/no-namespace": "off",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
            "no-console": "off",
            "prefer-const": "error",
            eqeqeq: ["error", "smart"],
        },
    },
    {
        files: ["src/**/__tests__/**/*.ts"],
        rules: {
            // Tests deliberately reach into "private" shapes via casts.
            "@typescript-eslint/no-explicit-any": "off",
        },
    }
);
