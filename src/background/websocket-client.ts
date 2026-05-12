import { WEBSOCKET_URL, KEEPALIVE_ALARM_NAME, KEEPALIVE_INTERVAL_MINUTES } from '../shared/constants.js';
import { CommandRequest } from '../shared/types.js';

const RECONNECT_ALARM = 'ws-reconnect';
const RECONNECT_DELAYS_SEC = [1, 2, 4, 8, 16, 30]; // seconds

type MessageHandler = (request: CommandRequest) => Promise<void>;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private messageHandler: MessageHandler | null = null;
  private _isConnected = false;
  private connecting = false;

  get isConnected(): boolean {
    return this._isConnected;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  connect(): void {
    if (this.connecting) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.connecting = true;

    try {
      this.ws = new WebSocket(WEBSOCKET_URL);

      this.ws.onopen = () => {
        console.log('[WS] Connected to MCP server');
        this._isConnected = true;
        this.connecting = false;
        this.reconnectAttempt = 0;
        chrome.alarms.clear(RECONNECT_ALARM);
        chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: KEEPALIVE_INTERVAL_MINUTES });
        // Identify ourselves to the broker so it knows we're the extension side
        this.send({ type: 'hello', role: 'extension' });
      };

      this.ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data as string) as CommandRequest;
          if (data.type === 'request' && this.messageHandler) {
            await this.messageHandler(data);
          }
        } catch (err) {
          console.error('[WS] Failed to handle message:', err);
        }
      };

      this.ws.onclose = () => {
        const wasConnected = this._isConnected;
        this._isConnected = false;
        this.connecting = false;
        this.ws = null;
        if (wasConnected) {
          console.log('[WS] Disconnected from MCP server');
        }
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // onclose fires after this — reconnect is handled there
        // Suppress noisy console output for expected connection refusals
        this.connecting = false;
      };
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
    }
  }

  send(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private scheduleReconnect(): void {
    const delaySec = RECONNECT_DELAYS_SEC[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_SEC.length - 1)];
    this.reconnectAttempt++;
    // Use chrome.alarms instead of setTimeout — survives service worker suspension
    chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: delaySec / 60 });
  }

  handleAlarm(alarmName: string): void {
    if (alarmName === RECONNECT_ALARM) {
      this.connect();
    }
    if (alarmName === KEEPALIVE_ALARM_NAME) {
      this.ensureConnected();
    }
  }

  ensureConnected(): void {
    if (!this._isConnected && !this.connecting) {
      this.connect();
    }
  }

  disconnect(): void {
    chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
    chrome.alarms.clear(RECONNECT_ALARM);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._isConnected = false;
    this.connecting = false;
  }
}

export const wsClient = new WebSocketClient();
