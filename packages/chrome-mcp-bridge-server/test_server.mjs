import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { createServer } from "http";

const server = new McpServer({ name: "test", version: "0.1.0" });

// Register test tools
server.registerTool(
  "test_empty",
  { description: "Test with empty schema", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: "ok" }] })
);

server.registerTool(
  "test_with_args",
  { 
    description: "Test with args", 
    inputSchema: { name: z.string(), count: z.number().optional() } 
  },
  async () => ({ content: [{ type: "text", text: "ok" }] })
);

// Simulate a page tool with buildZodSchema
function buildZodSchema(inputSchema) {
  if (!inputSchema || !inputSchema.properties || Object.keys(inputSchema.properties).length === 0) {
    return {};
  }
  const shape = {};
  for (const [key, prop] of Object.entries(inputSchema.properties)) {
    let field;
    if (prop.type === "number" || prop.type === "integer") {
      field = z.number();
    } else if (prop.type === "boolean") {
      field = z.boolean();
    } else if (prop.type === "array") {
      field = z.array(z.any());
    } else if (prop.type === "object") {
      field = z.record(z.any());
    } else {
      if (prop.enum && Array.isArray(prop.enum)) {
        field = z.enum(prop.enum.map(String));
      } else {
        field = z.string();
      }
    }
    if (prop.description) {
      field = field.describe(prop.description);
    }
    const required = inputSchema.required || [];
    if (!required.includes(key)) {
      field = field.optional();
    }
    shape[key] = field;
  }
  return shape;
}

// Register a page-style tool
const pageToolSchema = buildZodSchema({
  type: "object",
  properties: {
    selector: { type: "string", description: "CSS selector" },
    limit: { type: "number", description: "Max results" }
  },
  required: ["selector"]
});

server.registerTool(
  "page_tool",
  { description: "A page tool", inputSchema: pageToolSchema },
  async () => ({ content: [{ type: "text", text: "ok" }] })
);

// Start SSE server
const sseTransports = new Map();
const httpServer = createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0];

  if (req.method === "GET" && urlPath === "/sse") {
    console.log("SSE client connected");
    const transport = new SSEServerTransport("/message", res);
    sseTransports.set(transport.sessionId, { transport });
    
    transport.onclose = () => {
      sseTransports.delete(transport.sessionId);
      console.log("SSE client disconnected");
    };

    try {
      await server.connect(transport);
      console.log("SSE connected, session:", transport.sessionId);
    } catch (err) {
      console.log("SSE connect error:", err.message);
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/message") {
    const sessionId = new URL(req.url, "http://localhost").searchParams.get("sessionId");
    const entry = sessionId ? sseTransports.get(sessionId) : undefined;
    if (!entry) {
      res.writeHead(400).end("No session");
      return;
    }
    try {
      await entry.transport.handlePostMessage(req, res);
    } catch (err) {
      console.log("POST error:", err.message);
    }
    return;
  }
});

httpServer.listen(9876, "127.0.0.1", () => {
  console.log("Test server on http://127.0.0.1:9876");
});
