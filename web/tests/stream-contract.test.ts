import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStreamFrame, nextResumeSequence } from "../lib/stream-contract";
import { UnifiedWSClient } from "../lib/unified-ws";

test("every backend event kind is accepted by the browser contract", () => {
  const source = readFileSync(join(process.cwd(), "../cognivoy/core/stream.py"), "utf8");
  const enumBlock = source.split("class StreamEventType")[1].split("@dataclass")[0];
  const kinds = [...enumBlock.matchAll(/^\s+[A-Z_]+ = "([a-z_]+)"/gm)].map((match) => match[1]);
  assert.ok(kinds.includes("content") && kinds.includes("wait_for_input"));
  for (const type of kinds) {
    const event = parseStreamFrame(JSON.stringify({ type }));
    assert.ok(event && event !== "heartbeat", `unsupported backend event: ${type}`);
  }
});

test("invalid wire envelopes cannot enter the event consumer", () => {
  for (const value of [null, [], 2, { type: "future" },
    { type: "content", content: {} }, { type: "content", metadata: [] },
    { type: "content", turn_id: 42 }, { type: "content", seq: "9" },
    { type: "content", seq: -1 }, { type: "content", seq: 1.5 },
    { type: "content", seq: Number.MAX_SAFE_INTEGER + 1 },
    { type: "content", seq: 100 },
    { type: "session", metadata: { session_id: {} } },
    { type: "content", timestamp: -1 }]) {
    assert.equal(parseStreamFrame(JSON.stringify(value)), null);
  }
  assert.equal(parseStreamFrame("{"), null);
  assert.equal(parseStreamFrame(new ArrayBuffer(2)), null);
});

test("lightweight errors and input pauses retain backend compatibility", () => {
  const event = parseStreamFrame('{"type":"error","content":"Invalid JSON."}');
  assert.ok(event && event !== "heartbeat");
  assert.equal(event.content, "Invalid JSON.");
  assert.deepEqual(event.metadata, {});
  assert.ok(parseStreamFrame('{"type":"wait_for_input","metadata":{"questions":[]}}'));
  assert.equal(parseStreamFrame('{"type":"pong"}'), "heartbeat");
});

test("resume cursor resets between turns and remains monotonic within a turn", () => {
  const event = parseStreamFrame('{"type":"content","turn_id":"new","seq":1}');
  assert.ok(event && event !== "heartbeat");
  assert.equal(nextResumeSequence("old", 900, event), 1);
  assert.equal(nextResumeSequence("new", 9, event), 9);
  assert.equal(nextResumeSequence("new", 0, event), 1);
});

test("wire rejection never poisons reconnect state or delivers private raw frames", () => {
  const original = globalThis.WebSocket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    sent: string[] = [];
    static instances: Socket[] = [];
    constructor() { Socket.instances.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const received: string[] = [];
  const client = new UnifiedWSClient((event) => received.push(event.content));
  try {
    client.setResumeState("old", 900);
    client.connect();
    const first = Socket.instances[0];
    first.onmessage?.({ data: '{"type":"content","turn_id":"bad","seq":"secret"}' });
    first.close();
    client.connect();
    const second = Socket.instances[1];
    second.onopen?.();
    assert.deepEqual(JSON.parse(second.sent[0]), { type: "resume_from", turn_id: "old", seq: 900 });
    second.onmessage?.({ data: '{"type":"content","turn_id":"new","seq":1,"content":"answer"}' });
    second.onmessage?.({ data: '{"type":"pong"}' });
    second.close();
    client.connect();
    const third = Socket.instances[2];
    third.onopen?.();
    assert.deepEqual(JSON.parse(third.sent[0]), { type: "resume_from", turn_id: "new", seq: 1 });
    assert.deepEqual(received, ["answer"]);
  } finally {
    client.disconnect();
    globalThis.WebSocket = original;
  }
});
