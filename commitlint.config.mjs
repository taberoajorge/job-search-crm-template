// Keep `attribution` in sync with scripts/git-delivery.ts; git-delivery.test.ts runs both on the same samples.
const attribution =
  /(?:co[-\s\u2010-\u2015]?authored|assisted|co[-\s\u2010-\u2015]?developed)[-\s\u2010-\u2015]*by\s*:|(?:generated|created|written|made|built)\s+(?:with|by|using)\s+\[?(?:claude|codex|cursor|copilot|chatgpt|gemini|openai|anthropic)|noreply@anthropic\.com|\u{1F916}/iu;
export default {
  extends: ["@commitlint/config-conventional"],
  // Merge commits stay rejected; git's revert and local fixup/squash messages are allowed unless they carry attribution.
  defaultIgnores: false,
  ignores: [
    (message) =>
      /^(?:Revert ".+"|(?:fixup|squash|amend)! )/.test(message) && !attribution.test(message),
  ],
  plugins: [
    {
      rules: {
        "no-attribution": ({ raw }) => [
          !attribution.test(raw),
          "Remove attribution trailers and footers.",
        ],
      },
    },
  ],
  rules: { "no-attribution": [2, "always"] },
};
