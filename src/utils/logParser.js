function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function parseViewerEntries(content) {
  const entries = content
    .split('\n---\n')
    .filter(line => line.trim())
    .map(entry => safeJsonParse(entry))
    .filter(Boolean);
  return entries;
}

function extractTextBlocks(content = []) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(block => block && typeof block === 'object' && typeof block.text === 'string')
    .map(block => block.text);
}

function normalizeToolInput(argumentsRaw) {
  if (typeof argumentsRaw !== 'string') return argumentsRaw ?? {};
  const parsed = safeJsonParse(argumentsRaw);
  return parsed ?? { raw: argumentsRaw };
}

function normalizeToolOutput(outputRaw) {
  if (typeof outputRaw === 'string') return outputRaw;
  if (outputRaw == null) return '';
  try {
    return JSON.stringify(outputRaw, null, 2);
  } catch {
    return String(outputRaw);
  }
}

function mapTokenUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const total = usage.total_tokens ?? input + output;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cache_read_input_tokens: cached,
  };
}

function parseCodexSessionEntries(content) {
  const lines = content.split('\n').filter(Boolean);
  const records = lines.map(line => safeJsonParse(line)).filter(Boolean);
  if (records.length === 0) return [];

  const hasCodexShape = records.some(r => r.type === 'session_meta' || (r.type === 'event_msg' && r.payload?.type === 'user_message'));
  if (!hasCodexShape) return [];

  const meta = records.find(r => r.type === 'session_meta')?.payload || {};
  const sessionId = meta.id || 'unknown';
  const model = meta.model || meta.model_slug || 'codex';
  const project = (meta.cwd || '').split('/').filter(Boolean).pop() || 'codex';

  const entries = [];
  const conversation = [];
  let latestUsage = null;
  let callSeq = 0;
  let currentTurn = null;

  const finalizeTurn = () => {
    if (!currentTurn) return;
    const baseTs = currentTurn.timestamp || new Date().toISOString();

    if (currentTurn.userText) {
      conversation.push({
        role: 'user',
        content: [{ type: 'text', text: currentTurn.userText }],
        _timestamp: baseTs,
      });
    }

    let lastAssistantText = '';
    for (const event of currentTurn.events) {
      if (event.kind === 'tool_call') {
        conversation.push({
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: event.id,
            name: event.name || 'tool',
            input: event.input ?? {},
          }],
          _timestamp: event.timestamp || baseTs,
        });
      } else if (event.kind === 'tool_result') {
        conversation.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: event.callId,
            content: event.output || '',
            is_error: false,
          }],
          _timestamp: event.timestamp || baseTs,
        });
      } else if (event.kind === 'assistant_text' && event.text) {
        lastAssistantText = event.text;
        conversation.push({
          role: 'assistant',
          content: [{ type: 'text', text: event.text }],
          _timestamp: event.timestamp || baseTs,
        });
      }
    }

    if (!lastAssistantText && currentTurn.lastAgentMessage) {
      lastAssistantText = currentTurn.lastAgentMessage;
      conversation.push({
        role: 'assistant',
        content: [{ type: 'text', text: currentTurn.lastAgentMessage }],
        _timestamp: currentTurn.endTimestamp || baseTs,
      });
    }

    const usage = mapTokenUsage(currentTurn.tokenUsage || latestUsage);
    const timestamp = currentTurn.endTimestamp || baseTs;
    const body = {
      model,
      messages: clone(conversation),
      metadata: {
        user_id: sessionId,
        source: 'codex_session',
        turn_id: currentTurn.turnId || null,
      },
    };

    const turnKey = currentTurn.turnId || (entries.length + 1);
    entries.push({
      timestamp,
      project,
      url: `codex://session/${sessionId}/turn/${turnKey}`,
      method: 'SESSION',
      provider: 'openai',
      mainAgent: true,
      body,
      response: {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: {
          output_text: lastAssistantText,
          usage: usage || undefined,
        },
      },
      duration: currentTurn.durationMs || 0,
      isStream: false,
      isCountTokens: false,
    });

    currentTurn = null;
  };

  for (const record of records) {
    const ts = record.timestamp || new Date().toISOString();
    if (record.type === 'event_msg' && record.payload?.type === 'token_count') {
      latestUsage = record.payload?.info?.last_token_usage || record.payload?.info?.total_token_usage || latestUsage;
      if (currentTurn) currentTurn.tokenUsage = latestUsage;
      continue;
    }

    if (record.type === 'event_msg' && record.payload?.type === 'user_message') {
      finalizeTurn();
      currentTurn = {
        turnId: null,
        timestamp: ts,
        endTimestamp: null,
        durationMs: 0,
        userText: record.payload?.message || '',
        events: [],
        lastAgentMessage: '',
        tokenUsage: latestUsage,
      };
      continue;
    }

    if (record.type === 'event_msg' && record.payload?.type === 'task_started') {
      if (currentTurn) currentTurn.turnId = record.payload?.turn_id || currentTurn.turnId;
      continue;
    }

    if (record.type === 'event_msg' && record.payload?.type === 'task_complete') {
      if (currentTurn) {
        currentTurn.turnId = record.payload?.turn_id || currentTurn.turnId;
        currentTurn.endTimestamp = ts;
        currentTurn.lastAgentMessage = record.payload?.last_agent_message || currentTurn.lastAgentMessage;
        currentTurn.durationMs = Math.max(0, new Date(currentTurn.endTimestamp).getTime() - new Date(currentTurn.timestamp).getTime());
      }
      finalizeTurn();
      continue;
    }

    if (!currentTurn || record.type !== 'response_item' || !record.payload) continue;

    const payload = record.payload;
    if (payload.type === 'message' && payload.role === 'assistant') {
      const textBlocks = extractTextBlocks(payload.content);
      for (const text of textBlocks) {
        if (!text) continue;
        currentTurn.events.push({ kind: 'assistant_text', text, timestamp: ts });
      }
    } else if (payload.type === 'function_call') {
      const callId = payload.call_id || `call_${++callSeq}`;
      currentTurn.events.push({
        kind: 'tool_call',
        callId,
        id: callId,
        name: payload.name || 'tool',
        input: normalizeToolInput(payload.arguments),
        timestamp: ts,
      });
    } else if (payload.type === 'function_call_output') {
      const callId = payload.call_id || `call_${++callSeq}`;
      currentTurn.events.push({
        kind: 'tool_result',
        callId,
        output: normalizeToolOutput(payload.output),
        timestamp: ts,
      });
    }
  }

  finalizeTurn();
  return entries;
}

export function parseLogEntriesContent(content) {
  const viewerEntries = parseViewerEntries(content);
  if (viewerEntries.length > 0) return viewerEntries;
  const codexEntries = parseCodexSessionEntries(content);
  return codexEntries;
}
