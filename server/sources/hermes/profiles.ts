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
}

/** Arquivo opcional de nomes: { "<perfil>": { "name": "Mia", "role": "Secretária" } }, com "default" para o padrão. */
export type HermesNames = Record<string, { name?: string; role?: string }>;

export function hermesHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.HERMES_HOME?.trim() || join(home, '.hermes');
}

export function loadHermesNames(file: string | undefined): HermesNames {
  if (!file) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: HermesNames = {};
    for (const [id, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object') continue;
      const { name, role } = v as { name?: unknown; role?: unknown };
      out[id] = {
        ...(typeof name === 'string' && name.trim() ? { name: name.trim().slice(0, 40) } : {}),
        ...(typeof role === 'string' && role.trim() ? { role: role.trim().slice(0, 80) } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
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
export function discoverHermesProfiles(home: string, names: HermesNames = {}): HermesProfile[] {
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
      return p;
    });
}
