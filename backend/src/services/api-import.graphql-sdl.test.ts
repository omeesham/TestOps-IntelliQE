/**
 * Unit tests for the deterministic GraphQL SDL importer (parseGraphqlSdl).
 * Pure-function tests — no LLM, no network. Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { parseGraphqlSdl } from './api-import.service.js';

const SDL = `
type User {
  id: ID!
  name: String!
  email: String
}

input UserFilter {
  role: Role
  limit: Int
}

enum Role {
  ADMIN
  USER
}

type Query {
  user(id: ID!): User
  users(filter: UserFilter): [User!]!
}

type Mutation {
  createUser(name: String!): User
}
`;

describe('parseGraphqlSdl', () => {
  const r = parseGraphqlSdl(SDL);
  const user = r.endpoints.find((e) => e.operationId === 'user')!;
  const createUser = r.endpoints.find((e) => e.operationId === 'createUser')!;

  it('labels the format and emits one operation per Query/Mutation field', () => {
    expect(r.format).toBe('GraphQL SDL');
    expect(r.parser).toBe('graphql');
    expect(r.endpoints.map((e) => e.operationId).sort()).toEqual(['createUser', 'user', 'users']);
  });

  it('builds POST endpoints with a graphql style and JSON headers', () => {
    expect(user.method).toBe('POST');
    expect(user.style).toBe('graphql');
    expect(user.headers.some((h) => h.key.toLowerCase() === 'content-type' && /json/i.test(h.value))).toBe(true);
    expect(user.expectedStatus).toBe(200);
  });

  it('groups queries and mutations by tag/resource', () => {
    expect(user.tags).toEqual(['query']);
    expect(user.resource).toBe('queries');
    expect(createUser.tags).toEqual(['mutation']);
    expect(createUser.resource).toBe('mutations');
  });

  it('writes a {query,variables} body with args and a selection set', () => {
    const payload = JSON.parse(user.body!);
    expect(payload).toHaveProperty('query');
    expect(payload).toHaveProperty('variables');
    expect(payload.query).toMatch(/query\s*\{\s*user\(id:/);
    // Scalar fields of the return type are selected.
    expect(payload.query).toContain('id');
    expect(payload.query).toContain('name');
    const mut = JSON.parse(createUser.body!);
    expect(mut.query).toMatch(/mutation\s*\{\s*createUser\(name:/);
  });

  it('uses a placeholder URL and warns that the real URL must be set', () => {
    expect(user.url).toContain('api.example.com');
    expect(r.warnings.join(' ')).toMatch(/placeholder|URL/i);
  });

  it('surfaces a schema-type summary in the notice', () => {
    expect(r.notice).toMatch(/operation/i);
    expect(r.notice).toMatch(/object type|input|enum/i);
  });
});

describe('parseGraphqlSdl — custom root via schema block', () => {
  it('honours an explicit schema { query: Root } declaration', () => {
    const r = parseGraphqlSdl(`
schema { query: RootQuery }
type RootQuery {
  ping: String
}
`);
    expect(r.endpoints).toHaveLength(1);
    expect(r.endpoints[0]!.operationId).toBe('ping');
  });

  it('warns when no Query or Mutation type is present', () => {
    const r = parseGraphqlSdl(`type User { id: ID! }`);
    expect(r.endpoints).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/No Query or Mutation/i);
  });
});
