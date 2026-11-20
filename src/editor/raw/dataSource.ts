// The source view's language and syntax colours for a JSON or YAML file.
// app.css supplies the colours per document theme as `--md-src-*` variables.
// JSON follows VS Code's default theming (Light+ and Dark+), as the Markdown
// view does. A YAML file takes the colours of a Markdown file's frontmatter:
// keys, quoted text, comments and anchors each have a colour, and every plain
// value has one colour, because the parser does not tell a plain number,
// `true` or `null` from other plain text. VS Code colours those apart.

import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, type LanguageSupport } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { DocumentLanguage } from "../../files/documentLanguage";

/** The CodeMirror language of a JSON or YAML file. */
export function dataSource(language: Exclude<DocumentLanguage, "markdown">): LanguageSupport {
  return language === "json" ? json() : yaml();
}

const color = (name: string): string => `var(--md-src-${name})`;

// Later rules win where a token carries several tags. Lezer tags a YAML key
// as a definition of a property name, and its plain values as content.
export const dataHighlightStyle = HighlightStyle.define([
  { tag: t.content, color: color("yaml-value") },
  { tag: t.string, color: color("string") },
  { tag: t.special(t.string), color: color("keyword") },
  { tag: t.number, color: color("number") },
  { tag: [t.bool, t.null, t.keyword], color: color("keyword") },
  { tag: t.propertyName, color: color("property") },
  { tag: t.definition(t.propertyName), color: color("yaml-key") },
  { tag: [t.labelName, t.typeName], color: color("anchor") },
  { tag: t.attributeValue, color: color("attribute-value") },
  { tag: t.comment, color: color("comment") },
]);
