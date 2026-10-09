// Leitura do state.db do Hermes, SEMPRE somente leitura (SQLITE_OPEN_READONLY): nada é escrito, copiado nem criado.
// Abre e fecha a cada leitura para não segurar a leitura do WAL (o que atrasaria o checkpoint do Hermes).
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { AgentStatus } from '../../../shared/types';

/** Última mensagem da sessão. */
export interface HermesMessage {
  id: number;
  role: string;
  /** Epoch ms. */
  at: number;
  toolName?: string;
  finishReason?: string;
  /** Só do prompt do usuário (primeiros 200 caracteres). */
  text?: string;
}

export interface HermesSession {
  id: string;
  /** Origem: telegram, cron, cli, subagent... */
  source: string;
  parentId?: string;
  title?: string;
  model?: string;
  /** Epoch ms. */
  startedAt: number;
  endedAt?: number;
  activityAt: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUSD?: number;
  /** Lease do turno (session_turn_leases), epoch ms. */
  leaseUntil?: number;
  last?: HermesMessage;
}

/** Atividade mais nova que isto, sem resposta ainda, vale como "trabalhando" (mesma janela do project-intelligence). */
export const WORKING_WINDOW_MS = 120_000;

/** Trabalhando (turno com lease, ou prompt/ferramenta há pouco sem resposta) ou ocioso. */
export function classifyHermes(s: Pick<HermesSession, 'leaseUntil' | 'last'>, now: number): Extract<AgentStatus, 'working' | 'idle'> {
  if (s.leaseUntil !== undefined && s.leaseUntil > now) return 'working';
  const l = s.last;
  if (l && (l.role === 'user' || l.role === 'tool') && now - l.at <= WORKING_WINDOW_MS) return 'working';
  return 'idle';
}

/** Assinatura barata do banco (tamanho e mtime do arquivo e do WAL): igual = nada novo para ler. */
export function dbSignature(db: string): string {
  const part = (p: string) => {
    try {
      const st = statSync(p);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return '-';
    }
  };
  return `${part(db)}|${part(`${db}-wal`)}`;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Sessões com atividade desde `sinceMs` e ainda não encerradas (ou encerradas desde então), da mais recente para a
 * mais antiga. Lança se o banco não abrir ou o esquema for outro.
 */
export function readSessions(dbPath: string, sinceMs: number, limit = 60): HermesSession[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const hasLease = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_turn_leases'").get();
    const since = sinceMs / 1000;
    const rows = db
      .prepare(
        `SELECT s.id, s.source, s.parent_session_id AS parent, s.title, s.model, s.started_at AS started, s.ended_at AS ended,
                COALESCE(s.last_activity_at, s.started_at) AS act, s.tool_call_count AS tools, s.input_tokens AS tin,
                s.cache_read_tokens AS tcr, s.cache_write_tokens AS tcw, s.output_tokens AS tout,
                COALESCE(s.actual_cost_usd, s.estimated_cost_usd) AS cost,
                ${hasLease ? '(SELECT MAX(l.expires_at) FROM session_turn_leases l WHERE l.conversation_id = s.id)' : 'NULL'} AS lease,
                m.id AS mid, m.role AS mrole, m.timestamp AS mts, m.tool_name AS mtool, m.finish_reason AS mfin,
                CASE WHEN m.role = 'user' THEN substr(m.content, 1, 200) END AS mtext
           FROM sessions s
           LEFT JOIN messages m ON m.id = (SELECT MAX(id) FROM messages WHERE session_id = s.id)
          WHERE COALESCE(s.archived, 0) = 0 AND COALESCE(s.hidden, 0) = 0
            AND COALESCE(s.last_activity_at, s.started_at) >= ?
            AND (s.ended_at IS NULL OR s.ended_at >= ?)
          ORDER BY act DESC LIMIT ?`,
      )
      .all(since, since, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const s: HermesSession = {
        id: String(r.id),
        source: str(r.source) ?? 'desconhecida',
        startedAt: num(r.started) * 1000,
        activityAt: num(r.act) * 1000,
        toolCalls: num(r.tools),
        tokensIn: num(r.tin) + num(r.tcr) + num(r.tcw),
        tokensOut: num(r.tout),
      };
      const parent = str(r.parent);
      if (parent) s.parentId = parent;
      const title = str(r.title);
      if (title) s.title = title;
      const model = str(r.model);
      if (model) s.model = model;
      if (typeof r.ended === 'number') s.endedAt = r.ended * 1000;
      if (typeof r.cost === 'number') s.costUSD = r.cost;
      if (typeof r.lease === 'number') s.leaseUntil = r.lease * 1000;
      if (typeof r.mid === 'number') {
        s.last = { id: r.mid, role: str(r.mrole) ?? '', at: num(r.mts) * 1000 };
        const tool = str(r.mtool);
        if (tool) s.last.toolName = tool;
        const fin = str(r.mfin);
        if (fin) s.last.finishReason = fin;
        const text = str(r.mtext);
        if (text) s.last.text = text;
      }
      return s;
    });
  } finally {
    db.close();
  }
}
