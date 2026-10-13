const start = Date.now();

function stamp(): string {
  const s = ((Date.now() - start) / 1000).toFixed(1).padStart(7);
  return `[${s}s]`;
}

export const log = {
  info: (tag: string, ...args: unknown[]) => console.log(stamp(), tag.padEnd(9), ...args),
  warn: (tag: string, ...args: unknown[]) => console.warn(stamp(), tag.padEnd(9), 'WARN', ...args),
  error: (tag: string, ...args: unknown[]) => console.error(stamp(), tag.padEnd(9), 'ERROR', ...args),
};
