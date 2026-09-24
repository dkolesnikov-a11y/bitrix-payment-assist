// Read-only recovery and durable requests for the ORIGINAL chat. No messaging transport.
import {createHash,randomUUID} from 'node:crypto';
import {rub} from './guard.mjs';

const check = (condition, message) => { if (!condition) throw Error(message); };
const pending = ['reserved','dispatched','observed','uncertain'];
const observation = op => createHash('sha256').update(JSON.stringify([op.status,op.reason,op.evidence])).digest('hex');
const bodyKey = reply => JSON.stringify([reply.requestId,reply.chatId,reply.actorId,reply.action,reply.evidence ?? '']);
export class Recovery {
  constructor(guard, {allowedOperators}) {
    check(Array.isArray(allowedOperators) && allowedOperators.length > 0 && allowedOperators.every(x=>typeof x==='string' && x.length>0), 'OPERATORS_REQUIRED');
    this.guard=guard; this.journal=guard.journal; this.db=guard.journal.db;
    this.allowed=new Set(allowedOperators);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reviews (
        operation_id TEXT PRIMARY KEY REFERENCES operations(id), request_id TEXT UNIQUE NOT NULL,
        chat_id TEXT NOT NULL, observation TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_outbox (
        request_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id),
        chat_id TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_replies (
        event_id TEXT PRIMARY KEY, body_key TEXT NOT NULL, result TEXT NOT NULL);`);
  }
  enqueue(id) {
    return this.journal.transaction(() => {
      const op=this.journal.get(id);
      if (!op || !pending.includes(op.status)) {
        if (op) {
          this.db.prepare("UPDATE reviews SET status='resolved' WHERE operation_id=?").run(id);
          this.db.prepare("UPDATE review_outbox SET state='resolved' WHERE operation_id=? AND state='pending'").run(id);
        }
        return null;
      }
      const chat=op.spec.origin?.chatId;
      check(typeof chat==='string' && chat.length>0,'ORIGIN_REQUIRED');
      const key=observation(op);
      const existing=this.db.prepare('SELECT * FROM reviews WHERE operation_id=?').get(id);
      if (existing?.status==='pending' && existing.observation===key) return existing;
      if (existing) this.db.prepare("UPDATE review_outbox SET state='superseded' WHERE request_id=?").run(existing.request_id);
      const token=randomUUID(), now=new Date().toISOString();
      this.db.prepare(`INSERT INTO reviews(operation_id,request_id,chat_id,observation,status,created_at)
        VALUES(?,?,?,?,'pending',?) ON CONFLICT(operation_id) DO UPDATE SET request_id=excluded.request_id,
        chat_id=excluded.chat_id,observation=excluded.observation,status='pending',created_at=excluded.created_at`)
        .run(id,token,chat,key,now);
      const amount=rub(op.spec.amountCents).replace('|RUB',' ₽');
      const text=op.status==='reserved'
        ? `По счету №${op.spec.invoiceId} сохранено намерение внести ${amount}, отправка не начата. Для этой операции можно отменить неотправленную попытку. Автоматически отправлять ее не буду.`
        : `Нужна сверка оплаты ${amount} по счету №${op.spec.invoiceId}. Платеж повторно не отправляю. Проверьте историю счета и подтвердите учет именно этой операции с основанием. Если учет не найден или неясен, оставьте на сверке.`;
      this.db.prepare("INSERT INTO review_outbox(request_id,operation_id,chat_id,text,state) VALUES(?,?,?,?,'pending')")
        .run(token,id,chat,text);
      this.journal.event(id,op.status,'REVIEW_QUEUED',{requestId:token,chatId:chat});
      return this.db.prepare('SELECT * FROM reviews WHERE operation_id=?').get(id);
    });
  }
  async refresh(id) {
    const op=this.journal.get(id);
    if (!op || !pending.includes(op.status)) return null;
    if (op.status!=='reserved') await this.guard.reconcile(id); // GET only; never execute/apply.
    return this.enqueue(id);
  }
  async recover() {
    this.journal.transaction(() => {
      this.db.prepare("UPDATE reviews SET status='resolved' WHERE operation_id IN (SELECT id FROM operations WHERE status IN ('confirmed','rejected'))").run();
      this.db.prepare("UPDATE review_outbox SET state='resolved' WHERE state='pending' AND operation_id IN (SELECT id FROM operations WHERE status IN ('confirmed','rejected'))").run();
    });
    const rows=this.db.prepare("SELECT id FROM operations WHERE status IN ('reserved','dispatched','observed','uncertain') ORDER BY id").all();
    const results=[];
    for (const {id} of rows) {
      try { results.push({id,review:await this.refresh(id)}); }
      catch { results.push({id,error:'RECHECK_LATER'}); } // A concurrent resolver must not break other recoveries.
    }
    return results;
  }
  outbox() {
    // This is a draft queue, not evidence of message delivery.
    return this.db.prepare("SELECT * FROM review_outbox WHERE state='pending' ORDER BY rowid").all();
  }
  existingReply(reply) {
    const old=this.db.prepare('SELECT * FROM review_replies WHERE event_id=?').get(reply.eventId);
    if (!old) return null;
    check(old.body_key===bodyKey(reply),'REPLY_EVENT_COLLISION');
    return JSON.parse(old.result);
  }
  async respond(input) {
    const reply=structuredClone(input);
    // Values must come from an authenticated Bitrix event, never from text claiming a user ID.
    check(this.allowed.has(reply.actorId),'OPERATOR_NOT_ALLOWED');
    check(typeof reply.eventId==='string' && reply.eventId.length>0 && reply.eventId.length<=200,'EVENT_REQUIRED');
    check(['applied','not_found','cancel_unsent'].includes(reply.action),'EXPLICIT_ACTION_REQUIRED');
    check(typeof reply.evidence==='string' && reply.evidence.trim().length>0 && reply.evidence.length<=4000,'EVIDENCE_REQUIRED');
    const duplicate=this.existingReply(reply); if (duplicate) return duplicate;
    const review=this.db.prepare('SELECT * FROM reviews WHERE request_id=?').get(reply.requestId);
    check(review?.status==='pending','STALE_REVIEW');
    check(reply.chatId===review.chat_id,'WRONG_CHAT');
    await this.refresh(review.operation_id); // Recheck before accepting the operator's decision.
    return this.journal.transaction(() => {
      const prior=this.existingReply(reply); if (prior) return prior;
      const current=this.db.prepare('SELECT * FROM reviews WHERE request_id=?').get(reply.requestId);
      check(current?.status==='pending','STALE_REVIEW');
      const op=this.journal.get(current.operation_id);
      check(pending.includes(op.status) && observation(op)===current.observation,'STALE_REVIEW');
      let result;
      if (reply.action==='not_found') {
        // A late Bitrix workflow can still apply the payment. Never release/retry on this answer.
        result={operationId:op.id,status:'needs_review',retryAllowed:false};
        this.journal.event(op.id,op.status,'OPERATOR_NOT_FOUND',{actor:reply.actorId,evidence:reply.evidence,requestId:reply.requestId});
      } else {
        const unsent=reply.action==='cancel_unsent';
        check(unsent ? op.status==='reserved' : op.status!=='reserved','ACTION_NOT_ALLOWED');
        const status=unsent?'rejected':'confirmed';
        const reason=unsent?'OPERATOR_CANCELLED_UNSENT':'OPERATOR_CONFIRMED';
        const evidence={actor:reply.actorId,chatId:reply.chatId,evidence:reply.evidence,requestId:reply.requestId};
        this.db.prepare('UPDATE operations SET status=?,reason=?,evidence=? WHERE id=?')
          .run(status,reason,JSON.stringify(evidence),op.id);
        this.db.prepare('DELETE FROM locks WHERE operation_id=?').run(op.id);
        this.db.prepare("UPDATE reviews SET status='resolved' WHERE operation_id=?").run(op.id);
        this.db.prepare("UPDATE review_outbox SET state='resolved' WHERE request_id=?").run(reply.requestId);
        this.journal.event(op.id,status,reason,evidence);
        result={operationId:op.id,status,retryAllowed:false};
      }
      this.db.prepare('INSERT INTO review_replies(event_id,body_key,result) VALUES(?,?,?)')
        .run(reply.eventId,bodyKey(reply),JSON.stringify(result));
      return result;
    });
  }
}
