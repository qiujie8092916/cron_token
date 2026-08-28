export class Logger {
  readonly #secrets: readonly string[];

  constructor(secrets: readonly (string | undefined)[] = []) {
    this.#secrets = secrets.filter((secret): secret is string => Boolean(secret));
  }

  info(message: string): void {
    console.log(this.#line("INFO", message));
  }

  warn(message: string): void {
    console.warn(this.#line("WARN", message));
  }

  error(message: string): void {
    console.error(this.#line("ERROR", message));
  }

  result(message: string): void {
    console.log(this.#line("RESULT", message));
  }

  redact(value: unknown): string {
    let text = value instanceof Error ? value.message : String(value);
    for (const secret of this.#secrets) {
      text = text.split(secret).join("[REDACTED]");
    }
    return text;
  }

  #line(level: string, message: string): string {
    return `[${new Date().toISOString()}] [${level}] ${this.redact(message)}`;
  }
}

export function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
