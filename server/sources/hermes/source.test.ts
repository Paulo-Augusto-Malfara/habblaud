// Fonte do Hermes: bancos SQLite sintéticos (esquema mínimo do state.db real) em pastas temporárias. Nada de dados reais.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { discoverHermesProfiles, loadHermesLayout, loadHermesNames } from './profiles';
import type { HermesGroup } from './profiles';
import { classifyHermes, dbSignature, readSessions, WORKING_WINDOW_MS } from './reader';
import { ACTIVE_WINDOW_MS, HermesSource } from './source';

setQuiet(true);

const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, parent_session_id TEXT, title TEXT, model TEXT,
  started_at REAL NOT NULL, ended_at REAL, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0, estimated_cost_usd REAL, actual_cost_usd REAL,
  last_activity_at REAL, archived INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL,
  content TEXT, tool_name TEXT, tool_calls TEXT, timestamp REAL NOT NULL, finish_reason TEXT
);
CREATE TABLE session_turn_leases (
  conversation_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at REAL NOT NULL, expires_at REAL NOT NULL
);`;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const T0 = 1_800_000_000_000;
const sec = (ms: number) => ms / 1000;

function makeHome(profiles: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), 'habblaud-hermes-'));
  dirs.push(home);
  const dbs = new Map<string, string>();
  for (const p of ['default', ...profiles]) {
    const dir = p === 'default' ? home : join(home, 'profiles', p);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.db');
    const db = new DatabaseSync(file);
    db.exec(SCHEMA);
    db.close();
    dbs.set(p, file);
  }
  return {
    home,
    db: dbs,
    write(profile: string, fn: (db: DatabaseSync) => void) {
      const db = new DatabaseSync(dbs.get(profile)!);
      try {
        fn(db);
      } finally {
        db.close();
      }
    },
  };
}

function session(db: DatabaseSync, s: { id: string; source?: string; parent?: string; title?: string; started: number; ended?: number; activity?: number }) {
  db.prepare('INSERT INTO sessions (id, source, parent_session_id, title, started_at, ended_at, last_activity_at) VALUES (?,?,?,?,?,?,?)').run(
    s.id,
    s.source ?? 'telegram',
    s.parent ?? null,
    s.title ?? null,
    sec(s.started),
    s.ended === undefined ? null : sec(s.ended),
    sec(s.activity ?? s.started),
  );
}

function message(db: DatabaseSync, m: { session: string; role: string; at: number; content?: string; tool?: string; finish?: string }) {
  db.prepare('INSERT INTO messages (session_id, role, content, tool_name, timestamp, finish_reason) VALUES (?,?,?,?,?,?)').run(
    m.session,
    m.role,
    m.content ?? null,
    m.tool ?? null,
    sec(m.at),
    m.finish ?? null,
  );
}

function setup(profiles: string[], names = {}, groups: HermesGroup[] = []) {
  const h = makeHome(profiles);
  let clock = T0;
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: h.home, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const source = new HermesSource({ accounts, office, home: h.home, names, groups, now });
  const stop = () => source.stop();
  return {
    ...h,
    accounts,
    office,
    source,
    stop,
    advance(ms: number) {
      clock += ms;
    },
    now,
  };
}

describe('perfis', () => {
  it('acha o padrão e os perfis com state.db, com nome do arquivo de nomes ou o id', () => {
    const h = makeHome(['secretaria', 'vesta']);
    mkdirSync(join(h.home, 'profiles', 'sem-banco'), { recursive: true });
    const ps = discoverHermesProfiles(h.home, { default: { name: 'Otto' }, secretaria: { name: 'Mia', role: 'Secretária' } });
    expect(ps.map((p) => [p.id, p.name, p.role])).toEqual([
      ['default', 'Otto', undefined],
      ['secretaria', 'Mia', 'Secretária'],
      ['vesta', 'Vesta', undefined],
    ]);
  });

  it('usa o name do config.yaml do perfil quando não há arquivo de nomes', () => {
    const h = makeHome(['mkt']);
    writeFileSync(join(h.home, 'profiles', 'mkt', 'config.yaml'), 'model: x\nname: "Febe"\nother:\n  name: errado\n');
    expect(discoverHermesProfiles(h.home).find((p) => p.id === 'mkt')?.name).toBe('Febe');
  });

  it('arquivo de nomes ausente ou inválido vira vazio', () => {
    const h = makeHome();
    writeFileSync(join(h.home, 'n.json'), '[1,2]');
    expect(loadHermesNames(join(h.home, 'n.json'))).toEqual({});
    expect(loadHermesNames(join(h.home, 'nao-existe.json'))).toEqual({});
    writeFileSync(join(h.home, 'n.json'), '{"a":{"name":" Ana ","role":3}}');
    expect(loadHermesNames(join(h.home, 'n.json'))).toEqual({ a: { name: 'Ana' } });
  });
});

describe('leitor', () => {
  it('lê só sessões abertas ou encerradas na janela, com a última mensagem e a lease', () => {
    const h = makeHome();
    h.write('default', (db) => {
      session(db, { id: 'a', started: T0 - 60_000, activity: T0 - 5_000, title: 'Conversa A' });
      message(db, { session: 'a', role: 'user', at: T0 - 20_000, content: 'oi' });
      message(db, { session: 'a', role: 'tool', at: T0 - 5_000, tool: 'terminal' });
      db.prepare('INSERT INTO session_turn_leases VALUES (?,?,?,?)').run('a', 'h', sec(T0 - 10_000), sec(T0 + 30_000));
      session(db, { id: 'velha', started: T0 - 3 * 3600_000, activity: T0 - 3 * 3600_000 });
      session(db, { id: 'arq', started: T0 - 1000, activity: T0 - 1000 });
      db.exec("UPDATE sessions SET archived = 1 WHERE id = 'arq'");
    });
    const rows = readSessions(h.db.get('default')!, T0 - ACTIVE_WINDOW_MS);
    expect(rows.map((r) => r.id)).toEqual(['a']);
    expect(rows[0]).toMatchObject({ title: 'Conversa A', source: 'telegram', leaseUntil: T0 + 30_000 });
    expect(rows[0].last).toMatchObject({ role: 'tool', toolName: 'terminal', at: T0 - 5_000 });
    expect(rows[0].last?.text).toBeUndefined();
  });

  it('abre o banco somente leitura: escrever falha e o arquivo não muda', () => {
    const h = makeHome();
    h.write('default', (db) => session(db, { id: 'a', started: T0 }));
    const before = dbSignature(h.db.get('default')!);
    readSessions(h.db.get('default')!, 0);
    expect(dbSignature(h.db.get('default')!)).toBe(before);
    const ro = new DatabaseSync(h.db.get('default')!, { readOnly: true });
    expect(() => ro.exec("UPDATE sessions SET title = 'x'")).toThrow();
    ro.close();
  });

  it('classifica: lease ou prompt/ferramenta recente = trabalhando; resposta ou silêncio = ocioso', () => {
    const msg = (role: string, ago: number) => ({ id: 1, role, at: T0 - ago });
    expect(classifyHermes({ leaseUntil: T0 + 1, last: msg('assistant', 1) }, T0)).toBe('working');
    expect(classifyHermes({ last: msg('user', 10_000) }, T0)).toBe('working');
    expect(classifyHermes({ last: msg('tool', WORKING_WINDOW_MS + 1) }, T0)).toBe('idle');
    expect(classifyHermes({ last: msg('assistant', 1_000) }, T0)).toBe('idle');
    expect(classifyHermes({ leaseUntil: T0 - 1 }, T0)).toBe('idle');
  });
});

describe('HermesSource', () => {
  it('uma sala por perfil, conta = perfil, sessões abertas viram agentes principais', () => {
    const t = setup(['secretaria'], { default: { name: 'Otto', role: 'Chefe' }, secretaria: { name: 'Mia' } });
    t.write('default', (db) => {
      session(db, { id: 's1', started: T0 - 60_000, activity: T0 - 2_000, title: 'Planejar a semana' });
      message(db, { session: 's1', role: 'user', at: T0 - 2_000, content: 'planeja a semana' });
      session(db, { id: 'fechada', source: 'cron', started: T0 - 600_000, ended: T0 - 500_000, activity: T0 - 500_000 });
      session(db, { id: 'esquecida', started: T0 - 3 * 3600_000, activity: T0 - 3 * 3600_000 });
      session(db, { id: 'interna', source: 'tool', started: T0 - 1000, activity: T0 - 1000 });
    });
    t.write('secretaria', (db) => {
      session(db, { id: 's2', source: 'cron', started: T0 - 90_000, activity: T0 - 60_000 });
      message(db, { session: 's2', role: 'assistant', at: T0 - 60_000, finish: 'stop' });
    });
    t.source.start();
    const agents = t.office.list();
    expect(agents.map((a) => a.id).sort()).toEqual(['hermes:default:s1', 'hermes:secretaria:s2']);
    const a1 = t.office.get('hermes:default:s1')!;
    expect(a1).toMatchObject({ kind: 'main', provider: 'hermes', account: 'default', status: 'working', role: 'Chefe (telegram)', title: 'Planejar a semana' });
    const a2 = t.office.get('hermes:secretaria:s2')!;
    expect(a2).toMatchObject({ account: 'secretaria', status: 'idle', role: 'Agente Hermes (cron)' });
    expect(a1.roomId).not.toBe(a2.roomId);
    expect(t.office.roomName(a1.roomId)).toBe('Otto');
    expect(t.office.roomName(a2.roomId)).toBe('Mia');
    expect(t.accounts.entriesOf('hermes').map((e) => [e.id, e.detected.name, e.provider])).toEqual([
      ['default', 'Otto', 'hermes'],
      ['secretaria', 'Mia', 'hermes'],
    ]);
    expect(t.source.sources().map((s) => [s.label, s.provider, s.sessions, s.ok])).toEqual([
      ['default', 'hermes', 1, true],
      ['secretaria', 'hermes', 1, true],
    ]);
    expect(t.source.transcriptPathOf()).toBeUndefined();
    t.stop();
  });

  it('acompanha o relógio (trabalhando -> ocioso -> sai da janela) e as mudanças do banco', () => {
    const t = setup([]);
    t.write('default', (db) => {
      session(db, { id: 's1', started: T0 - 10_000, activity: T0 - 1_000 });
      message(db, { session: 's1', role: 'user', at: T0 - 1_000, content: 'faz isso' });
    });
    t.source.start();
    expect(t.office.get('hermes:default:s1')?.status).toBe('working');

    t.advance(WORKING_WINDOW_MS + 5_000);
    t.source.poll(false);
    expect(t.office.get('hermes:default:s1')?.status).toBe('idle');

    t.write('default', (db) => {
      message(db, { session: 's1', role: 'assistant', at: T0 + 130_000, content: 'pronto', finish: 'stop' });
      db.exec(`UPDATE sessions SET last_activity_at = ${sec(T0 + 130_000)} WHERE id = 's1'`);
    });
    t.advance(1_000);
    t.source.poll(false);
    expect(t.office.get('hermes:default:s1')?.activity?.kind).toBe('respond');

    t.advance(ACTIVE_WINDOW_MS + 60_000);
    t.source.poll(false);
    expect(t.office.get('hermes:default:s1')?.status).toBe('offline');
    t.stop();
  });

  it('sessão encerrada no banco sai do escritório', () => {
    const t = setup([]);
    t.write('default', (db) => session(db, { id: 's1', started: T0 - 10_000, activity: T0 - 1_000 }));
    t.source.start();
    expect(t.office.get('hermes:default:s1')?.status).toBe('idle');
    t.write('default', (db) => db.exec(`UPDATE sessions SET ended_at = ${sec(T0 + 500)} WHERE id = 's1'`));
    t.advance(1_000);
    t.source.poll(false);
    expect(t.office.get('hermes:default:s1')?.status).toBe('offline');
    t.stop();
  });

  it('subagente (source subagent) entra sob o pai e entrega ao encerrar', () => {
    const t = setup([]);
    t.write('default', (db) => {
      session(db, { id: 'pai', started: T0 - 60_000, activity: T0 - 1_000 });
      message(db, { session: 'pai', role: 'user', at: T0 - 1_000, content: 'oi' });
      session(db, { id: 'filho', source: 'subagent', parent: 'pai', title: 'Pesquisar X', started: T0 - 30_000, activity: T0 - 1_000 });
      session(db, { id: 'orfao', source: 'subagent', parent: 'ninguem', started: T0 - 30_000, activity: T0 - 1_000 });
    });
    t.source.start();
    const sub = t.office.get('hermes:default:filho')!;
    expect(sub).toMatchObject({ kind: 'sub', parentId: 'hermes:default:pai', title: 'Pesquisar X', status: 'working' });
    expect(t.office.get('hermes:default:orfao')).toBeUndefined();
    t.write('default', (db) => db.exec(`UPDATE sessions SET ended_at = ${sec(T0 + 500)} WHERE id = 'filho'`));
    t.advance(1_000);
    t.source.poll(false);
    expect(t.office.get('hermes:default:filho')?.status).toBe('done');
    t.stop();
  });

  it('banco ilegível aparece como erro na fonte, sem derrubar as outras', () => {
    const t = setup(['b']);
    t.write('b', (db) => session(db, { id: 's', started: T0 - 1000, activity: T0 - 500 }));
    writeFileSync(t.db.get('default')!, 'isto não é um banco sqlite');
    t.source.start();
    const infos = t.source.sources();
    expect(infos.find((s) => s.label === 'default')?.ok).toBe(false);
    expect(infos.find((s) => s.label === 'b')?.ok).toBe(true);
    expect(t.office.get('hermes:b:s')).toBeDefined();
    t.stop();
  });
});

describe('layout de funcionários fixos', () => {
  const LAYOUT = {
    default: { name: 'Ana', role: 'Chefia', look: 'f', post: 'lounge' },
    recep: { name: 'Beto', look: 'm', post: 'recepcao' },
    mesa: { name: 'Cris', post: 'inexistente', look: 'x' },
    filial: { name: 'Dora' },
    solta: { name: 'Edu' },
    groups: [
      { name: 'Matriz', slot: 0, profiles: ['default', 'recep', 'mesa'] },
      { name: 'Filial/Sul', slot: 6, profiles: ['filial', 'fantasma'] },
      { name: '', profiles: ['solta'] },
      { name: 'Sem lista' },
    ],
  };

  it('lê o arquivo: nomes, visual, posto válido e grupos limpos', () => {
    const h = makeHome([]);
    const file = join(h.home, 'layout.json');
    writeFileSync(file, JSON.stringify(LAYOUT));
    const { names, groups } = loadHermesLayout(file);
    expect(names.default).toEqual({ name: 'Ana', role: 'Chefia', look: 'f', post: 'lounge' });
    expect(names.mesa).toEqual({ name: 'Cris' });
    expect(names).not.toHaveProperty('groups');
    expect(groups).toEqual([
      { name: 'Matriz', slot: 0, profiles: ['default', 'recep', 'mesa'] },
      { name: 'Filial-Sul', slot: 6, profiles: ['filial', 'fantasma'] },
    ]);
    expect(loadHermesNames(file)).toEqual(names);
    expect(loadHermesLayout(join(h.home, 'nao-existe.json'))).toEqual({ names: {}, groups: [] });
  });

  function fixedSetup() {
    const dir = mkdtempSync(join(tmpdir(), 'habblaud-hermes-layout-'));
    dirs.push(dir);
    const file = join(dir, 'layout.json');
    writeFileSync(file, JSON.stringify(LAYOUT));
    const { names, groups } = loadHermesLayout(file);
    return setup(['recep', 'mesa', 'filial', 'solta'], names, groups);
  }

  it('um personagem fixo por perfil agrupado, mesmo sem sessão: ocioso, nome/visual/posto do layout', () => {
    const t = fixedSetup();
    t.source.start();
    const snap = t.office.commit().snapshot;
    const fixed = (id: string) => snap.agents.find((a) => a.id === `hermes:${id}:fixo`)!;
    expect([fixed('default'), fixed('recep'), fixed('mesa'), fixed('filial')].map((a) => [a.name, a.look, a.post, a.status])).toEqual([
      ['Ana', 'f', 'lounge', 'idle'],
      ['Beto', 'm', 'recepcao', 'idle'],
      ['Cris', expect.stringMatching(/^[fm]$/), undefined, 'idle'],
      ['Dora', expect.stringMatching(/^[fm]$/), undefined, 'idle'],
    ]);
    // 'solta' tem state.db mas o grupo dela é inválido (sem nome): fora do layout e sem sessão, não aparece (como na H1)
    expect(snap.agents.some((a) => a.id.includes('solta'))).toBe(false);
    expect(new Set(['default', 'recep', 'mesa'].map((p) => fixed(p).roomId)).size).toBe(1);
    const rooms = snap.rooms;
    expect(rooms.find((r) => r.name === 'Matriz')?.pin).toBe(0);
    expect(rooms.find((r) => r.name === 'Filial-Sul')?.pin).toBe(6);
    t.stop();
  });

  it('com sessões: trabalha, título/atividade da mais recente, papel conta as conversas; sem sessão volta a ocioso', () => {
    const t = fixedSetup();
    t.write('default', (db) => {
      session(db, { id: 'velha', source: 'telegram', title: 'Conversa antiga', started: T0 - 600_000, activity: T0 - 300_000 });
      message(db, { session: 'velha', role: 'assistant', at: T0 - 300_000, finish: 'stop' });
      session(db, { id: 'nova', source: 'cron', title: 'Relatório da manhã', started: T0 - 60_000, activity: T0 - 1_000 });
      message(db, { session: 'nova', role: 'tool', at: T0 - 1_000, tool: 'search' });
      session(db, { id: 'sub', source: 'subagent', parent: 'nova', title: 'Ajudante', started: T0 - 30_000, activity: T0 - 1_000 });
    });
    t.source.start();
    const a = t.office.get('hermes:default:fixo')!;
    expect(a).toMatchObject({ name: 'Ana', status: 'working', title: 'Relatório da manhã', role: 'Chefia (2 conversas)', post: 'lounge' });
    expect(a.activity?.text).toContain('search');
    expect(t.office.list().filter((x) => x.account === 'default' && x.kind === 'main')).toHaveLength(1);
    expect(t.office.list().find((x) => x.kind === 'sub')?.parentId).toBe('hermes:default:fixo');
    expect(t.source.sources().find((s) => s.label === 'default')?.sessions).toBe(2);

    t.advance(ACTIVE_WINDOW_MS + 60_000);
    t.source.poll(false);
    const idle = t.office.get('hermes:default:fixo')!;
    expect(idle).toMatchObject({ status: 'idle', role: 'Chefia', name: 'Ana' });
    expect(idle.title).toBeUndefined();
    expect(t.source.sources().find((s) => s.label === 'default')?.sessions).toBe(0);
    t.stop();
  });
});
