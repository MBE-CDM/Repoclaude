import type { Store } from '../core/store.js';
import type { ProdPolicy } from '../core/config.js';
import type { Principal } from './auth.js';
import { hasRole } from './auth.js';
import type { AuditLog } from './audit.js';

export interface ApprovalAction { type: 'execution' | 'sql'; summary: string; payload: unknown }

export interface Approval {
  id: string;
  environmentId: string;
  environmentName: string;
  requestedBy: string;
  requestedAt: string;
  action: ApprovalAction;
  status: 'pending' | 'approved' | 'rejected' | 'executed';
  required: number;
  decisions: { user: string; decision: 'approve' | 'reject'; at: string; comment?: string }[];
}

export class ProductionGuardError extends Error {
  constructor(message: string, public approvalId?: string) { super(message); }
}

/**
 * Garde-fou production : selon la politique, toute action sur un environnement de production
 * est interdite, ou soumise à une double validation (2 valideurs distincts, autres que le demandeur).
 */
export class ProductionGuard {
  constructor(private store: Store, private policy: ProdPolicy, private audit: AuditLog) {}

  /**
   * Vérifie l'autorisation. Si l'environnement est de production :
   *  - politique 'forbid' → ProductionGuardError ;
   *  - 'dual-approval' : sans approvalId valide → crée une demande et lève ProductionGuardError(approvalId).
   */
  check(env: { id: string; name: string; isProduction?: boolean }, who: Principal, action: ApprovalAction, approvalId?: string): void {
    if (!env.isProduction) return;
    if (this.policy === 'forbid') {
      this.audit.record({ actor: who.name, environment: env.name, kind: 'approval', target: action.summary, outcome: 'blocked', detail: { reason: 'production interdite' } });
      throw new ProductionGuardError(`Exécution interdite sur l'environnement de production « ${env.name} »`);
    }
    if (approvalId) {
      const a = this.store.get<Approval>('approvals', approvalId);
      if (!a || a.environmentId !== env.id || a.status !== 'approved') {
        throw new ProductionGuardError(`La demande de validation ${approvalId} n'est pas approuvée pour cet environnement`, approvalId);
      }
      if (a.action.type !== action.type) throw new ProductionGuardError('La validation ne correspond pas à cette action', approvalId);
      a.status = 'executed';
      this.store.put('approvals', a);
      return;
    }
    const a = this.request(env, who, action);
    throw new ProductionGuardError(`Environnement de production : double validation requise (demande ${a.id})`, a.id);
  }

  request(env: { id: string; name: string }, who: Principal, action: ApprovalAction): Approval {
    const a = this.store.put<Omit<Approval, 'id'>>('approvals', {
      environmentId: env.id, environmentName: env.name, requestedBy: who.name, requestedAt: new Date().toISOString(),
      action, status: 'pending', required: 2, decisions: [],
    });
    this.audit.record({ actor: who.name, environment: env.name, kind: 'approval', target: action.summary, outcome: 'pending', detail: { approvalId: a.id } });
    return a;
  }

  decide(id: string, who: Principal, decision: 'approve' | 'reject', comment?: string): Approval {
    const a = this.store.get<Approval>('approvals', id);
    if (!a) throw new Error('Demande introuvable');
    if (a.status !== 'pending') throw new Error(`Demande déjà ${a.status}`);
    if (!hasRole(who, 'approver')) throw new Error('Rôle valideur requis');
    if (who.name === a.requestedBy) throw new Error('Le demandeur ne peut pas valider sa propre demande');
    if (a.decisions.some(d => d.user === who.name)) throw new Error('Vous avez déjà donné votre décision');
    a.decisions.push({ user: who.name, decision, at: new Date().toISOString(), comment });
    if (decision === 'reject') a.status = 'rejected';
    else if (a.decisions.filter(d => d.decision === 'approve').length >= a.required) a.status = 'approved';
    this.store.put('approvals', a);
    this.audit.record({ actor: who.name, environment: a.environmentName, kind: 'approval', target: a.action.summary, outcome: decision === 'approve' ? 'success' : 'blocked', detail: { approvalId: id, decision, status: a.status } });
    return a;
  }

  list(status?: Approval['status']) {
    return this.store.list<Approval>('approvals').filter(a => !status || a.status === status).reverse();
  }
}
