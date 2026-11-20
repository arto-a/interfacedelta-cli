import type { McpEvents } from '@interfacedelta/contracts';
export const mcpEventsFixture: McpEvents = {
  version: 'mcp-events-v1',
  declared: true,
  complete: true,
  deliveryModes: ['poll', 'stream', 'webhook'],
  eventTypes: [
    'deployment.succeeded',
    'deployment.error',
    'deployment.started',
  ].map((name) => ({
    name,
    payloadSchemaSha256: 'a'.repeat(64),
    deliveryModes: ['poll', 'stream', 'webhook'],
  })),
};
