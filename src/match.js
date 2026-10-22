import { DurableObject } from "cloudflare:workers";

const MAX_PER_SECOND = 60;              // a pad sends only on change; more than this is abuse

// One match. The host screen runs both Game Boys; each phone is the controller of one
// player. A pad sends one binary byte of buttons; the host receives [player, buttons].
// Seats are socket tags: "host", "pad:1", "pad:2". Nothing is stored, so nothing is lost
// when the object hibernates or restarts; pads resend their state when they reconnect.
export class Match extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.rate = new Map();              // socket -> { tokens, at }; rebuilt after hibernation
  }

  async fetch(request) {
    const seat = request.headers.get("X-Seat");
    if (seat !== "host" && seat !== "pad:1" && seat !== "pad:2") return new Response(null, { status: 400 });
    for (const old of this.ctx.getWebSockets(seat)) old.close(4000, "replaced");
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [seat]);
    server.serializeAttachment({ seat });
    if (seat === "host") {
      server.send(JSON.stringify({ t: "pads", on: this.padsOnline() }));
    } else {
      this.toHost(JSON.stringify({ t: "pad", player: Number(seat[4]), on: true }));
    }
    console.log(JSON.stringify({ msg: "join", seat }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const { seat } = ws.deserializeAttachment();
    if (seat === "host") return;                          // the host only listens
    if (typeof message === "string" || message.byteLength !== 1) return ws.close(1003, "one byte expected");
    if (!this.allow(ws)) return;
    this.toHost(new Uint8Array([Number(seat[4]), new Uint8Array(message)[0]]));
  }

  async webSocketClose(ws) {
    this.rate.delete(ws);
    const { seat } = ws.deserializeAttachment() ?? {};
    if (seat?.startsWith("pad:")) {
      const on = this.ctx.getWebSockets(seat).some((s) => s !== ws);
      this.toHost(JSON.stringify({ t: "pad", player: Number(seat[4]), on }));
    }
  }

  async webSocketError(ws, error) {
    console.error(JSON.stringify({ msg: "ws_error", error: String(error) }));
  }

  padsOnline() {
    return [1, 2].filter((n) => this.ctx.getWebSockets(`pad:${n}`).length > 0);
  }

  toHost(data) {
    for (const ws of this.ctx.getWebSockets("host")) {
      try { ws.send(data); } catch { /* closing */ }
    }
  }

  // Token bucket per socket: MAX_PER_SECOND messages, refilled continuously.
  allow(ws) {
    const now = Date.now();
    const b = this.rate.get(ws) ?? { tokens: MAX_PER_SECOND, at: now };
    b.tokens = Math.min(MAX_PER_SECOND, b.tokens + ((now - b.at) * MAX_PER_SECOND) / 1000);
    b.at = now;
    this.rate.set(ws, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
