/**
 * Reconciling what a model wanted with what the classifier decided.
 *
 * The realtime brain has a language model with tool calls, and a language model
 * asked to be helpful will occasionally decide that "John, make sure you finish
 * the auth refactor by Sunday" is a job for it. That is the single failure this
 * product cannot ship, so the model does not get the final say on it.
 *
 * The split of authority:
 *
 *   The deterministic classifier owns the ACT / DON'T-ACT axis.
 *     Whether this sentence was addressed to Lily is not a judgement call the
 *     model gets to make, because when it is wrong it is wrong in the direction
 *     of reaching into someone's machine.
 *
 *   The model may REFINE within a class.
 *     Given a question that is definitely being routed, the model may pick a
 *     better recipient than keyword overlap did — it has the job descriptions
 *     and the conversation. That cannot cause an unasked-for action; it can only
 *     change who gets asked something read-only.
 *
 * Every veto is logged, because a model that keeps trying to act on human
 * assignments is a prompt problem worth seeing in the metrics.
 */

import type { Classification } from '../classify.js';
import { log } from '../util/log.js';
import type { Roster } from '../roster.js';

export type ModelIntent =
  | {
      readonly kind: 'dispatch';
      readonly employeeId: string;
      readonly question: string;
      readonly mode: 'read_only' | 'standard';
    }
  | {
      readonly kind: 'record_assignment';
      readonly ownerEmployeeId: string;
      readonly text: string;
      readonly due: string | null;
    }
  | { readonly kind: 'act'; readonly instruction: string }
  | { readonly kind: 'none'; readonly reason: string };

export interface Reconciliation {
  readonly classification: Classification;
  /** True when the model asked for something the classifier would not allow. */
  readonly vetoed: boolean;
}

export function reconcile(
  classification: Classification,
  intent: ModelIntent,
  roster: Roster,
): Reconciliation {
  switch (classification.kind) {
    case 'human_assignment': {
      // The hard case. Nothing the model says promotes this to an action.
      const wantedToAct = intent.kind === 'dispatch' || intent.kind === 'act';
      if (wantedToAct) {
        log.warn('brain.intent_vetoed', {
          rule: classification.rule,
          modelIntent: intent.kind,
          classified: classification.kind,
        });
      }
      return { classification, vetoed: wantedToAct };
    }

    case 'chatter': {
      const wantedToAct = intent.kind !== 'none';
      if (wantedToAct) {
        log.warn('brain.intent_vetoed', {
          rule: classification.rule,
          modelIntent: intent.kind,
          classified: classification.kind,
        });
      }
      return { classification, vetoed: wantedToAct };
    }

    case 'routed_question': {
      // Refinement is allowed: a different recipient for a read-only question.
      if (intent.kind === 'dispatch') {
        const target = roster.byId(intent.employeeId);
        if (target !== null && target.employeeId !== classification.target.employeeId) {
          log.info('brain.target_refined', {
            from: classification.target.employeeId,
            to: target.employeeId,
          });
          return {
            classification: { ...classification, target, mode: 'read_only' },
            vetoed: false,
          };
        }
      }
      // A model that wants to escalate a question into a mutating task does not
      // get to; `mode` stays read_only because the sentence was a question.
      return { classification, vetoed: intent.kind === 'act' };
    }

    case 'lily_action':
      return { classification, vetoed: false };
  }
}
