const internals = window.__TAURI_INTERNALS__;
const cwd = (await internals.invoke("alfred_invoke", { command: "app.info", args: {} }).catch(() => null))?.home;
const run = async (provider, requests) => {
  const started = Date.now();
  const received = [];
  let resolveLine;
  const waiters = [];
  const callback = internals.transformCallback((raw) => {
    const message = raw && "message" in raw ? raw.message : raw;
    if (!message || raw.end) return;
    received.push(message);
    for (const waiter of waiters.splice(0)) waiter();
  });
  const { session } = await internals.invoke("alfred_agent_spawn", {
    args: { provider, cwd },
    onEvent: `__CHANNEL__:${callback}`,
  });
  const log = [];
  for (const request of requests) {
    await internals.invoke("alfred_invoke", { command: "agents.write", args: { session, data: JSON.stringify(request) + "\n" } });
    if (request.id === undefined) continue;
    const deadline = Date.now() + 60000;
    let answer;
    while (!answer && Date.now() < deadline) {
      answer = received.find((m) => m.kind === "stdout" && (() => { try { return JSON.parse(m.line).id === request.id; } catch { return false; } })());
      if (!answer) await new Promise((r) => { waiters.push(r); setTimeout(r, 500); });
    }
    log.push(`${request.method}: ${answer ? `réponse en ${((Date.now() - started) / 1000).toFixed(1)} s` : "AUCUNE RÉPONSE"}`);
    if (!answer) break;
  }
  await internals.invoke("alfred_invoke", { command: "agents.kill", args: { session } });
  const stdout = received.filter((m) => m.kind === "stdout").length;
  const stderr = received.filter((m) => m.kind === "stderr").map((m) => m.chunk).join("").slice(-400);
  return { provider, log, stdoutLines: stdout, stderr };
};
const codex = await run("codex", [
  { method: "initialize", id: 1, params: { clientInfo: { name: "alfred", title: "Alfred", version: "0.1.1" }, capabilities: null } },
  { method: "initialized", params: {} },
  { method: "thread/start", id: 2, params: { cwd, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: true } },
  { method: "model/list", id: 3, params: { limit: 100 } },
]);
const opencode = await run("opencode", [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "alfred", version: "0.1.1" } } },
  { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } },
]);
return { cwd, codex, opencode };
