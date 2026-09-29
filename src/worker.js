const ROOM_TTL_MS = 10 * 60 * 1000;

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/check") {
      if (this.state.getWebSockets("viewer").length === 0) {
        return Response.json({ valid: false, reason: "not-found" }, { status: 404 });
      }
      if (this.state.getWebSockets("sender").length > 0) {
        return Response.json({ valid: false, reason: "in-use" }, { status: 409 });
      }
      return Response.json({ valid: true });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const role = url.searchParams.get("role");
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
    if (role === "viewer") {
      await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    } else {
      await this.state.storage.deleteAlarm();
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

  async alarm() {
    if (this.state.getWebSockets("sender").length > 0) return;
    for (const ws of this.state.getWebSockets("viewer")) {
      try {
        ws.close(1000, "expired");
      } catch (e) {}
    }
  }

  webSocketMessage(ws, message) {
    const [role] = this.state.getTags(ws);
    this.relay(role === "viewer" ? "sender" : "viewer", message);
  }

  async webSocketClose(ws, code) {
    const [role] = this.state.getTags(ws);
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch (e) {}
    if (role === "sender") {
      this.relay("viewer", JSON.stringify({ type: "peer-left" }));
      if (this.state.getWebSockets("viewer").length > 0) {
        await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      }
    } else {
      await this.state.storage.deleteAlarm();
      for (const s of this.state.getWebSockets("sender")) {
        try {
          s.close(1000, "viewer-left");
        } catch (e) {}
      }
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws" && url.pathname !== "/check") {
      return new Response("SimpleCast signaling server", { status: 200 });
    }
    const origin = request.headers.get("Origin");
    const allowedOrigins = (env.ALLOWED_ORIGIN || "")
      .split(",")
      .map((o) => o.trim().replace(/\/$/, ""))
      .filter(Boolean);
    if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
      return new Response("Forbidden", { status: 403 });
    }
    const code = (url.searchParams.get("code") || "").toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      if (url.pathname === "/check") {
        return Response.json(
          { valid: false, reason: "invalid-format" },
          { status: 400, headers: corsHeaders(origin) }
        );
      }
      return new Response("Invalid code", { status: 400 });
    }
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    const res = await stub.fetch(request);
    if (url.pathname === "/check") {
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
      headers.set("Cache-Control", "no-store");
      return new Response(res.body, { status: res.status, headers });
    }
    return res;
  },
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    Vary: "Origin",
  };
}
