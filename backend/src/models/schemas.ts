import { z } from 'zod';

export const UIConfigSchema = z.object({
  appUrl: z.string().url(),
  loginUrl: z.string().url(),
  username: z.string(),
  password: z.string(),
  authType: z.enum(['form', 'oauth', 'sso']),
  browser: z.enum(['chromium', 'firefox', 'webkit']),
  environment: z.enum(['dev', 'qa', 'staging', 'prod']),
  sessionCookie: z.string().optional(),
  headers: z.string().optional(),
  featureFlags: z.string().optional(),
});

export const APIEndpointSchema = z.object({
  id: z.string(),
  uri: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
  headers: z.string(),
  body: z.string(),
  expectedStatus: z.number(),
});

export const APIConfigSchema = z.object({
  baseUrl: z.string().url(),
  authType: z.enum(['bearer', 'apikey', 'oauth']),
  authToken: z.string(),
  endpoints: z.array(APIEndpointSchema),
});

export const DataConfigSchema = z.object({
  sourceType: z.enum(['csv', 'database', 'datalake', 'api_feed']),
  fileLocation: z.string(),
  filePattern: z.string(),
  expectedSchema: z.array(z.string()),
  validationRules: z.object({
    nullCheck: z.boolean(),
    rangeValidation: z.boolean(),
    schemaValidation: z.boolean(),
    duplicateDetection: z.boolean(),
    crossFileValidation: z.boolean(),
  }),
});

export const E2EConfigSchema = z.object({
  appUrl: z.string().url(),
  apiBaseUrl: z.string().url(),
  dataSource: z.string(),
  environment: z.enum(['dev', 'qa', 'staging', 'prod']),
  credentials: z.object({ username: z.string(), password: z.string() }),
  testScenario: z.string(),
});

export const TestConfigSchema = z.object({
  testType: z.enum(['UI', 'API', 'DATA', 'E2E']),
  uiConfig: UIConfigSchema.optional(),
  apiConfig: APIConfigSchema.optional(),
  dataConfig: DataConfigSchema.optional(),
  e2eConfig: E2EConfigSchema.optional(),
  requirements: z.object({
    type: z.enum(['jira', 'brd', 'confluence', 'testspec', 'criteria']),
    value: z.string(),
  }).optional(),
});

export type TestConfig = z.infer<typeof TestConfigSchema>;
export type UIConfig = z.infer<typeof UIConfigSchema>;
export type APIConfig = z.infer<typeof APIConfigSchema>;
export type DataConfig = z.infer<typeof DataConfigSchema>;
