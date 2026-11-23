// The selftests drive real `claude` TUIs through tmux on a machine where the auto-clear
// watchers and fleet agents ALSO live in tmux. A selftest that touches the default tmux
// server kills all of them: measured 2026-11-23, selftest-clear-reload.sh called
// `tmux kill-server` on the default server at start and at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../templates/', import.meta.url);
const scripts = readdirSync(dir).filter((f) => /^selftest-.*\.sh$/.test(f));

// A command line that runs tmux against the DEFAULT server: the word `tmux` as a command,
// not routed through `-L <socket>` and not the private wrapper's own definition.
function defaultServerCalls(src) {
  const shadowed = /^\s*tmux\(\)\s*\{\s*command tmux -L /m.test(src);
  return src.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => {
    const code = line.replace(/#.*$/, '');
    if (!/(^|[\s;&|(`$])tmux\s/.test(code)) return false;
    if (/tmux -L /.test(code) || /command -v tmux/.test(code) || /type -P tmux/.test(code)) return false;
    return !shadowed;
  });
}

test('there are selftests to check', () => assert.ok(scripts.length >= 2, scripts.join(',')));

for (const f of scripts) {
  test(`${f} never talks to the default tmux server`, () => {
    const calls = defaultServerCalls(readFileSync(new URL(f, dir), 'utf8'));
    assert.deepEqual(calls, [], `default-server tmux calls in ${f}: ${calls.map(([n]) => n).join(', ')}`);
  });
}

test('the trust dialog is answered "Yes" (Down, Enter) — a bare Enter selects "No, exit" on 2.1.330', () => {
  for (const f of scripts) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const line of src.split('\n').filter((l) => /trust/i.test(l) && /send-keys/.test(l))) {
      assert.match(line, /send-keys[^#]*\bDown\b[^#]*\bEnter\b/, `${f}: ${line.trim()}`);
    }
  }
});
