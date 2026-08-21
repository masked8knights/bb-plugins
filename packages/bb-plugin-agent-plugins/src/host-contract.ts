import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { ExperimentalHostSignals } from "@get-bb/plugin-sdk/host";
import { z } from "zod";

const jsonRecordSchema = z.record(z.string(), z.unknown());

const catalogSchema = z.object({
  tools: z.array(jsonRecordSchema),
  prompts: z.array(jsonRecordSchema),
  resources: z.array(jsonRecordSchema),
  resourceTemplates: z.array(jsonRecordSchema),
}).strict();

const serverKeySchema = z.string().min(1).max(512);

const stdioConfigSchema = z.object({
  key: serverKeySchema,
  command: z.string().min(1).max(16_384),
  args: z.array(z.string().max(16_384)).max(256),
  cwd: z.string().min(1).max(16_384),
  env: z.record(z.string(), z.string().max(16_384)),
}).strict();

const operationSchema = z.object({ key: serverKeySchema }).strict();

export const mcpHostContract = defineRpcContract({
  start: {
    input: stdioConfigSchema,
    output: catalogSchema,
  },
  refresh: {
    input: operationSchema,
    output: catalogSchema,
  },
  close: {
    input: operationSchema,
    output: z.object({ closed: z.boolean() }).strict(),
  },
  callTool: {
    input: z.object({
      key: serverKeySchema,
      name: z.string().min(1).max(512),
      args: jsonRecordSchema,
      toolDefinition: jsonRecordSchema.optional(),
    }).strict(),
    output: jsonRecordSchema,
  },
  getPrompt: {
    input: z.object({ key: serverKeySchema, name: z.string().min(1).max(512), args: jsonRecordSchema }).strict(),
    output: jsonRecordSchema,
  },
  readResource: {
    input: z.object({ key: serverKeySchema, uri: z.string().min(1).max(16_384) }).strict(),
    output: jsonRecordSchema,
  },
  complete: {
    input: z.object({ key: serverKeySchema, ref: jsonRecordSchema, argument: jsonRecordSchema }).strict(),
    output: jsonRecordSchema,
  },
  subscribeResource: {
    input: z.object({ key: serverKeySchema, uri: z.string().min(1).max(16_384) }).strict(),
    output: z.object({ subscribed: z.boolean() }).strict(),
  },
  unsubscribeResource: {
    input: z.object({ key: serverKeySchema, uri: z.string().min(1).max(16_384) }).strict(),
    output: z.object({ unsubscribed: z.boolean() }).strict(),
  },
  setLoggingLevel: {
    input: z.object({ key: serverKeySchema, level: z.string().min(1).max(32) }).strict(),
    output: z.object({ updated: z.boolean() }).strict(),
  },
});

export const mcpHostSignals = {
  catalogChanged: {
    payload: z.object({
      key: serverKeySchema,
      kind: z.enum(["tools", "prompts", "resources"]),
      error: z.string().nullable(),
    }).strict(),
  },
  connectionChanged: {
    payload: z.object({
      key: serverKeySchema,
      status: z.enum(["closed", "error"]),
      error: z.string().nullable(),
    }).strict(),
  },
} satisfies ExperimentalHostSignals;

export type McpHostCatalog = {
  tools: Array<Record<string, unknown>>;
  prompts: Array<Record<string, unknown>>;
  resources: Array<Record<string, unknown>>;
  resourceTemplates: Array<Record<string, unknown>>;
};
