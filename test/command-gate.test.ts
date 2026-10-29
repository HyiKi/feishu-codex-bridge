import { describe, expect, it } from 'vitest';
import { classifyCommand, redactCommand } from '../src/agent/command-gate';

const zsh = (script: string): string => `/bin/zsh -lc '${script.replace(/'/g, `'"'"'`)}'`;
const files: Record<string, string> = {};
const readText = (path: string): string | undefined => files[path];
const gated = (command: string, cwd = '/work'): boolean => classifyCommand(command, { cwd, readText }).gated;

describe('command gate: DMS (mcp-call dms-mcp-server)', () => {
  it.each(['createDataChangeOrder', 'submitOrderApproval', 'approveOrder'])('gates %s', (tool) => {
    expect(gated(`mcp-call call dms-mcp-server ${tool} --args '{"a":1}'`)).toBe(true);
    expect(gated(zsh(`/Users/x/.local/bin/mcp-call call dms-mcp-server ${tool} --args-file -`))).toBe(true);
  });
  it.each(['getDatabase', 'listTables', 'searchDatabase', 'getOrderInfo', 'executeScript', 'getTableDetailInfo'])(
    'lets %s through',
    (tool) => {
      expect(gated(`mcp-call call dms-mcp-server ${tool} --args '{}'`)).toBe(false);
    },
  );
  it('gates an unknown DMS tool rather than guessing it is a read', () => {
    expect(gated('mcp-call call dms-mcp-server somethingNew --args {}')).toBe(true);
  });
  it('gates a call whose server or tool cannot be resolved statically', () => {
    expect(gated('mcp-call call "$SRV" "$TOOL" --args {}')).toBe(true);
  });
  it('does not gate listing or tool discovery', () => {
    expect(gated('mcp-call servers')).toBe(false);
    expect(gated('mcp-call tools dms-mcp-server --schema')).toBe(false);
  });
});

describe('command gate: other MCP servers', () => {
  it.each(['erp-warebase query', 'alibaba-cloud-observability anyTool', 'beijing-warebase query'])('lets %s through', (call) => {
    expect(gated(`mcp-call call ${call} --args '{"sql":"drop table x"}'`)).toBe(false);
  });
});

describe('command gate: erp-dev-database execute_sql', () => {
  const call = (sql: string): string =>
    `mcp-call call erp-dev-database execute_sql_x --args ${JSON.stringify(JSON.stringify({ sql }))}`;
  it.each([
    'SELECT * FROM hades.t LIMIT 5',
    'select count(*) from hades.t',
    'SHOW search_path',
    'EXPLAIN SELECT 1',
    "SELECT 'import' AS word, updated_at, created_by FROM hades.t",
    'WITH x AS (SELECT 1) SELECT * FROM x',
  ])('lets read %s through', (sql) => {
    expect(gated(call(sql))).toBe(false);
  });
  it.each([
    "UPDATE hades.t SET a = 1 WHERE id = 2",
    'delete from hades.t where id = 1',
    'INSERT INTO hades.t(a) VALUES (1)',
    'TRUNCATE hades.t',
    'DROP TABLE hades.t',
    'ALTER TABLE hades.t ADD COLUMN c int',
    'CREATE TABLE hades.z AS SELECT 1',
    'SELECT * INTO hades.copy FROM hades.t',
    'SELECT 1; UPDATE hades.t SET a = 1',
    'WITH d AS (DELETE FROM hades.t RETURNING *) SELECT * FROM d',
    'SELECT * FROM hades.t FOR UPDATE',
    'SELECT nextval(\'hades.seq\')',
    'SELECT pg_terminate_backend(1)',
    'COPY hades.t TO PROGRAM \'id\'',
    'CALL hades.proc()',
    'GRANT ALL ON hades.t TO x',
  ])('gates write %s', (sql) => {
    expect(gated(call(sql))).toBe(true);
  });
  it('reads the SQL from --args-file, stdin heredoc and escaped payloads', () => {
    files['/work/ok.json'] = '{"sql":"select 1"}';
    files['/work/bad.json'] = '{"sql":"update hades.t set a=1"}';
    expect(gated('mcp-call call erp-dev-database execute_sql_x --args-file ok.json')).toBe(false);
    expect(gated('mcp-call call erp-dev-database execute_sql_x --args-file bad.json')).toBe(true);
    expect(gated("mcp-call call erp-dev-database execute_sql_x --args-file - <<'EOF'\n{\"sql\":\"delete from hades.t\"}\nEOF")).toBe(true);
    expect(gated("mcp-call call erp-dev-database execute_sql_x --args-file - <<'EOF'\n{\"sql\":\"select 1\"}\nEOF")).toBe(false);
  });
  it('gates when the SQL file is unreadable or the args come from a variable', () => {
    expect(gated('mcp-call call erp-dev-database execute_sql_x --args-file missing.json')).toBe(true);
    expect(gated('mcp-call call erp-dev-database execute_sql_x --args "$PAYLOAD"')).toBe(true);
  });
  it('does not let a later read call hide an earlier write in the same script', () => {
    const script = `${call('select 1')} && ${call('update hades.t set a=1')} && ${call('select 2')}`;
    expect(gated(zsh(script))).toBe(true);
  });
  it('does not read the write from a different call', () => {
    const script = `${call('select 1')}\nmcp-call call dms-mcp-server getDatabase --args '{"note":"update"}'`;
    expect(gated(zsh(script))).toBe(false);
  });
});

describe('command gate: curl / wget', () => {
  it.each([
    'curl -X POST http://a/b',
    "curl -sS -X 'PUT' http://a/b",
    'curl -XDELETE http://a/b',
    'curl --request PATCH http://a/b',
    'curl -d a=1 http://a/b',
    'curl --data-raw \'{"a":1}\' http://a/b',
    'curl -F file=@x http://a/b',
    'curl --json @body.json http://a/b',
    'curl -sS -H "x: y" -d @body http://a/b',
    'curl -T file http://a/b',
    'curl -X "$METHOD" http://a/b',
    'wget --post-data=a=1 http://a/b',
    'wget --method=DELETE http://a/b',
  ])('gates %s', (command) => {
    expect(gated(command)).toBe(true);
    expect(gated(zsh(command))).toBe(true);
  });
  it.each([
    'curl http://a/b',
    'curl -sS -H "accept: json" "http://a/b?x=1"',
    'curl -X GET http://a/b',
    'curl -sS -o out.json http://a/b',
    'curl -L --max-time 5 http://a/b',
    'wget -qO- http://a/b',
  ])('lets read %s through', (command) => {
    expect(gated(command)).toBe(false);
  });
  it('finds a write curl inside a pipeline, substitution or compound command', () => {
    expect(gated(zsh('X=$(curl -s -X POST http://a/b); echo "$X"'))).toBe(true);
    expect(gated(zsh('cd /tmp && curl -d a=1 http://a/b | jq .'))).toBe(true);
    expect(gated(zsh('if true; then curl -X DELETE http://a/b; fi'))).toBe(true);
    expect(gated(zsh('/usr/bin/curl -X POST http://a/b'))).toBe(true);
  });
  it('does not mistake a read curl followed by an unrelated -d flag', () => {
    expect(gated(zsh('curl -s http://a/b\nls -d /tmp'))).toBe(false);
  });
});

describe('command gate: SQL clients', () => {
  it('gates write statements and unreadable SQL files, passes reads', () => {
    expect(gated('psql -c "update t set a=1"')).toBe(true);
    expect(gated('psql -c "select 1"')).toBe(false);
    expect(gated('psql -f missing.sql')).toBe(true);
    files['/work/w.sql'] = 'delete from t;';
    files['/work/r.sql'] = 'select 1;';
    expect(gated('psql -f w.sql')).toBe(true);
    expect(gated('psql -f r.sql')).toBe(false);
    expect(gated('mysql -e "insert into t values (1)"')).toBe(true);
  });
});

describe('command gate: hades-dev', () => {
  const hd = 'node ~/.agents/skills/hades-dev-api/scripts/hades-dev.mjs';
  it('gates write calls, passes GET and --dry-run', () => {
    expect(gated(`${hd} call POST /logistics/v1/config/freight/save --json @b.json`)).toBe(true);
    expect(gated(`${hd} call DELETE /x`)).toBe(true);
    expect(gated(`${hd} call GET /logistics/v1/config/currency/list`)).toBe(false);
    expect(gated(`${hd} call POST /x --json @b.json --dry-run`)).toBe(false);
  });
  it('inspects the scenario file of `run`', () => {
    files['/work/read.json'] = '{"steps":[{"method":"GET","path":"/a"}]}';
    files['/work/write.json'] = '{"steps":[{"method":"POST","path":"/a"}]}';
    expect(gated(`${hd} run read.json`)).toBe(false);
    expect(gated(`${hd} run write.json`)).toBe(true);
    expect(gated(`${hd} run nowhere.json`)).toBe(true);
  });
});

describe('command gate: interpreters and scripts', () => {
  it('does not gate ordinary scripts or one-liners that merely read', () => {
    expect(gated(zsh('python3 -c "print(1)"'))).toBe(false);
    expect(gated(zsh("python3 - <<'PY'\nimport json\nprint(json.dumps({'a':1}))\nPY"))).toBe(false);
    expect(gated(zsh('node -e "console.log(3)"'))).toBe(false);
    expect(gated(zsh('python3 -c "import requests; print(requests.get(\'http://a\').text)"'))).toBe(false);
    expect(gated(zsh('ls -la && cat /etc/hosts | head -2'))).toBe(false);
    expect(gated(zsh('git status && git diff'))).toBe(false);
    expect(gated(zsh('for i in 1 2; do echo $i; done'))).toBe(false);
  });
  it('gates inline code that performs an HTTP write or writes through a DB driver', () => {
    expect(gated(zsh('python3 -c "import requests; requests.post(\'http://a\', json={})"'))).toBe(true);
    expect(gated(zsh("node -e \"fetch('http://a', {method: 'POST'})\""))).toBe(true);
    expect(gated(zsh("python3 - <<'PY'\nimport psycopg2\nc=psycopg2.connect('x')\nc.cursor().execute('update t set a=1')\nPY"))).toBe(true);
  });
  it('follows a script file the command runs', () => {
    files['/work/push.py'] = 'import requests\nrequests.put("http://a", data="x")';
    files['/work/read.py'] = 'import requests\nprint(requests.get("http://a").text)';
    files['/work/call.mjs'] = "import {execSync} from 'node:child_process';\nexecSync('mcp-call call dms-mcp-server createDataChangeOrder --args-file -')";
    files['/work/curl.sh'] = '#!/bin/sh\ncurl -X POST http://a/b';
    expect(gated(zsh('python3 push.py'))).toBe(true);
    expect(gated(zsh('python3 read.py'))).toBe(false);
    expect(gated(zsh('node call.mjs'))).toBe(true);
    expect(gated(zsh('bash ./curl.sh'))).toBe(true);
    expect(gated(zsh('./curl.sh'))).toBe(true);
  });
  it('does not read vendored or system script paths', () => {
    files['/work/node_modules/x/index.js'] = 'requests.post("http://a")';
    expect(gated(zsh('node node_modules/x/index.js'))).toBe(false);
  });
});

describe('command gate: verdict details', () => {
  it('explains why a command was gated', () => {
    const verdict = classifyCommand('mcp-call call dms-mcp-server approveOrder --args {}', { cwd: '/work', readText });
    expect(verdict.gated).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('approveOrder');
  });
  it('returns an empty verdict for plain reads', () => {
    expect(classifyCommand('ls', { cwd: '/work', readText })).toEqual({ gated: false, reasons: [] });
  });
});

describe('redactCommand', () => {
  it('masks credentials before a command is shown in a group card', () => {
    const text = redactCommand(
      'curl -H "Authorization: Bearer abc.def.ghi" -d token=SECRET1 "https://u:pw@host/x?api_key=KEY1&a=1" --user bob:hunter2',
    );
    expect(text).not.toMatch(/SECRET1|hunter2|KEY1|pw@|abc\.def\.ghi/);
    expect(text).toContain('host/x');
  });
  it('masks a signature header value', () => {
    expect(redactCommand('curl -H "HADES_CIDER_SIGNATURE: s3cr3t" url')).not.toContain('s3cr3t');
  });
});
