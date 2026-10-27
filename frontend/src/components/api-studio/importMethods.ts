/**
 * API Automation — the thirteen intake methods.
 *
 * One entry per way an API can arrive in the workspace. `inputs` says which
 * form the Import hub renders for it; `ai` marks the methods where the
 * platform's LLM reads the source (prose, code, docs pages) rather than a
 * deterministic parser.
 */
import {
  FileJson, Package, PackageOpen, Link2, Terminal, BookOpen, Puzzle, Code2, Webhook, Braces, Bot, Route, Send,
} from 'lucide-react';
import type { ImportMethod } from './types';

export type ImportInput = 'files' | 'url' | 'text' | 'probe' | 'graphql' | 'mcp' | 'webhook' | 'manual' | 'connector';

export interface ImportMethodDef {
  id: ImportMethod;
  label: string;
  short: string;
  /** One short line, shown on the card. */
  desc: string;
  /** The full explanation — shown only when the method's form is open. */
  detail: string;
  icon: React.ElementType;
  /** A vivid, brand-ish hue so each intake method reads in its own colour. */
  accent: string;
  inputs: ImportInput[];
  /** File extensions the file input accepts, when `files` is offered. */
  accept?: string;
  /** Format hint sent with a file/text import. */
  format?: string;
  ai?: boolean;
  placeholder?: string;
}

export const IMPORT_METHODS: ImportMethodDef[] = [
  { id: 'openapi', label: 'OpenAPI / Swagger', short: 'OpenAPI', desc: 'A spec file or its URL', detail: 'OpenAPI 3.x or Swagger 2.0 — JSON or YAML. Every path × method, with bodies and responses built from the schemas.', icon: FileJson, accent: '#10B981', inputs: ['files', 'url', 'text'], accept: '.json,.yaml,.yml', format: 'openapi', placeholder: 'Paste the OpenAPI / Swagger document (JSON or YAML)…' },
  { id: 'postman', label: 'Postman Collection', short: 'Postman', desc: 'A collection or HAR export', detail: 'Postman v2.0 / v2.1 exports and HAR recordings. Folders become resources; saved responses become the expected contract.', icon: Package, accent: '#F97316', inputs: ['files', 'text'], accept: '.json,.har', format: 'postman', placeholder: 'Paste the exported collection JSON…' },
  { id: 'bruno', label: 'Bruno Collection', short: 'Bruno', desc: 'A .bru file or whole collection', detail: 'Bruno `.bru` requests — one file or a whole collection. Drop the request files (with the optional collection.bru and environment files), or paste them together: collection-level auth and headers are inherited and {{variables}} resolve from the environment.', icon: PackageOpen, accent: '#EAB308', inputs: ['files', 'text'], accept: '.bru,.json', format: 'bruno', placeholder: 'Paste one or more .bru requests (optionally with collection.bru / environment files)…' },
  { id: 'endpoint', label: 'API URL / Endpoint', short: 'API URL', desc: 'One live URL, probed', detail: 'Give one live URL. It is probed for its real status and body, and the origin is searched for an OpenAPI document — when one is found the whole API comes in.', icon: Link2, accent: '#0EA5E9', inputs: ['probe'] },
  { id: 'curl', label: 'cURL', short: 'cURL', desc: 'Paste a command', detail: 'One command or a whole script of them — method, headers, auth and payload are parsed exactly.', icon: Terminal, accent: '#6366F1', inputs: ['text'], format: 'curl', placeholder: "curl -X POST https://api.acme.com/v1/orders \\\n  -H 'Content-Type: application/json' \\\n  -H 'Authorization: Bearer <token>' \\\n  -d '{\"sku\":\"A1\",\"qty\":2}'" },
  { id: 'docs-url', label: 'API Documentation URL', short: 'Docs URL', desc: 'A reference page, read by AI', detail: 'A reference page. Any spec it links to is used directly; otherwise the page text is read and every documented endpoint extracted.', icon: BookOpen, accent: '#F59E0B', inputs: ['url'], ai: true },
  { id: 'connector', label: 'Custom Connector', short: 'Connector', desc: 'A portable JSON manifest', detail: 'A portable JSON manifest your team keeps next to the code: base URL, auth, headers and an endpoints list. Round-trips the catalogue export.', icon: Puzzle, accent: '#D946EF', inputs: ['connector', 'files'], accept: '.json,.yaml,.yml', format: 'connector' },
  { id: 'sdk', label: 'SDK', short: 'SDK', desc: 'Client library source', detail: 'Client-library source (TypeScript, Python, Java, C#, Go…). Every method that issues an HTTP call becomes an endpoint.', icon: Code2, accent: '#14B8A6', inputs: ['files', 'text'], accept: '.ts,.js,.py,.java,.cs,.go,.rb,.php,.kt,.txt,.md', format: 'sdk', ai: true, placeholder: 'Paste the SDK / client source…' },
  { id: 'webhook', label: 'Webhook', short: 'Webhook', desc: 'Your consumer endpoint + events', detail: 'The consumer endpoint your system exposes plus the event payloads it should accept. Deliveries are HMAC-signed with your secret.', icon: Webhook, accent: '#F43F5E', inputs: ['webhook'] },
  { id: 'graphql', label: 'GraphQL', short: 'GraphQL', desc: 'Introspect the schema', detail: 'Introspects the schema and creates one operation per Query and Mutation field with a ready selection set.', icon: Braces, accent: '#EC4899', inputs: ['graphql', 'text'], format: 'graphql', placeholder: 'Or paste the SDL schema…' },
  { id: 'mcp', label: 'MCP Server', short: 'MCP', desc: 'A server’s tools, imported', detail: 'A Model Context Protocol server over Streamable HTTP. The handshake, tools/list and one tools/call per tool are imported.', icon: Bot, accent: '#7C3AED', inputs: ['mcp'] },
  { id: 'middleware', label: 'Middleware', short: 'Middleware', desc: 'Server route definitions', detail: 'Server route definitions — Express/Nest/Fastify, Spring, FastAPI/Flask, ASP.NET, gateway route tables. Every registered route becomes an endpoint.', icon: Route, accent: '#06B6D4', inputs: ['files', 'text'], accept: '.ts,.js,.py,.java,.cs,.go,.rb,.php,.kt,.yaml,.yml,.json,.txt', format: 'middleware', ai: true, placeholder: 'Paste the router / controller source…' },
  { id: 'manual', label: 'Manual HTTP Request', short: 'Manual', desc: 'Build one request by hand', detail: 'Build one request by hand — method, URL, params, headers, auth, body and the expected response.', icon: Send, accent: '#3B82F6', inputs: ['manual'] },
];

/** File types the bulk drop zone accepts (documents + machine-readable). */
export const BULK_ACCEPT = '.json,.yaml,.yml,.xml,.wsdl,.bru,.har,.pdf,.docx,.doc,.xlsx,.xls,.csv,.md,.markdown,.txt,.ts,.js,.py,.java,.cs,.go,.graphql,.gql';
