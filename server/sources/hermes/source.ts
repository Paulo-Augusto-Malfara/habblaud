// Fonte de agentes do Hermes (AgentSource 'hermes', ver sources/source.ts). SÓ LEITURA, por polling.
//
// Esquema do Hermes -> Office:
// - um perfil (~/.hermes e ~/.hermes/profiles/<perfil>) = um agente = uma conta (o selo) e uma sala própria
//   (cwd sintético "/hermes/<nome>"): um escritório por agente, por enquanto;
// - cada sessão ABERTA do state.db (ended_at nulo e atividade nos últimos ACTIVE_WINDOW_MS) = um agente principal na
//   sala do perfil; papel = papel do perfil + origem (telegram, cron...), título = sessions.title;
// - status: lease de turno (session_turn_leases) ou prompt/ferramenta sem resposta há menos de 2 min = trabalhando;
//   senão ocioso. "Esperando" (aprovação, clarify) vem da ponte do Hermes, que esta etapa não lê;
// - sessões com source "subagent" e parent_session_id = sessão aberta viram subagentes do pai; ao encerrar entregam;
// - atividade: a última mensagem da sessão (prompt, ferramenta, resposta), uma por mensagem nova.
//
// Polling: a cada pollMs só se relê o banco quando o tamanho/mtime dele ou do WAL mudou (assinatura); o estado
// dependente do relógio (trabalhando -> ocioso, sessão que sai da janela) é reavaliado do cache a cada ciclo.
import type { Activity, AgentStats, SourceInfo } from '../../../shared/types';
import { describePrompt, maskSecrets, SPECIAL } from '../../../shared/activity';
import { ACCOUNT_COLORS, type DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import { discoverHermesProfiles, type HermesNames, type HermesProfile } from './profiles';
import { classifyHermes, dbSignature, readSessions, type HermesSession } from './reader';

/** Sessão sem atividade há mais que isto não está aberta, mesmo sem ended_at (o Hermes não fecha as do Telegram). */
export const ACTIVE_WINDOW_MS = 30 * 60_000;
/** Origens que não são conversas de um agente: sessões internas de ferramentas. */
const IGNORED_SOURCES = new Set(['tool']);
const SUBAGENT_SOURCE = 'subagent';

export interface HermesSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** HERMES_HOME (a pasta do perfil padrão). */
  home: string;
  names?: HermesNames;
  now?: () => number;
  pollMs?: number;
}

interface ProfileState {
  profile: HermesProfile;
  acc: AccountEntry;
  sig?: string;
  rows: HermesSession[];
  error?: string;
}

interface Tracked {
  kind: 'main' | 'sub';
  state: ProfileState;
  sessionId: string;
  lastMsgId?: number;
}

function shortFor(name: string, taken: Set<string>): string {
  const letters = name.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
  const candidates = [letters.slice(0, 1), letters.slice(0, 2), ...[...letters].slice(1), ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  const pick = candidates.find((c) => c && !taken.has(c)) ?? '?';
  taken.add(pick);
  return pick;
}

export class HermesSource implements AgentSource {
  readonly provider = 'hermes' as const;
  private readonly now: () => number;
  private readonly states: ProfileState[];
  private readonly tracked = new Map<string, Tracked>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: HermesSourceOptions) {
    this.now = opts.now ?? Date.now;
    const profiles = discoverHermesProfiles(opts.home, opts.names);
    const taken = [...opts.accounts.entries(), ...opts.accounts.entriesOf('codex')];
    const shorts = new Set(taken.map((e) => e.detected.short.toUpperCase()));
    const colors = new Set(taken.map((e) => e.detected.color));
    const detected = profiles.map((p, i): DetectedAccount => {
      const color = ACCOUNT_COLORS.find((c) => !colors.has(c)) ?? ACCOUNT_COLORS[i % ACCOUNT_COLORS.length];
      colors.add(color);
      return { id: p.id, provider: 'hermes', configDir: p.dir, short: shortFor(p.name, shorts), name: p.name, color };
    });
    const entries = opts.accounts.setProviderAccounts(
      'hermes',
      profiles.map((p, i) => ({ dir: p.dir, detected: detected[i] })),
    );
    this.states = profiles.map((profile, i) => ({ profile, acc: entries[i], rows: [] }));
  }

  start(): void {
    const { office } = this.opts;
    office.beginBoot();
    try {
      this.poll(true);
    } finally {
      office.endBoot();
    }
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 3_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    return this.states.map((st) => {
      let sessions = 0;
      for (const t of this.tracked.values()) if (t.state === st && t.kind === 'main') sessions++;
      const info: SourceInfo = { label: st.acc.id, provider: 'hermes', path: st.profile.dir, sessions, ok: !st.error };
      if (st.error) info.error = st.error;
      return info;
    });
  }

  transcriptPathOf(): string | undefined {
    return undefined;
  }

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`hermes-poll:${errMsg(err)}`, `Hermes: falha no ciclo (${errMsg(err)}).`);
    }
  }

  /** Relê os bancos que mudaram e reconcilia o Office com o cache. */
  poll(boot: boolean): void {
    const now = this.now();
    for (const st of this.states) this.refresh(st, now);
    for (const st of this.states) this.reconcile(st, now, boot);
  }

  private refresh(st: ProfileState, now: number): void {
    const sig = dbSignature(st.profile.db);
    if (sig === st.sig && !st.error) return;
    try {
      st.rows = readSessions(st.profile.db, now - ACTIVE_WINDOW_MS);
      st.sig = sig;
      if (st.error) {
        delete st.error;
        this.opts.office.markDirty();
      }
    } catch (err) {
      st.sig = sig;
      const msg = errMsg(err);
      if (st.error !== msg) {
        st.error = msg;
        log.warnOnce(`hermes-read:${st.profile.id}:${msg}`, `Hermes (${st.profile.id}): não consegui ler o state.db (${msg}).`);
        this.opts.office.markDirty();
      }
    }
  }

  private idOf(st: ProfileState, sessionId: string): string {
    return `hermes:${st.acc.id}:${sessionId}`;
  }

  private reconcile(st: ProfileState, now: number, boot: boolean): void {
    const { office } = this.opts;
    const open = (s: HermesSession) => s.endedAt === undefined && now - s.activityAt <= ACTIVE_WINDOW_MS;
    const mains = st.rows.filter((s) => s.source !== SUBAGENT_SOURCE && !IGNORED_SOURCES.has(s.source) && open(s));
    const live = new Set<string>();

    for (const s of mains) {
      const id = this.idOf(st, s.id);
      live.add(id);
      let t = this.tracked.get(id);
      if (!t) {
        const role = `${st.profile.role ?? 'Agente Hermes'} (${s.source})`;
        office.addMain({
          id,
          provider: 'hermes',
          account: st.acc.id,
          sessionId: s.id,
          cwd: `/hermes/${st.profile.name.replace(/[\\/]+/g, '-')}`,
          role,
          startedAt: s.startedAt || now,
          status: classifyHermes(s, now),
        });
        t = { kind: 'main', state: st, sessionId: s.id };
        this.tracked.set(id, t);
      }
      office.setStatus(id, classifyHermes(s, now));
      this.apply(id, t, s, boot);
    }

    const parentIds = new Set(mains.map((s) => s.id));
    for (const s of st.rows) {
      if (s.source !== SUBAGENT_SOURCE || !s.parentId || !parentIds.has(s.parentId)) continue;
      const id = this.idOf(st, s.id);
      const parentId = this.idOf(st, s.parentId);
      if (s.endedAt !== undefined || now - s.activityAt > ACTIVE_WINDOW_MS) {
        if (this.tracked.has(id)) office.completeSub(id);
        continue;
      }
      live.add(id);
      let t = this.tracked.get(id);
      if (!t) {
        const added = office.addSub({ id, parentId, sessionId: s.id, role: 'Subagente (Hermes)', title: s.title, background: false, startedAt: s.startedAt || now });
        if (!added) continue;
        t = { kind: 'sub', state: st, sessionId: s.id };
        this.tracked.set(id, t);
      }
      this.apply(id, t, s, boot);
    }

    for (const [id, t] of [...this.tracked]) {
      if (t.state !== st || live.has(id)) continue;
      if (t.kind === 'main') office.closeMain(id);
      else office.completeSub(id);
      this.tracked.delete(id);
    }
  }

  private apply(id: string, t: Tracked, s: HermesSession, boot: boolean): void {
    const { office } = this.opts;
    const stats: AgentStats = { toolCalls: s.toolCalls, tokensIn: s.tokensIn, tokensOut: s.tokensOut, subagents: 0 };
    if (s.costUSD !== undefined) stats.costUSD = s.costUSD;
    office.applyTranscript(id, {
      ...(s.title ? { title: s.title.slice(0, 80) } : {}),
      tasks: [],
      stats,
      ...(s.model ? { model: s.model } : {}),
      lastAt: s.last?.at ?? s.activityAt,
    });
    const last = s.last;
    if (!last || last.id === t.lastMsgId) return;
    t.lastMsgId = last.id;
    const desc =
      last.role === 'user'
        ? describePrompt(maskSecrets(last.text ?? ''))
        : last.role === 'tool'
          ? { kind: 'other' as const, icon: '🛠️', text: `Usando ${last.toolName ?? 'ferramenta'}` }
          : last.finishReason === 'tool_calls'
            ? SPECIAL.think()
            : SPECIAL.respond();
    const act: Activity = { id: `${id}#${last.id}`, at: last.at, ...desc };
    office.addActivity(id, act, true, boot ? { feed: false } : {});
  }
}
