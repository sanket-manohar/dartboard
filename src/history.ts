import * as vscode from 'vscode';

export interface Snapshot {
  time: number;
  commit?: string;
  found: number;
  hit: number;
  /** key -> [hit, found]. Only kept on the most recent snapshots to save space. */
  files?: Record<string, [number, number]>;
}

const KEY = 'dartboard.history';
const SIGNATURE_KEY = 'dartboard.historySignature';
const MAX = 100;
const KEEP_FILES = 3;

/** Remembers coverage after each test run (per workspace) for trend arrows and the history chart. */
export class History {
  constructor(private readonly memento: vscode.Memento) {}

  list(): Snapshot[] {
    return this.memento.get<Snapshot[]>(KEY, []);
  }

  /** The snapshot before the latest one, used as the baseline for trend arrows. */
  previous(): Snapshot | undefined {
    const all = this.list();
    return all.length >= 2 ? all[all.length - 2] : undefined;
  }

  latest(): Snapshot | undefined {
    const all = this.list();
    return all[all.length - 1];
  }

  /** Records a snapshot unless the reports haven't changed since the last one. Returns true when recorded. */
  async record(signature: string, snapshot: Snapshot): Promise<boolean> {
    if (this.memento.get<string>(SIGNATURE_KEY) === signature) {
      return false;
    }
    const all = this.list();
    all.push(snapshot);
    while (all.length > MAX) {
      all.shift();
    }
    for (let i = 0; i < all.length - KEEP_FILES; i++) {
      delete all[i].files;
    }
    await this.memento.update(KEY, all);
    await this.memento.update(SIGNATURE_KEY, signature);
    return true;
  }

  async clear(): Promise<void> {
    await this.memento.update(KEY, []);
    await this.memento.update(SIGNATURE_KEY, undefined);
  }
}
