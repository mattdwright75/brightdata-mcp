// Smoke test for the HTTP deployment: lists tools and runs cheap calls.
// Usage: MCP_URL=... MCP_AUTH=... node test-helpers/smoke-http.mjs [tool args-json]...
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport}
    from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.MCP_URL || 'http://127.0.0.1:3099/mcp';
const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {headers: {Authorization: `Bearer ${process.env.MCP_AUTH}`}},
});
const client = new Client({name: 'smoke', version: '1.0.0'});
await client.connect(transport);
const {tools} = await client.listTools();
console.log(`${tools.length} tools:`, tools.map(t=>t.name).join(', '));
const calls = process.argv.slice(2);
for (let i = 0; i<calls.length; i += 2)
{
    const name = calls[i];
    const args = JSON.parse(calls[i+1]||'{}');
    const started = Date.now();
    try {
        const res = await client.callTool({name, arguments: args}, undefined,
            {timeout: 600000});
        const text = res.content?.map(c=>c.text||`[${c.type}]`).join('\n')||'';
        console.log(`\n== ${name} (${Date.now()-started}ms)`
            +`${res.isError ? ' ERROR' : ''}\n${text.slice(0, 700)}`);
    } catch(e){
        console.log(`\n== ${name} THREW: ${e.message}`);
    }
}
await client.close();
