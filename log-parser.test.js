import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLogEntriesContent } from './src/utils/logParser.js';

test('parse viewer log format', () => {
  const content = [
    JSON.stringify({ timestamp: '2026-03-05T00:00:00Z', url: '/v1/messages', mainAgent: true, body: { messages: [] } }),
    '---',
    JSON.stringify({ timestamp: '2026-03-05T00:00:01Z', url: '/v1/messages', mainAgent: true, body: { messages: [] } }),
    '---',
    '',
  ].join('\n');

  const entries = parseLogEntriesContent(content);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].url, '/v1/messages');
});

test('parse codex session jsonl format', () => {
  const content = [
    JSON.stringify({
      timestamp: '2026-03-05T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'sess-1', cwd: '/tmp/project', model: 'gpt-5.3-codex' },
    }),
    JSON.stringify({
      timestamp: '2026-03-05T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'hello codex' },
    }),
    JSON.stringify({
      timestamp: '2026-03-05T00:00:02.000Z',
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
    }),
    JSON.stringify({
      timestamp: '2026-03-05T00:00:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    }),
    JSON.stringify({
      timestamp: '2026-03-05T00:00:04.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'TEST_OK' }] },
    }),
    JSON.stringify({
      timestamp: '2026-03-05T00:00:05.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'TEST_OK' },
    }),
  ].join('\n');

  const entries = parseLogEntriesContent(content);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].provider, 'openai');
  assert.equal(entries[0].mainAgent, true);
  assert.match(entries[0].url, /codex:\/\/session\/sess-1\/turn\/(t1|1)/);

  const msgs = entries[0].body.messages;
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content[0].text, 'hello codex');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content[0].type, 'tool_use');
  assert.equal(msgs[2].role, 'user');
  assert.equal(msgs[2].content[0].type, 'tool_result');
});

test('parse real codex session fixture shape', () => {
  const fixturePath = join(process.env.HOME, '.codex', 'sessions', '2026', '03', '05', 'rollout-2026-03-05T00-07-48-019cb99a-ffc7-7fe0-83c6-fbd52c9d66ad.jsonl');
  if (!existsSync(fixturePath)) return;
  const fixture = readFileSync(fixturePath, 'utf-8');
  const entries = parseLogEntriesContent(fixture);
  assert.ok(entries.length > 0);
  assert.ok(entries.some(e => e.mainAgent));
});
