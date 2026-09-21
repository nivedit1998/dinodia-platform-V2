// Architecture: Shared platform helper src/lib/haWebSocket.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import WebSocket from 'ws';
import type { HaConnectionLike } from '@/lib/homeAssistant';
import { buildHaWebSocketBypassHeaders } from '@/lib/haServiceBypass';

type HaWsAuthRequired = { type: 'auth_required' };
type HaWsAuthOk = { type: 'auth_ok' };
type HaWsAuthInvalid = { type: 'auth_invalid'; message?: string };

function toWsUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = '/api/websocket';
  url.search = '';
  return url.toString();
}

export class HaWsClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: unknown) => void; timer: NodeJS.Timeout }
  >();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg && typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id)!;
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.type === 'result' && msg.success) {
          pending.resolve(msg.result);
        } else {
          pending.reject(msg);
        }
      }
    });
    ws.on('close', () => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('HA websocket closed'));
      }
      this.pending.clear();
    });
  }

  static async connect(ha: HaConnectionLike, timeoutMs = 7000): Promise<HaWsClient> {
    const wsUrl = toWsUrl(ha.baseUrl);
    const ws = new WebSocket(wsUrl, {
      headers: buildHaWebSocketBypassHeaders(wsUrl),
    });

    await new Promise<HaWsAuthRequired>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HA WS timeout waiting auth_required')), timeoutMs);
      ws.once('message', (buf) => {
        clearTimeout(timer);
        const msg = JSON.parse(buf.toString()) as HaWsAuthRequired;
        if (msg.type !== 'auth_required') {
          reject(new Error(`Unexpected HA WS first message: ${JSON.stringify(msg)}`));
        } else {
          resolve(msg);
        }
      });
      ws.once('error', reject);
    });

    ws.send(JSON.stringify({ type: 'auth', access_token: ha.longLivedToken }));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HA WS timeout waiting auth_ok')), timeoutMs);
      ws.once('message', (buf) => {
        clearTimeout(timer);
        const msg = JSON.parse(buf.toString()) as HaWsAuthOk | HaWsAuthInvalid;
        if (msg.type === 'auth_ok') {
          resolve();
        } else {
          reject(new Error(`HA WS auth failed: ${(msg as HaWsAuthInvalid).message || 'auth_invalid'}`));
        }
      });
      ws.once('error', reject);
    });

    return new HaWsClient(ws);
  }

  call<T>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 7000): Promise<T> {
    const id = this.nextId++;
    // Important: payloads like HA automation configs can include an `id` field.
    // Spread payload first so our WS request id always wins and response matching works.
    const message = { ...payload, id, type };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`HA WS request timeout: ${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.ws.send(JSON.stringify(message));
    });
  }

  close() {
    this.ws.close();
  }
}
