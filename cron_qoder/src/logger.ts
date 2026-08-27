export class Logger {
  readonly #secret: string | undefined;

  constructor(secret: string | undefined) {
    this.#secret = secret && secret.length > 0 ? secret : undefined;
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

  result(jobId: number, model: string, elapsedMs: number, answer: string): void {
    console.log(
      this.#line(
        "RESULT",
        `job=${jobId} model=${model} elapsed_ms=${elapsedMs} answer follows`,
      ),
    );
    console.log(this.redact(answer));
  }

  redact(value: unknown): string {
    const text = value instanceof Error ? value.message : String(value);
    return this.#secret ? text.split(this.#secret).join("[REDACTED]") : text;
  }

  #line(level: string, message: string): string {
    return `[${new Date().toISOString()}] [${level}] ${this.redact(message)}`;
  }
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}
