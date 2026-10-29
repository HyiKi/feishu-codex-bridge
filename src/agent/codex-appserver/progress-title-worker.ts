import { tmpdir } from 'node:os';
import type { GenerateSessionTitleOptions } from '../types';
import { AppServerClient } from './app-server-client';
import { generateCodexSessionTitleWithClient } from './backend';
import { resolveCodexBin } from './locate';

/** Cold start includes app-server + model warmup (~17s measured); reuse makes
 * subsequent title calls ~2.5s. The main run is never blocked by this deadline. */
const DEFAULT_TIMEOUT_MS = 25_000;
const IDLE_CLOSE_MS = 10 * 60_000;

export interface ProgressTitleWorkerInput extends GenerateSessionTitleOptions {
  timeoutMs?: number;
}

/**
 * One warm, isolated app-server process for background progress titles. Reusing
 * the process avoids paying spawn+initialize on every reasoning phase while the
 * ephemeral title thread keeps each request free of conversation memory.
 */
export class CodexProgressTitleWorker {
  private client?: AppServerClient;
  private connecting?: Promise<AppServerClient>;
  private busy = false;
  private idleTimer?: ReturnType<typeof setTimeout>;

  async prepare(): Promise<void> {
    this.clearIdleTimer();
    try {
      await this.ensureClient();
    } finally {
      this.scheduleIdleClose();
    }
  }

  async generate(input: ProgressTitleWorkerInput): Promise<string | undefined> {
    if (this.busy) return undefined;
    this.busy = true;
    this.clearIdleTimer();

    let client: AppServerClient | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      client = await this.ensureClient();
      client.clearNotifications();
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const work = generateCodexSessionTitleWithClient(client, {
        cwd: input.cwd,
        prompt: input.prompt,
        model: input.model,
        effort: input.effort,
      });
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          void this.discard(client);
          resolve(undefined);
        }, timeoutMs);
        timer.unref?.();
      });
      return await Promise.race([work, timeout]);
    } catch (error) {
      await this.discard(client);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.busy = false;
      this.scheduleIdleClose();
    }
  }

  async close(): Promise<void> {
    this.clearIdleTimer();
    await this.discard(this.client);
  }

  private async ensureClient(): Promise<AppServerClient> {
    if (this.client && !this.client.exited) return this.client;
    if (this.connecting) return this.connecting;

    const bin = resolveCodexBin();
    if (!bin) throw new Error('codex CLI not found for progress title worker');
    const client = new AppServerClient({
      bin,
      cwd: tmpdir(),
      clientName: 'feishu-codex-bridge-progress-title',
    });
    const connecting = (async () => {
      await client.connect();
      this.client = client;
      return client;
    })();
    this.connecting = connecting;
    try {
      return await connecting;
    } catch (error) {
      if (this.client === client) this.client = undefined;
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      if (this.connecting === connecting) this.connecting = undefined;
    }
  }

  private async discard(client: AppServerClient | undefined): Promise<void> {
    if (!client) return;
    if (this.client === client) this.client = undefined;
    await client.close().catch(() => undefined);
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    if (!this.client || this.busy) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.discard(this.client);
    }, IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
