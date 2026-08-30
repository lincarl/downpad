// Word count for the status bar. Counts whitespace-delimited tokens of the
// markdown source — a deliberately simple measure; refined counting (excluding
// syntax) can come later.

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return (trimmed.match(/\S+/g) ?? []).length;
}
