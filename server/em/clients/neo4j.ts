// Neo4j client for EM — single shared driver, lazy-init, graceful failure.
//
// Reads RAAS_LINKS_NEO4J_* (preferred) or NEO4J_* (fallback). When the host
// is unreachable (off-VPN), getDriver() throws a typed error and callers
// (sync worker, /api/em/health) record the failure in EmSystemStatus.
// This module never throws on import.

import neo4j, { Driver, Session, auth } from "neo4j-driver";

export class Neo4jUnreachableError extends Error {
  constructor(public readonly cause: Error) {
    super(`Neo4j unreachable: ${cause.message}`);
    this.name = "Neo4jUnreachableError";
  }
}

export class Neo4jUnconfiguredError extends Error {
  constructor(missing: string) {
    super(`Neo4j not configured (${missing} missing)`);
    this.name = "Neo4jUnconfiguredError";
  }
}

type Config = {
  uri: string;
  user: string;
  password: string;
  database: string;
};

function readConfig(): Config | null {
  const uri =
    process.env.RAAS_LINKS_NEO4J_URI ?? process.env.NEO4J_URI;
  const user =
    process.env.RAAS_LINKS_NEO4J_USER ?? process.env.NEO4J_USERNAME;
  const password =
    process.env.RAAS_LINKS_NEO4J_PASSWORD ?? process.env.NEO4J_PASSWORD;
  const database =
    process.env.RAAS_LINKS_NEO4J_DATABASE ??
    process.env.NEO4J_DATABASE ??
    "neo4j";

  if (!uri || !user || !password) return null;
  return { uri, user, password, database };
}

let _driver: Driver | null = null;
let _config: Config | null = null;

/** Lazily create the singleton driver. Returns null when env not configured. */
export function getDriver(): Driver | null {
  if (_driver) return _driver;
  const cfg = readConfig();
  if (!cfg) return null;
  _config = cfg;
  _driver = neo4j.driver(cfg.uri, auth.basic(cfg.user, cfg.password), {
    // 5 s connection timeout — off-VPN we want the failure to surface fast,
    // not hang the boot sequence.
    connectionTimeout: 5_000,
    maxConnectionLifetime: 60 * 60 * 1000, // 1 h
    disableLosslessIntegers: true,
  });
  return _driver;
}

/** Open a session against the configured database. */
export function openSession(): Session {
  const driver = getDriver();
  if (!driver || !_config) {
    throw new Neo4jUnconfiguredError("uri/user/password");
  }
  return driver.session({ database: _config.database });
}

/** Best-effort connectivity probe. Returns null when unreachable. */
export async function probe(): Promise<
  | { ok: true; address: string; database: string }
  | { ok: false; error: string }
> {
  const cfg = readConfig();
  if (!cfg) return { ok: false, error: "neo4j not configured" };
  const driver = getDriver();
  if (!driver) return { ok: false, error: "driver init failed" };
  try {
    const info = await driver.getServerInfo();
    return { ok: true, address: info.address ?? cfg.uri, database: cfg.database };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Close the driver — only call on graceful shutdown. */
export async function closeDriver(): Promise<void> {
  if (_driver) {
    await _driver.close();
    _driver = null;
    _config = null;
  }
}

export function getConfigSummary(): { configured: boolean; uri?: string; database?: string } {
  const cfg = readConfig();
  if (!cfg) return { configured: false };
  return { configured: true, uri: cfg.uri, database: cfg.database };
}
