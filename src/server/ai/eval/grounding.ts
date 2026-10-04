// "No fabricated numbers": every number the answer states must appear in what the tools returned (or the question).
// Link targets are ignored (ids live there), thousands separators are normalised, and a number only counts as
// present when it stands on its own — "5" is not found inside "15" or "5.5".

const normalise = (s: string) => s.replace(/(\d),(?=\d{3}\b)/g, "$1");

export function numbersIn(text: string): string[] {
  const visible = normalise(text.replace(/\]\([^)]*\)/g, "]"));
  return [...new Set(visible.match(/\d+(?:\.\d+)?/g) ?? [])];
}

export function ungroundedNumbers(answer: string, sources: string[]): string[] {
  const corpus = normalise(sources.join("\n"));
  const present = (n: string) => new RegExp(`(?<![\\d.])${n.replace(".", "\\.")}(?![\\d]|\\.\\d)`).test(corpus);
  return numbersIn(answer).filter((n) => !present(n));
}
