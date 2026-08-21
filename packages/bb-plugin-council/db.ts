import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type MemberRow = {
  id: string;
  name: string;
  persona: string;
  providerId: string | null;
  model: string | null;
  reasoningLevel: string | null;
  isChief: number;
  enabled: number;
  createdAtMs: number;
};

export type SessionRow = {
  id: string;
  proposal: string;
  context: string | null;
  status: "running" | "completed" | "failed";
  originThreadId: string | null;
  projectId: string | null;
  consensusMode: string;
  maxRounds: number;
  verdict: string | null;
  dissent: string | null;
  tallyJson: string | null;
  error: string | null;
  createdAtMs: number;
  completedAtMs: number | null;
};

export type TurnRow = {
  id: string;
  sessionId: string;
  seq: number;
  phase: "consideration" | "discussion" | "verdict";
  round: number | null;
  memberId: string | null;
  memberName: string;
  stance: "support" | "oppose" | "abstain" | "pass" | null;
  comment: string;
  createdAtMs: number;
};

export type RosterRow = {
  sessionId: string;
  memberId: string;
  memberName: string;
  threadId: string;
  status: "ok" | "recused";
};

export const migrations = [
  `CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    persona TEXT NOT NULL DEFAULT '',
    provider_id TEXT,
    model TEXT,
    reasoning_level TEXT,
    is_chief INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    proposal TEXT NOT NULL,
    context TEXT,
    status TEXT NOT NULL,
    origin_thread_id TEXT,
    project_id TEXT,
    consensus_mode TEXT NOT NULL DEFAULT 'majority',
    max_rounds INTEGER NOT NULL DEFAULT 2,
    verdict TEXT,
    dissent TEXT,
    tally_json TEXT,
    error TEXT,
    created_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    phase TEXT NOT NULL,
    round INTEGER,
    member_id TEXT,
    member_name TEXT NOT NULL,
    stance TEXT,
    comment TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, seq)`,
  `CREATE TABLE IF NOT EXISTS session_members (
    session_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    member_name TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (session_id, member_id)
  )`,
];

export class CouncilStore {
  constructor(private readonly db: Database) {}

  private static readonly MEMBER_SELECT = `
    id, name, persona,
    provider_id AS providerId,
    model,
    reasoning_level AS reasoningLevel,
    is_chief AS isChief,
    enabled,
    created_at_ms AS createdAtMs`;

  private static readonly SESSION_SELECT = `
    id, proposal, context, status,
    origin_thread_id AS originThreadId,
    project_id AS projectId,
    consensus_mode AS consensusMode,
    max_rounds AS maxRounds,
    verdict, dissent,
    tally_json AS tallyJson,
    error,
    created_at_ms AS createdAtMs,
    completed_at_ms AS completedAtMs`;

  private static readonly TURN_SELECT = `
    id,
    session_id AS sessionId,
    seq, phase, round,
    member_id AS memberId,
    member_name AS memberName,
    stance, comment,
    created_at_ms AS createdAtMs`;

  private static readonly ROSTER_SELECT = `
    session_id AS sessionId,
    member_id AS memberId,
    member_name AS memberName,
    thread_id AS threadId,
    status`;

  listMembers(): MemberRow[] {
    return this.db
      .prepare(
        `SELECT ${CouncilStore.MEMBER_SELECT} FROM members ORDER BY created_at_ms ASC`,
      )
      .all() as MemberRow[];
  }

  getMember(id: string): MemberRow | undefined {
    return this.db
      .prepare(
        `SELECT ${CouncilStore.MEMBER_SELECT} FROM members WHERE id = ?`,
      )
      .get(id) as MemberRow | undefined;
  }

  insertMember(input: {
    name: string;
    persona: string;
    providerId: string | null;
    model: string | null;
    reasoningLevel: string | null;
    isChief: boolean;
    enabled: boolean;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO members (id, name, persona, provider_id, model, reasoning_level, is_chief, enabled, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.persona,
        input.providerId,
        input.model,
        input.reasoningLevel,
        input.isChief ? 1 : 0,
        input.enabled ? 1 : 0,
        Date.now(),
      );
    return id;
  }

  updateMember(
    id: string,
    input: {
      name: string;
      persona: string;
      providerId: string | null;
      model: string | null;
      reasoningLevel: string | null;
      isChief: boolean;
      enabled: boolean;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE members SET name = ?, persona = ?, provider_id = ?, model = ?, reasoning_level = ?, is_chief = ?, enabled = ?
         WHERE id = ?`,
      )
      .run(
        input.name,
        input.persona,
        input.providerId,
        input.model,
        input.reasoningLevel,
        input.isChief ? 1 : 0,
        input.enabled ? 1 : 0,
        id,
      );
  }

  clearOtherChiefs(keepId: string): void {
    this.db
      .prepare("UPDATE members SET is_chief = 0 WHERE is_chief = 1 AND id != ?")
      .run(keepId);
  }

  deleteMember(id: string): void {
    const wasChief = this.getMember(id)?.isChief === 1;
    this.db.prepare("DELETE FROM members WHERE id = ?").run(id);
    if (!wasChief) return;
    // Keep the invariant that exactly one enabled member is chief; the
    // earliest remaining enabled member takes the role.
    const successor = this.listMembers().find((member) => member.enabled === 1);
    if (successor) {
      this.db
        .prepare("UPDATE members SET is_chief = 1 WHERE id = ?")
        .run(successor.id);
    }
  }

  createSession(input: {
    proposal: string;
    context: string | null;
    originThreadId: string | null;
    projectId: string | null;
    consensusMode: string;
    maxRounds: number;
  }): SessionRow {
    const row: SessionRow = {
      id: randomUUID(),
      proposal: input.proposal,
      context: input.context,
      status: "running",
      originThreadId: input.originThreadId,
      projectId: input.projectId,
      consensusMode: input.consensusMode,
      maxRounds: input.maxRounds,
      verdict: null,
      dissent: null,
      tallyJson: null,
      error: null,
      createdAtMs: Date.now(),
      completedAtMs: null,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, proposal, context, status, origin_thread_id, project_id, consensus_mode, max_rounds, created_at_ms)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.proposal,
        row.context,
        row.originThreadId,
        row.projectId,
        row.consensusMode,
        row.maxRounds,
        row.createdAtMs,
      );
    return row;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db
      .prepare(
        `SELECT ${CouncilStore.SESSION_SELECT} FROM sessions WHERE id = ?`,
      )
      .get(id) as SessionRow | undefined;
  }

  listSessions(limit: number): SessionRow[] {
    return this.db
      .prepare(
        `SELECT ${CouncilStore.SESSION_SELECT} FROM sessions ORDER BY created_at_ms DESC LIMIT ?`,
      )
      .all(limit) as SessionRow[];
  }

  setSessionError(id: string, error: string): void {
    this.db
      .prepare(
        "UPDATE sessions SET status = 'failed', error = ?, completed_at_ms = ? WHERE id = ?",
      )
      .run(error, Date.now(), id);
  }

  completeSession(
    id: string,
    verdict: string,
    dissent: string | null,
    tally: unknown,
  ): void {
    this.db
      .prepare(
        "UPDATE sessions SET status = 'completed', verdict = ?, dissent = ?, tally_json = ?, completed_at_ms = ? WHERE id = ?",
      )
      .run(verdict, dissent, JSON.stringify(tally), Date.now(), id);
  }

  deleteSession(id: string): boolean {
    const session = this.getSession(id);
    if (!session) return false;
    this.db.prepare("DELETE FROM turns WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM session_members WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return true;
  }

  addTurn(input: {
    sessionId: string;
    phase: TurnRow["phase"];
    round: number | null;
    memberId: string | null;
    memberName: string;
    stance: TurnRow["stance"];
    comment: string;
  }): TurnRow {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM turns WHERE session_id = ?")
      .get(input.sessionId) as { next: number };
    const turn: TurnRow = {
      id: randomUUID(),
      sessionId: input.sessionId,
      seq: row.next,
      phase: input.phase,
      round: input.round,
      memberId: input.memberId,
      memberName: input.memberName,
      stance: input.stance,
      comment: input.comment,
      createdAtMs: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO turns (id, session_id, seq, phase, round, member_id, member_name, stance, comment, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.id,
        turn.sessionId,
        turn.seq,
        turn.phase,
        turn.round,
        turn.memberId,
        turn.memberName,
        turn.stance,
        turn.comment,
        turn.createdAtMs,
      );
    return turn;
  }

  listTurns(sessionId: string): TurnRow[] {
    return this.db
      .prepare(
        `SELECT ${CouncilStore.TURN_SELECT} FROM turns WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as TurnRow[];
  }

  upsertRoster(entry: RosterRow): void {
    this.db
      .prepare(
        `INSERT INTO session_members (session_id, member_id, member_name, thread_id, status)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, member_id) DO UPDATE SET status = excluded.status`,
      )
      .run(
        entry.sessionId,
        entry.memberId,
        entry.memberName,
        entry.threadId,
        entry.status,
      );
  }

  listRoster(sessionId: string): RosterRow[] {
    return this.db
      .prepare(
        `SELECT ${CouncilStore.ROSTER_SELECT} FROM session_members WHERE session_id = ?`,
      )
      .all(sessionId) as RosterRow[];
  }
}
