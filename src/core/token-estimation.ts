/** Approximate tokenizer for preflight only; provider usage remains the accounting source when available. */
export function estimateSerializedPromptTokens(value: unknown, framingTokens = 0): number {
  const text = JSON.stringify(value);
  let tokens = framingTokens;
  let asciiWordRun = 0;
  const flushWord = (): void => {
    tokens += Math.ceil(asciiWordRun / 4);
    asciiWordRun = 0;
  };
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x7f) {
      flushWord();
      tokens += 1;
    } else if (/[A-Za-z0-9]/.test(char)) {
      asciiWordRun += 1;
    } else {
      flushWord();
      if (!/\s/.test(char)) tokens += 1;
    }
  }
  flushWord();
  return tokens;
}

export function estimateTextTokens(text: string): number {
  let tokens = 0;
  let asciiWordRun = 0;
  const flushWord = (): void => {
    tokens += Math.ceil(asciiWordRun / 4);
    asciiWordRun = 0;
  };
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x7f) {
      flushWord();
      tokens += 1;
    } else if (/[A-Za-z0-9]/.test(char)) {
      asciiWordRun += 1;
    } else {
      flushWord();
      if (!/\s/.test(char)) tokens += 1;
    }
  }
  flushWord();
  return tokens;
}
