export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const role = new URL(request.url).searchParams.get("role");
    if (role !== "viewer" && role !== "sender") {
      return new Response("Bad role", { status: 400 });
    }
    if (this.state.getWebSockets(role).length > 0) {
      return new Response("Role already taken", { status: 409 });
    }
    if (role === "sender" && this.state.getWebSockets("viewer").length === 0) {
      return new Response("Room not found", { status: 404 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server, [role]);
    if (role === "sender") {
      this.relay("viewer", JSON.stringify({ type: "peer-joined" }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  relay(targetRole, message) {
    for (const ws of this.state.getWebSockets(targetRole)) {
      try {
        ws.send(message);
      } catch (e) {}
    }
  }

  webSocketMessage(ws, message) {
    const [role] = this.state.getTags(ws);
    this.relay(role === "viewer" ? "sender" : "viewer", message);
  }

  webSocketClose(ws, code) {
    const [role] = this.state.getTags(ws);
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch (e) {}
    if (role === "sender") {
      this.relay("viewer", JSON.stringify({ type: "peer-left" }));
    } else {
      for (const s of this.state.getWebSockets("sender")) {
        try {
          s.close(1000, "viewer-left");
        } catch (e) {}
      }
    }
  }

  webSocketError(ws) {
    this.webSocketClose(ws, 1011);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") {
      return new Response("SimpleCast signaling server", { status: 200 });
    }
    const origin = request.headers.get("Origin");
    if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) {
      return new Response("Forbidden", { status: 403 });
    }
    const code = (url.searchParams.get("code") || "").toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return new Response("Invalid code", { status: 400 });
    }
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    return stub.fetch(request);
  },
};
