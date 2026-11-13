import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ENGINE = "repro-import-conditions-engine";
const MARKER = "REQUIRE_ENTRY_SELECTED";
const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "node_modules", "e2e", "dist", "cli", "bin.js");

let watchdog;
const timeout = new Promise((_, reject) => {
  watchdog = setTimeout(() => {
    reject(new Error("timed out after 60s"));
  }, 60000);
});
timeout.catch(() => {});

async function checkNativeImport() {
  const mod = await import(ENGINE);
  const handle = typeof mod.default === "function" ? mod.default() : undefined;
  if (!handle || handle.name !== "import-entry") {
    throw new Error("native import did not yield the import-entry factory");
  }
  console.log("native import: import entry, factory name " + handle.name);
}

async function main() {
  await checkNativeImport();
  if (!existsSync(bin)) {
    throw new Error("missing " + bin + "; run npm install first");
  }

  const child = spawn(process.execPath, [bin, "mcp"], {
    env: { ...process.env, E2E_TELEMETRY_DISABLED: "1" },
    cwd: here,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await Promise.race([spawned, timeout]);
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
  });
  const lines = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  })[Symbol.asyncIterator]();
  let nextId = 1;

  async function request(method, params) {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (;;) {
      const next = await Promise.race([lines.next(), timeout]);
      if (next.done) {
        throw new Error("server stdout closed before the response to " + method);
      }
      let message;
      try {
        message = JSON.parse(next.value);
      } catch {
        continue;
      }
      if (message.id !== id) {
        continue;
      }
      if (message.error) {
        throw new Error(method + " failed: " + JSON.stringify(message.error));
      }
      return message.result;
    }
  }

  async function call(name, args) {
    const result = await request("tools/call", { name, arguments: args });
    const text = (result.content ?? [])
      .map((part) => part.text ?? "")
      .join("\n");
    return { isError: result.isError === true, text };
  }

  async function close(label) {
    const closed = await call("close_session", {});
    if (closed.isError) {
      throw new Error(label + " close_session failed: " + closed.text);
    }
    console.log(label + " close_session: ok");
  }

  let open = false;
  try {
    const init = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mcp-import-conditions-repro", version: "1.0.0" },
    });
    console.log(
      "initialize: " + JSON.stringify(init.serverInfo) + ", protocol " + init.protocolVersion,
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );

    const control = await call("open_session", { engine: ENGINE + "/esm" });
    if (control.isError) {
      console.log("control open_session (" + ENGINE + "/esm) failed: " + control.text);
      console.log("RESULT: setup failure, the unconditional ESM control did not open");
      return 2;
    }
    open = true;
    console.log("control open_session (" + ENGINE + "/esm): ok");
    await close("control");
    open = false;

    const actual = await call("open_session", { engine: ENGINE });
    if (!actual.isError) {
      open = true;
      console.log("main open_session (" + ENGINE + "): ok");
      await close("main");
      open = false;
      console.log("RESULT: import entry loaded, resolution correct");
      return 0;
    }
    console.log("main open_session (" + ENGINE + ") error: " + actual.text);
    if (actual.text.includes(MARKER)) {
      console.log("RESULT: require entry loaded (" + MARKER + "), bug reproduced");
      return 1;
    }
    console.log("RESULT: unrelated failure, inconclusive");
    return 2;
  } finally {
    if (open) {
      await close("cleanup").catch((error) => {
        console.log("cleanup: " + error.message);
      });
    }
    child.stdin.end();
    child.kill("SIGTERM");
    const grace = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5000);
    await exited;
    clearTimeout(grace);
    if (stderr.trim() !== "") {
      console.log("server stderr:\n" + stderr.trim());
    }
  }
}

main()
  .then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.log("RESULT: setup failure, " + error.message);
      process.exitCode = 2;
    },
  )
  .finally(() => {
    clearTimeout(watchdog);
  });
