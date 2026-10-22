import type { Unsubscribe } from '@tw/shared';

/** Minimal typed event hub used instead of EventEmitter (browser-safe, `Unsubscribe` style). */
export class Emitter<T> {
  private readonly handlers = new Set<(value: T) => void>();

  constructor(private readonly onListenerError?: (error: unknown) => void) {}

  on(handler: (value: T) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(value: T): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(value);
      } catch (error) {
        this.onListenerError?.(error);
      }
    }
  }

  get size(): number {
    return this.handlers.size;
  }

  clear(): void {
    this.handlers.clear();
  }
}
