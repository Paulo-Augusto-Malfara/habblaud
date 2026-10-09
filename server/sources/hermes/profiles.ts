// Perfis do Hermes (Nous Research): o perfil padrão mora em HERMES_HOME (~/.hermes) e os demais em
// HERMES_HOME/profiles/<perfil>, cada um com o seu state.db. Só leitura: aqui nada é criado nem alterado.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PROFILE = 'default';

export interface HermesProfile {
  /** "default" para a pasta principal; senão o nome da pasta em profiles/. */
  id: string;
  /** Pasta do perfil. */
  dir: string;
  /** state.db do perfil. */
  db: string;
  /** Nome exibido do agente (arquivo de nomes > config.yaml do perfil > id). */
  name: string;
  /** Papel exibido, se o arquivo de nomes tiver um. */
  role?: string;
  /** Visual fixo do personagem, se o arquivo tiver um. */
  look?: 'f' | 'm';
  /** Posto fixo no núcleo do prédio ('recepcao' | 'lounge'), se o arquivo tiver um. */
  post?: string;
  /** Grupo do arquivo de layout: o perfil vira um funcionário fixo da sala desse grupo. */
  group?: HermesGroup;
}

export interface HermesNameEntry {
  name?: string;
  role?: string;
  look?: 'f' | 'm';
  post?: string;
}

/** Arquivo opcional de nomes: { "<perfil>": { "name": "Mia", "role": "Secretária" } }, com "default" para o padrão. */
export type HermesNames = Record<string, HermesNameEntry>;

/** Perfis fixados numa sala: { "name": "Matriz", "slot": 0, "profiles": ["alice", "bruno"] }. */
export interface HermesGroup {
  name: string;
  /** Vaga fixa do prédio (par = lado norte do corredor, ímpar = sul; coluna = 2 + slot/2). Sem: primeira livre. */
  slot?: number;
  profiles: string[];
}

/** Arquivo de layout (nomes + grupos). A chave reservada "groups" lista os grupos; as demais são ids de perfil. */
export interface HermesLayout {
  names: HermesNames;
  groups: HermesGroup[];
}

/** Postos aceitos em `post` (pontos em pé do núcleo do cliente, grupo "post:<nome>"). */
export const HERMES_POSTS = ['recepcao', 'lounge'] as const;

export function hermesHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.HERMES_HOME?.trim() || join(home, '.hermes');
}

function cleanGroups(raw: unknown): HermesGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: HermesGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue;
    const { name, slot, profiles } = g as { name?: unknown; slot?: unknown; profiles?: unknown };
    const label = typeof name === 'string' ? name.replace(/[\\/]+/g, '-').trim().slice(0, 40) : '';
    if (!label || !Array.isArray(profiles)) continue;
    const ids = profiles.filter((p): p is string => typeof p === 'string' && !!p.trim()).map((p) => p.trim());
    out.push({ name: label, ...(Number.isInteger(slot) && (slot as number) >= 0 && (slot as number) < 64 ? { slot: slot as number } : {}), profiles: ids });
  }
  return out;
}

export function loadHermesLayout(file: string | undefined): HermesLayout {
  const empty: HermesLayout = { names: {}, groups: [] };
  if (!file) return empty;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
    const names: HermesNames = {};
    for (const [id, v] of Object.entries(raw)) {
      if (id === 'groups' || !v || typeof v !== 'object') continue;
      const { name, role, look, post } = v as { name?: unknown; role?: unknown; look?: unknown; post?: unknown };
      names[id] = {
        ...(typeof name === 'string' && name.trim() ? { name: name.trim().slice(0, 40) } : {}),
        ...(typeof role === 'string' && role.trim() ? { role: role.trim().slice(0, 80) } : {}),
        ...(look === 'f' || look === 'm' ? { look } : {}),
        ...(typeof post === 'string' && (HERMES_POSTS as readonly string[]).includes(post) ? { post } : {}),
      };
    }
    return { names, groups: cleanGroups((raw as { groups?: unknown }).groups) };
  } catch {
    return empty;
  }
}

export function loadHermesNames(file: string | undefined): HermesNames {
  return loadHermesLayout(file).names;
}

/** Nome no config.yaml do perfil: só uma chave simples de primeiro nível (sem parser de YAML, sem ler o resto). */
function configName(dir: string): string | undefined {
  try {
    const text = readFileSync(join(dir, 'config.yaml'), 'utf8');
    for (const key of ['display_name', 'agent_name', 'name']) {
      const m = new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(text);
      const v = m?.[1].replace(/^["']|["']$/g, '').trim();
      if (v) return v.slice(0, 40);
    }
  } catch {
    // sem config.yaml legível: usa o id
  }
  return undefined;
}

function titleCase(id: string): string {
  return id === DEFAULT_PROFILE ? 'Hermes' : id.charAt(0).toUpperCase() + id.slice(1);
}

/** Perfis com state.db em `home`, o padrão primeiro e os demais por nome. */
export function discoverHermesProfiles(home: string, names: HermesNames = {}, groups: readonly HermesGroup[] = []): HermesProfile[] {
  const dirs: Array<{ id: string; dir: string }> = [{ id: DEFAULT_PROFILE, dir: home }];
  try {
    const sub = readdirSync(join(home, 'profiles'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const id of sub) dirs.push({ id, dir: join(home, 'profiles', id) });
  } catch {
    // sem profiles/: só o padrão
  }
  return dirs
    .filter((d) => existsSync(join(d.dir, 'state.db')))
    .map((d) => {
      const n = names[d.id];
      const p: HermesProfile = { id: d.id, dir: d.dir, db: join(d.dir, 'state.db'), name: n?.name ?? configName(d.dir) ?? titleCase(d.id) };
      if (n?.role) p.role = n.role;
      if (n?.look) p.look = n.look;
      if (n?.post) p.post = n.post;
      const group = groups.find((g) => g.profiles.includes(d.id));
      if (group) p.group = group;
      return p;
    });
}
