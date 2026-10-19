export interface TunnelHealthTransition {
  at: string;
  ready: boolean;
}

export interface TunnelHealthSnapshot {
  checkedAt?: string;
  ready?: boolean;
  readySince?: string;
  lastTransitionAt?: string;
  transitionCount: number;
  recentTransitions: TunnelHealthTransition[];
}

export class TunnelHealthHistory {
  private checkedAt?: string;
  private ready?: boolean;
  private readySince?: string;
  private readonly transitions: TunnelHealthTransition[] = [];
  private transitionCount = 0;

  constructor(private readonly limit = 40) {}

  sample(ready: boolean, at = new Date().toISOString()): TunnelHealthTransition | undefined {
    this.checkedAt = at;
    if (this.ready === undefined) {
      this.ready = ready;
      this.readySince = ready ? at : undefined;
      return undefined;
    }
    if (this.ready === ready) return undefined;

    this.ready = ready;
    this.readySince = ready ? at : undefined;
    const transition = { at, ready };
    this.transitionCount += 1;
    this.transitions.unshift(transition);
    if (this.transitions.length > this.limit) this.transitions.length = this.limit;
    return transition;
  }

  snapshot(): TunnelHealthSnapshot {
    return {
      checkedAt: this.checkedAt,
      ready: this.ready,
      readySince: this.readySince,
      lastTransitionAt: this.transitions[0]?.at,
      transitionCount: this.transitionCount,
      recentTransitions: this.transitions.slice(),
    };
  }
}
