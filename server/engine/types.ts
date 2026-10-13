import type {
  EngineKind, GhostParams, LiveOpenParams, OpenParams, PedalAction, PedalStep, PendingOrder, PositionState, SignRequest,
} from '../../shared/types.js';

export type EngineEventKind =
  | 'opened' | 'closed' | 'liquidated' | 'adjusted' | 'stop_set' | 'stop_hit' | 'tx' | 'fill' | 'error' | 'info' | 'warn'
  | 'sign_request' | 'order_placed' | 'order_filled' | 'order_cancelled';

export interface EngineEvent {
  kind: EngineEventKind;
  message: string;
  detail?: unknown;
}

export interface PedalResult {
  ok: boolean;
  message: string;
  /** Live engine: a transaction that must be signed by the wallet. */
  sign?: SignRequest;
  events?: EngineEvent[];
  /** Live engine: submitted in the background; the fill is detected from the position. */
  pending?: boolean;
}

/**
 * The thin pedal adapter. Paper and live engines expose the same interface so the session,
 * the kinematics and the renderer never know which one is running (spec section 4).
 */
export interface Engine {
  readonly kind: EngineKind;
  position: PositionState | null;
  pendingOrder: PendingOrder | null;
  /** USD available to add as collateral: paper bankroll, or wallet balance for live. */
  freeCollateralUsd(): number;
  open(p: OpenParams | LiveOpenParams, price: number): Promise<PedalResult>;
  cancelOrder(): Promise<PedalResult>;
  pedal(a: PedalAction, price: number, steps: PedalStep, maxSlippageBps: number): Promise<PedalResult>;
  /** Called every tick: fee accrual, liquidation check, trailing stop, limit fills. Returns events. */
  tick(t: number, price: number, hourlyBorrowRate: number | null): EngineEvent[];
  reset(): void;
}

export type GhostPreview = Pick<GhostParams, 'side' | 'leverage' | 'collateralUsd' | 'entry'>;
