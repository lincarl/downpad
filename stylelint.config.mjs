export default {
  extends: ["stylelint-config-standard"],
  rules: {
    "at-rule-no-unknown": [
      true,
      {
        ignoreAtRules: [
          "apply",
          "config",
          "custom-variant",
          "plugin",
          "reference",
          "source",
          "theme",
          "utility",
          "variant",
        ],
      },
    ],
    // Tailwind's package import intentionally uses its documented string form.
    "import-notation": null,
    // ProseMirror and CodeMirror own these public class names.
    "selector-class-pattern": [
      "^([a-z][a-z0-9]*)(-[a-z0-9]+)*$|^(ProseMirror|cm-activeLine|cm-activeLineGutter)$",
    ],
    // WebKit masks still need the prefixed declaration in Safari.
    "property-no-vendor-prefix": [true, { ignoreProperties: ["-webkit-mask"] }],
    // Tailwind's @utility blocks scope `&` to the utility class they generate.
    "nesting-selector-no-missing-scoping-root": [true, { ignoreAtRules: ["utility"] }],
  },
};
