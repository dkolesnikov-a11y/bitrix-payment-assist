// Task 1.2 laboratory prototype. No credentials, network transport, or production wiring.
import { DatabaseSync } from 'node:sqlite';

const PARTIAL = 'DT1078_31:UC_WEUS73';
const SUCCESS = 'DT1078_31:SUCCESS';
export const paymentStartStages=new Set([PARTIAL,'DT1078_31:CLIENT','DT1078_31:PREPARATION']);
const assert = (condition, code) => { if (!condition) throw new Error(code); };
const integer = value => Number.isSafeInteger(value) && value > 0;
export function cents(value) {
  assert(typeof value === 'string' && /^\d+(?:\.\d{1,2})?\|RUB$/.test(value), 'INVALID_MONEY');
  const [whole, fraction = ''] = value.split('|')[0].split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  assert(result <= BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_MONEY');
  return Number(result);
}
export function rub(value) {
  assert(Number.isSafeInteger(value) && value >= 0, 'INVALID_CENTS');
  const exact = BigInt(value);
  return `${exact / 100n}.${String(exact % 100n).padStart(2, '0')}|RUB`;
}
export function snapshot(item) {
  assert(integer(item.id) && integer(item.parentId2), 'INVALID_IDENTITY');
  assert(item.currencyId === 'RUB' && item.categoryId === 31, 'INVALID_CONTEXT');
  assert(typeof item.updatedTime === 'string' && item.updatedTime.length > 0, 'MISSING_VERSION');
  assert(item.ufCrm23_1770921060 === '', 'PAYMENT_INPUT_BUSY');
  return {
    invoiceId: item.id, parentId: item.parentId2, companyId: item.companyId,
    mycompanyId: item.mycompanyId, fullCents: cents(`${item.opportunity}|RUB`),
    balanceCents: cents(item.ufCrm23_1770923673), stage: item.stageId,
    version: item.updatedTime
  };
}
function validate(spec) {
  assert(spec && typeof spec.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(spec.id), 'INVALID_OPERATION');
  assert(typeof spec.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(spec.fingerprint), 'INVALID_FINGERPRINT');
  assert(integer(spec.invoiceId) && integer(spec.parentId) && integer(spec.amountCents), 'INVALID_OPERATION');
  assert(spec.origin && ['chatId','messageId'].every(k => typeof spec.origin[k] === 'string' && spec.origin[k].length > 0 && spec.origin[k].length <= 200), 'ORIGIN_REQUIRED');
  const b = spec.before;
  assert(b && b.invoiceId === spec.invoiceId && b.parentId === spec.parentId, 'INVALID_SNAPSHOT');
  assert(paymentStartStages.has(b.stage) && integer(b.balanceCents) && integer(b.fullCents), 'UNTESTED_START_STATE');
  assert(typeof b.version === 'string' && b.version.length > 0, 'MISSING_VERSION');
  // The caller selects/authorizes the payment. This transport guard neither rounds nor
  // rewrites that amount; settlement and tolerance belong to existing portal workflows.
}
const projection = b => [b.invoiceId,b.parentId,b.companyId,b.mycompanyId,b.fullCents,b.balanceCents,b.stage,b.version];
const canonical = spec => JSON.stringify([spec.invoiceId,spec.parentId,spec.amountCents,projection(spec.before)]);

export class Journal {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, spec TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('reserved','dispatched','observed','uncertain','rejected','confirmed')),
        reason TEXT NOT NULL, evidence TEXT);
      CREATE TABLE IF NOT EXISTS locks (
        resource TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id));
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES operations(id),
        at TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT);`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id);
    return row ? {...row,spec:JSON.parse(row.spec),evidence:row.evidence?JSON.parse(row.evidence):null} : null;
  }
  event(id, status, reason, evidence=null) {
    this.db.prepare('INSERT INTO events(operation_id,at,status,reason,evidence) VALUES(?,?,?,?,?)')
      .run(id,new Date().toISOString(),status,reason,evidence===null?null:JSON.stringify(evidence));
  }
  reserve(spec) {
    validate(spec);
    return this.transaction(() => {
      const rows = this.db.prepare('SELECT id FROM operations WHERE id=? OR fingerprint=?').all(spec.id,spec.fingerprint);
      if (rows.length) {
        assert(rows.length === 1, 'IDENTITY_COLLISION');
        const old = this.get(rows[0].id);
        assert(old.fingerprint === spec.fingerprint && canonical(old.spec) === canonical(spec), 'OPERATION_MISMATCH');
        return {fresh:false,operation:old};
      }
      const resources = [`invoice:${spec.invoiceId}`,`deal:${spec.parentId}`];
      for (const resource of resources)
        assert(!this.db.prepare('SELECT 1 FROM locks WHERE resource=?').get(resource), 'RECONCILIATION_REQUIRED');
      this.db.prepare('INSERT INTO operations(id,fingerprint,spec,status,reason) VALUES(?,?,?,?,?)')
        .run(spec.id,spec.fingerprint,JSON.stringify(spec),'reserved','INTENT_SAVED');
      for (const resource of resources)
        this.db.prepare('INSERT INTO locks(resource,operation_id) VALUES(?,?)').run(resource,spec.id);
      this.event(spec.id,'reserved','INTENT_SAVED');
      return {fresh:true,operation:this.get(spec.id)};
    });
  }
  transition(id, from, status, reason, evidence=null, release=false) {
    return this.transaction(() => {
      const old = this.get(id);
      assert(old && from.includes(old.status), 'INVALID_TRANSITION');
      this.db.prepare('UPDATE operations SET status=?,reason=?,evidence=? WHERE id=?')
        .run(status,reason,evidence===null?null:JSON.stringify(evidence),id);
      if (release) this.db.prepare('DELETE FROM locks WHERE operation_id=?').run(id);
      this.event(id,status,reason,evidence);
      return this.get(id);
    });
  }
  confirmApplied(id, {actor, evidence}) {
    assert(typeof actor === 'string' && actor.trim().length > 0 && actor.length <= 100, 'OPERATOR_REQUIRED');
    assert(typeof evidence === 'string' && evidence.trim().length > 0 && evidence.length <= 4000, 'EVIDENCE_REQUIRED');
    // The caller must authenticate the operator. There is no public endpoint in this prototype.
    return this.transition(id,['dispatched','uncertain','observed'],'confirmed','OPERATOR_CONFIRMED',{actor,evidence},true);
  }
  close() { this.db.close(); }
}

export class PaymentGuard {
  constructor(journal, adapter) { this.journal=journal; this.adapter=adapter; }
  async execute(input) {
    const spec = structuredClone(input);
    const reservation = this.journal.reserve(spec);
    if (!reservation.fresh) return reservation.operation; // No network write on duplicate/restart.
    let commentIds=null,expectedCommentActorId=null;
    try {
      if (this.adapter.readComments) {
        const comments=await this.adapter.readComments(spec.invoiceId);
        assert(Array.isArray(comments) && comments.every(c=>typeof c.id==='string'), 'INVALID_COMMENTS');
        commentIds=comments.map(c=>c.id);
      }
      const rawCurrent=await this.adapter.read(spec.invoiceId);
      const current = snapshot(rawCurrent);
      if(this.adapter.paymentCommentAuthorField==='assignedById'){
        assert(integer(rawCurrent.assignedById),'COMMENT_AUTHOR_UNKNOWN');
        expectedCommentActorId=String(rawCurrent.assignedById);
      }
      if (JSON.stringify(projection(current)) !== JSON.stringify(projection(spec.before)))
        return this.journal.transition(spec.id,['reserved'],'rejected','PRECONDITION_CHANGED',current,true);
    } catch {
      return this.journal.transition(spec.id,['reserved'],'rejected','PREFLIGHT_UNAVAILABLE',null,true);
    }
    this.journal.transition(spec.id,['reserved'],'dispatched','SENT_OR_MAY_HAVE_BEEN_SENT',{commentIds,expectedCommentActorId});
    try {
      // Deliberately no retry and no full-amount/balance write.
      const response=await this.adapter.apply(spec.invoiceId,{
        ufCrm23_1770921060:rub(spec.amountCents),stageId:SUCCESS
      });
      assert(response?.accepted===true && typeof response.actorId==='string' && response.actorId.length>0,'API_ACK_REQUIRED');
      this.journal.event(spec.id,'dispatched','API_ACKNOWLEDGED',{actorId:response.actorId});
    } catch {
      return this.journal.transition(spec.id,['dispatched'],'uncertain','TRANSPORT_OR_REMOTE_ERROR');
    }
    return this.reconcile(spec.id);
  }
  async reconcile(id) {
    const op = this.journal.get(id);
    assert(op && ['dispatched','uncertain','observed'].includes(op.status), 'NOT_RECONCILABLE');
    let after,rawAfter;
    try { rawAfter=await this.adapter.read(op.spec.invoiceId);after = snapshot(rawAfter); }
    catch { return this.journal.transition(id,[op.status],'uncertain','READBACK_UNAVAILABLE'); }
    const before=op.spec.before, expected=before.balanceCents-op.spec.amountCents;
    const matches = after.invoiceId===before.invoiceId && after.parentId===before.parentId &&
      after.companyId===before.companyId && after.mycompanyId===before.mycompanyId &&
      after.fullCents===before.fullCents && after.balanceCents===expected &&
      after.stage===(expected===0?SUCCESS:PARTIAL);
    const acknowledgement=this.journal.db.prepare("SELECT evidence FROM events WHERE operation_id=? AND reason='API_ACKNOWLEDGED' ORDER BY seq DESC LIMIT 1").get(id);
    const dispatched=this.journal.db.prepare("SELECT evidence FROM events WHERE operation_id=? AND reason='SENT_OR_MAY_HAVE_BEEN_SENT' ORDER BY seq DESC LIMIT 1").get(id);
    const dispatchEvidence=dispatched?.evidence?JSON.parse(dispatched.evidence):{};
    const baseline=dispatchEvidence.commentIds??null;
    const expectedActor=dispatchEvidence.expectedCommentActorId??null;
    if (matches && acknowledgement && Array.isArray(baseline) && this.adapter.readComments) {
      try {
        const comments=await this.adapter.readComments(op.spec.invoiceId);
        assert(Array.isArray(comments) && comments.every(c=>typeof c.id==='string'),'INVALID_COMMENTS');
        const added=comments.filter(c=>!baseline.includes(c.id));
        const actor=expectedActor??JSON.parse(acknowledgement.evidence).actorId;
        if(expectedActor&&String(rawAfter.assignedById)!==expectedActor)
          return this.journal.transition(id,[op.status],'uncertain','COMMENT_AUTHOR_CHANGED',after);
        if (added.length===1 && added[0].amountCents===op.spec.amountCents && added[0].actorId===actor) {
          const rawFinal=await this.adapter.read(op.spec.invoiceId),final = snapshot(rawFinal);
          if (JSON.stringify(projection(final))!==JSON.stringify(projection(after))||(expectedActor&&String(rawFinal.assignedById)!==expectedActor))
            return this.journal.transition(id,[op.status],'uncertain','RESULT_CHANGED_DURING_CHECK',final);
          return this.journal.transition(id,[op.status],'confirmed','API_AND_RESULT_CONFIRMED',
            {after:final,commentId:added[0].id,actorId:actor,apiActorId:JSON.parse(acknowledgement.evidence).actorId,authorRule:expectedActor?'invoice_responsible':'api_actor'},true);
        }
      } catch {
        return this.journal.transition(id,[op.status],'uncertain','COMMENT_READBACK_UNAVAILABLE',after);
      }
    }
    // A lost acknowledgement or competing/missing comment remains ambiguous. A balance
    // match alone must not confirm a potentially manual payment of the same amount.
    return this.journal.transition(id,[op.status],matches?'observed':'uncertain',
      matches?'MATCHING_RESULT_NOT_ATTRIBUTED':'RESULT_MISMATCH',after);
  }
}
