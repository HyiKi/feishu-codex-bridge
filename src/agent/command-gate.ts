import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/**
 * ERP write-gate classifier. Pure and synchronous apart from bounded reads of
 * files the command itself references (scripts, `--args-file`, hades scenarios).
 * It answers one question for a shell command the agent is about to run: does
 * it look like an ERP write (DMS change order, DB DML, HTTP write, ...)?
 * Anything it cannot confirm to be read-only for the tools it knows is gated;
 * everything else passes untouched. Gated commands need an admin to approve.
 */

export interface GateVerdict {
  gated: boolean;
  reasons: string[];
}

export interface ClassifyOptions {
  cwd?: string;
  /** Test seam / custom reader. Return undefined when the file can't be read. */
  readText?: (path: string) => string | undefined;
}

const MAX_FILE_BYTES = 512 * 1024;
const SKIP_PATH_PARTS = ['/node_modules/', '/.agents/skills/', '/.codex/', '/.local/share/mcp-call/', '/usr/', '/opt/', '/Applications/'];

/** dms-mcp-server tools known to be read-only (executeScript is deliberately
 * left ungated by the project owner). Every other DMS tool is gated. */
const DMS_PASS_TOOLS = new Set([
  'listInstances',
  'getInstance',
  'searchDatabase',
  'getDatabase',
  'listTables',
  'getTableDetailInfo',
  'getOrderInfo',
  'executeScript',
  'generateSql',
  'fixSql',
  'answerSqlSyntax',
  'optimizeSql',
]);

const SQL_WRITE_ANYWHERE_RE =
  /\b(?:insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|into|vacuum|reindex)\b|\bcomment\s+on\b|\bset\s+(?:session|local|role)\b|\bdo\s+(?:\$|language)|\bfor\s+(?:update|share|no\s+key)\b|\b(?:nextval|setval|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_sleep|lo_import|lo_export|lo_unlink|dblink\w*|pg_advisory_lock\w*|set_config)\s*\(/i;

/** Statement-leading verbs that are common English words, so only a hit at the
 * start of a statement counts (not inside a string literal such as 'import'). */
const SQL_WRITE_LEADING_RE =
  /(?:^|;|\n|\\?"sql\\?"\s*:\s*\\?")\s*(?:call|copy|lock|refresh|cluster|import|prepare|execute|discard|listen|notify|checkpoint|reassign)\b/i;

const CODE_DB_DRIVER_RE =
  /\b(?:psycopg2?|pymysql|mysql\.connector|mysqlclient|asyncpg|sqlalchemy|sqlite3|pg8000|cx_Oracle|oracledb|knex|mysql2|better-sqlite3|sequelize|typeorm|prisma|JDBC|createConnection|createPool)\b|require\(\s*['"](?:pg|mysql2?|sqlite3)['"]\s*\)|from\s+['"](?:pg|mysql2?|sqlite3)['"]/i;

const CODE_SQL_WRITE_RE =
  /\b(?:insert\s+into|update\s+[\w."`]+\s+set|delete\s+from|drop\s+(?:table|schema|database|index|view)|truncate\s+(?:table\s+)?[\w."`]|alter\s+table|create\s+(?:table|index|or\s+replace))\b/i;

const CODE_HTTP_WRITE: Array<[RegExp, string]> = [
  [/\b(?:requests|httpx|axios|got|ky|superagent|aiohttp|session|client|http|https|api)\w*\s*\.\s*(?:post|put|patch|delete)\s*\(/i, '脚本中的 HTTP 写请求'],
  [/\bmethod['"]?\s*[:=]\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i, '脚本中的 HTTP 写方法'],
];

const GATED_TOOL_NAME_RE = /\b(?:createDataChangeOrder|submitOrderApproval|approveOrder)\b/;

const CMD_BOUNDARY = '(?:^|[\\s;&|(`\'"=])(?:[^\\s;&|\'"`]*\\/)?';
const MCP_CALL_RE = new RegExp(`${CMD_BOUNDARY}mcp-call\\s+call\\s+(\\S+)\\s+(\\S+)`, 'g');
const CURL_RE = new RegExp(`${CMD_BOUNDARY}curl(?=\\s)`, 'g');
const WGET_RE = new RegExp(`${CMD_BOUNDARY}wget(?=\\s)`, 'g');
const SQL_CLIENT_RE = new RegExp(`${CMD_BOUNDARY}(?:psql|mysql|mariadb|sqlite3|pgcli|mycli|clickhouse-client)(?=\\s)`, 'g');
const INTERPRETER_RE = new RegExp(
  `${CMD_BOUNDARY}(?:python[\\d.]*|node(?:js)?|deno|bun|bunx|ruby|perl|php|tsx|ts-node|npx|uvx?|(?:ba|z|da)?sh)(?=\\s|$)`,
  'i',
);
const SCRIPT_EXT_RE = /\.(?:py|mjs|cjs|js|ts|mts|rb|pl|php|sh|bash|zsh|sql)$/i;

const CURL_WRITE_CI_RE =
  /(?:^|\s)(?:-X\s*['"]?(?:POST|PUT|PATCH|DELETE)\b|-X\s*['"]?\$|--request[=\s]+['"]?(?:POST|PUT|PATCH|DELETE)\b|--request[=\s]+['"]?\$|--(?:data(?:-raw|-binary|-urlencode|-ascii)?|form(?:-string)?|json|upload-file|config)(?=[\s=]|$))/i;
const CURL_WRITE_CS_RE = /(?:^|\s)-[A-Za-z]*[dFTK](?=[\s=@'"]|$)/;
const WGET_WRITE_RE = /--(?:post-data|post-file|body-data|body-file)\b|--method[=\s]+['"]?(?:POST|PUT|PATCH|DELETE)\b/i;

function unquote(token: string): string {
  return token.replace(/^[\\'"]+/, '').replace(/[\\'"]+$/, '');
}

/** Parse one POSIX shell word (quotes/escapes resolved), stopping at unquoted whitespace. */
function parseShellWord(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length && !/\s/.test(input[i]!)) {
    const ch = input[i]!;
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) return out + input.slice(i + 1);
      out += input.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1]!)) {
          out += input[i + 1];
          i += 2;
        } else {
          out += input[i++];
        }
      }
      i++;
    } else if (ch === '\\' && i + 1 < input.length) {
      out += input[i + 1];
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** `/bin/zsh -lc '<script>'` → `<script>`; anything else is returned unchanged. */
export function unwrapShell(command: string): string {
  const m = /^\s*(?:\S*\/)?(?:ba|z|da|k)?sh\s+(?:-[A-Za-z]+\s+)*?-[A-Za-z]*c\s+([\s\S]+)$/.exec(command);
  if (!m) return command;
  const word = parseShellWord(m[1]!.trimStart());
  return word || command;
}

/** Rest of the logical line (backslash-newline continues it). */
function logicalLine(text: string): string {
  const lines = text.split('\n');
  let out = '';
  for (const line of lines) {
    if (line.endsWith('\\')) {
      out += `${line.slice(0, -1)} `;
      continue;
    }
    out += line;
    break;
  }
  return out;
}

/** Reads at most MAX_FILE_BYTES of a regular file; an oversized script is still
 * scanned (its head), never silently skipped. */
function defaultReadText(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const info = fstatSync(fd);
    if (!info.isFile()) return undefined;
    const size = Math.min(info.size, MAX_FILE_BYTES);
    const buffer = Buffer.alloc(size);
    const read = readSync(fd, buffer, 0, size, 0);
    return buffer.toString('utf8', 0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function resolvePath(token: string, cwd: string | undefined): string | undefined {
  const raw = unquote(token);
  if (!raw || /[$`*?]/.test(raw)) return undefined;
  if (raw === '~' || raw.startsWith('~/')) return resolve(homedir(), raw.slice(2));
  if (isAbsolute(raw)) return raw;
  return cwd ? resolve(cwd, raw) : undefined;
}

function sqlHasWrite(text: string): boolean {
  const flat = text.replace(/\\[nrt]/g, '\n');
  return SQL_WRITE_ANYWHERE_RE.test(flat) || SQL_WRITE_LEADING_RE.test(flat);
}

interface LoadedFile {
  path: string;
  text: string;
}

function referencedFiles(
  script: string,
  cwd: string | undefined,
  readText: (path: string) => string | undefined,
  interpreter: boolean,
): LoadedFile[] {
  const found: LoadedFile[] = [];
  const seen = new Set<string>();
  for (const raw of script.match(/"[^"\n]*"|'[^'\n]*'|[^\s;&|<>()`]+/g) ?? []) {
    const token = unquote(raw);
    if (!SCRIPT_EXT_RE.test(token)) continue;
    if (!interpreter && !token.startsWith('./') && !token.startsWith('../')) continue;
    const path = resolvePath(token, cwd);
    if (!path || seen.has(path) || SKIP_PATH_PARTS.some((part) => path.includes(part))) continue;
    seen.add(path);
    const text = readText(path);
    if (text !== undefined) found.push({ path, text });
  }
  return found;
}

function checkMcpCall(
  corpus: string,
  cwd: string | undefined,
  readText: (path: string) => string | undefined,
  reasons: Set<string>,
): void {
  const matches = [...corpus.matchAll(MCP_CALL_RE)];
  matches.forEach((m, index) => {
    const server = unquote(m[1]!);
    const tool = unquote(m[2]!);
    if (/[$`]/.test(server + tool)) {
      reasons.add('mcp-call 的目标 server/tool 无法静态确认');
      return;
    }
    if (server === 'dms-mcp-server') {
      if (!DMS_PASS_TOOLS.has(tool)) reasons.add(`DMS 写操作：${tool}`);
      return;
    }
    if (server !== 'erp-dev-database' || !tool.startsWith('execute_sql')) return;
    const from = (m.index ?? 0) + m[0].length;
    const to = matches[index + 1]?.index ?? corpus.length;
    const rest = corpus.slice(from, to);
    const line = logicalLine(rest);
    let sqlText = rest;
    const fileArg = /--args-file[=\s]+(\S+)/.exec(line);
    if (fileArg) {
      const target = unquote(fileArg[1]!);
      if (target !== '-') {
        const path = resolvePath(target, cwd);
        const text = path ? readText(path) : undefined;
        if (text === undefined) {
          reasons.add('开发库 SQL 参数文件无法读取，无法确认是否只读');
          return;
        }
        sqlText += `\n${text}`;
      }
    } else if (/--args(?:=|\s+)["']?\$/.test(line)) {
      reasons.add('开发库 SQL 来自变量，无法确认是否只读');
      return;
    }
    if (sqlHasWrite(sqlText)) reasons.add('开发库 SQL 含写语句');
  });
}

function checkCurl(corpus: string, reasons: Set<string>): void {
  for (const m of corpus.matchAll(CURL_RE)) {
    const line = logicalLine(corpus.slice((m.index ?? 0) + m[0].length));
    if (CURL_WRITE_CI_RE.test(line) || CURL_WRITE_CS_RE.test(line)) {
      reasons.add('curl 写请求（POST/PUT/PATCH/DELETE 或带请求体）');
    }
  }
  for (const m of corpus.matchAll(WGET_RE)) {
    if (WGET_WRITE_RE.test(logicalLine(corpus.slice((m.index ?? 0) + m[0].length)))) {
      reasons.add('wget 写请求');
    }
  }
}

function checkSqlClients(
  corpus: string,
  cwd: string | undefined,
  readText: (path: string) => string | undefined,
  reasons: Set<string>,
): void {
  const matches = [...corpus.matchAll(SQL_CLIENT_RE)];
  matches.forEach((m, index) => {
    const from = (m.index ?? 0) + m[0].length;
    const rest = corpus.slice(from, matches[index + 1]?.index ?? corpus.length);
    const line = logicalLine(rest);
    let sqlText = rest;
    const fileArg = /(?:\s-f|--file[=\s]|\s<)\s*(\S+)/.exec(line);
    if (fileArg) {
      const path = resolvePath(fileArg[1]!, cwd);
      const text = path ? readText(path) : undefined;
      if (text === undefined) {
        reasons.add('数据库客户端的 SQL 文件无法读取，无法确认是否只读');
        return;
      }
      sqlText += `\n${text}`;
    }
    if (sqlHasWrite(sqlText)) reasons.add('数据库客户端执行写语句');
  });
}

const HADES_WRITE_METHOD_RE = /^['"]?(?:POST|PUT|PATCH|DELETE)['"]?$/i;

function checkHadesDev(
  script: string,
  cwd: string | undefined,
  readText: (path: string) => string | undefined,
  reasons: Set<string>,
): void {
  for (const m of script.matchAll(/hades-dev(?:\.mjs)?(?=\s)/g)) {
    const line = logicalLine(script.slice((m.index ?? 0) + m[0].length));
    if (/--dry-run\b/.test(line)) continue;
    const tokens = line.trim().split(/\s+/);
    const callAt = tokens.indexOf('call');
    if (callAt >= 0) {
      const method = tokens.slice(callAt + 1).find((token) => /^['"]?(?:GET|HEAD|POST|PUT|PATCH|DELETE)['"]?$/i.test(token));
      if (method && HADES_WRITE_METHOD_RE.test(method)) reasons.add('hades-dev 写接口调用');
    }
    const runAt = tokens.indexOf('run');
    if (runAt >= 0) {
      const target = tokens.slice(runAt + 1).find((token) => !token.startsWith('--'));
      const path = target ? resolvePath(target, cwd) : undefined;
      const text = path ? readText(path) : undefined;
      if (text === undefined) reasons.add('hades-dev 场景文件无法读取，无法确认是否含写接口');
      else if (/"method"\s*:\s*"(?:POST|PUT|PATCH|DELETE)"/i.test(text)) reasons.add('hades-dev 场景含写接口');
    }
  }
}

function checkCode(corpus: string, reasons: Set<string>): void {
  for (const [re, why] of CODE_HTTP_WRITE) if (re.test(corpus)) reasons.add(why);
  if (CODE_SQL_WRITE_RE.test(corpus) && CODE_DB_DRIVER_RE.test(corpus)) reasons.add('脚本经数据库驱动执行写语句');
  if (GATED_TOOL_NAME_RE.test(corpus) && /mcp-call|dms-mcp-server|mcporter/i.test(corpus)) {
    reasons.add('脚本中调用 DMS 变更工具');
  }
}

export function classifyCommand(command: string, opts: ClassifyOptions = {}): GateVerdict {
  const readText = opts.readText ?? defaultReadText;
  const script = unwrapShell(command);
  const interpreter = INTERPRETER_RE.test(script);
  const files = referencedFiles(script, opts.cwd, readText, interpreter);
  const corpus = [script, ...files.map((file) => file.text)].join('\n');
  const reasons = new Set<string>();
  checkMcpCall(corpus, opts.cwd, readText, reasons);
  checkCurl(corpus, reasons);
  checkSqlClients(corpus, opts.cwd, readText, reasons);
  checkHadesDev(script, opts.cwd, readText, reasons);
  if (interpreter || files.length > 0) checkCode(corpus, reasons);
  return { gated: reasons.size > 0, reasons: [...reasons] };
}

/** Best-effort secret masking for text shown in a group chat card. */
export function redactCommand(text: string): string {
  return text
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)(\s*:\s*)[^"'\n]*/gi, '$1$2***')
    .replace(
      /\b([\w-]*(?:token|secret|password|passwd|pwd|signature|credential|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key))(["']?\s*[:=]\s*["']?)[^\s"'&,}\\]+/gi,
      '$1$2***',
    )
    .replace(/(\w+:\/\/)([^\s:@/]+):([^\s@/]+)@/g, '$1$2:***@')
    .replace(/(--user|-u)(\s+)[^\s:]+:\S+/g, '$1$2***')
    .replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/g, '***');
}
