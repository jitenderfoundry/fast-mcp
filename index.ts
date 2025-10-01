import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import { loadToolsFromConfigs, createCollectionsTool } from "./create_tools.js";
import { uuid } from "zod/v4";

const app = express();
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    server: 'fast-mcp'
  });
});

// MCP endpoint
app.post('/mcp', async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`[HTTP] Received MCP request ${requestId}`);
  
  try {
    // Create a new server instance for this request to avoid conflicts
    const server = new McpServer(
      {
        name: "fast-mcp",
        version: "0.2.0",
      },
      {
        capabilities: {
          tools: {},
          logging: {},
        },
      }
    );

    // Load tools from YAML configs
    await loadToolsFromConfigs(server);
    
    // Add the collections tool
    createCollectionsTool(server);


    // Create transport for this request
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    // Handle request cleanup
    res.on('close', () => {
      console.log(`[HTTP] Request ${requestId} closed`);
      transport.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    console.log(`[HTTP] Request ${requestId} completed successfully`);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Fast MCP Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Shutting down server...");
  process.exit(0);
});

