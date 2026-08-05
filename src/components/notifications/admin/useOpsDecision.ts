import { useRef, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';

/**
 * The N4 DECISION contract, shared by every operational control (kill, circuit reset, group
 * cancel, orphan resolve/requeue) — and by N7's activation controls, which carry the same
 * server-side request registry.
 *
 * Two invariants, both bought with review rounds:
 *  * ONE request id per decision, minted when the dialog opens and held across retries — the
 *    server registry replays the id, so a fresh id per press would record a second decision;
 *  * the decision INPUTS FREEZE on the first submit — the registry fingerprints the complete
 *    input, so a changed reason under the held id is conflicting reuse, not a replay. Deciding
 *    differently means cancelling and opening a new decision.
 */
export interface OpsDecision<T> {
  target: T | null;
  reason: string;
  setReason: (v: string) => void;
  busy: boolean;
  frozen: boolean;
  requestId: React.MutableRefObject<string | null>;
  open: (target: T) => void;
  close: () => void;
  /** Wraps a submit: freezes the inputs, manages busy, never mints a new id. */
  submit: (run: () => Promise<void>) => Promise<void>;
}

export function useOpsDecision<T>(): OpsDecision<T> {
  const [target, setTarget] = useState<T | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const requestId = useRef<string | null>(null);

  const open = (next: T) => {
    requestId.current = crypto.randomUUID();
    setReason('');
    setFrozen(false);
    setBusy(false);            // a previous decision's in-flight state must never leak in
    setTarget(next);
  };
  // a decision in flight cannot be dismissed: its handler would otherwise settle later and
  // close whatever dialog the operator had opened next
  const close = () => { if (!busy) setTarget(null); };
  const submit = async (run: () => Promise<void>) => {
    setBusy(true);
    setFrozen(true);
    try {
      await run();
    } finally {
      setBusy(false);
    }
  };

  return { target, reason, setReason, busy, frozen, requestId, open, close, submit };
}

/**
 * The other half of the contract, which every control on this page repeated verbatim: submit the
 * decision, read its TYPED VERDICT as a value, tell the operator what the server decided, close
 * only on success, and refresh the list the decision acted on. A thrown error keeps the dialog
 * open with the SAME request id, because retrying must replay the decision rather than mint a
 * second one — the reason the failure copy says so.
 *
 * Extracted once it was written five times (kill, circuit reset, group cancel, orphan
 * resolve/requeue, backlog disposal). Everything genuinely per-control — which RPC, which
 * arguments, how the verdict reads — stays with the caller.
 */
export function useOpsAction<T>(deps: {
  /** Call the RPC and return its typed verdict. Throwing keeps the decision open for a replay. */
  run: (target: T, reason: string, requestId: string) => Promise<string>;
  /** What the operator is told about the verdict the server returned. */
  describe: (verdict: string) => string;
  /** What the operator is told when the call itself failed. */
  failureTitle: string;
  /** Refresh whatever the decision changed. */
  onApplied: () => void;
}): OpsDecision<T> & { confirm: () => void } {
  const decision = useOpsDecision<T>();
  const { toast } = useToast();
  const confirm = () => void decision.submit(async () => {
    try {
      const verdict = await deps.run(decision.target!, decision.reason.trim(), decision.requestId.current!);
      toast({
        title: deps.describe(verdict),
        // a rejection is a real outcome, not an error — it is shown as one, loudly
        variant: verdict.startsWith('rejected') ? 'destructive' : undefined,
      });
      decision.close();
      deps.onApplied();
    } catch (error) {
      logger.error(deps.failureTitle, undefined, { error });
      toast({ title: deps.failureTitle, variant: 'destructive' });
    }
  });
  return { ...decision, confirm };
}
