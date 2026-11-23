/** SEP-3415 final / ext-events Beta; offline wire fixtures, no delivery calls. */
export const finalEventsDiscover = {
  resultType: 'complete',
  supportedVersions: ['2026-07-28'],
  capabilities: {
    extensions: { 'io.modelcontextprotocol/events': { listChanged: true } },
  },
};
export const finalEventsPages = [
  {
    resultType: 'complete',
    events: [
      {
        name: 'deployment.finished',
        delivery: ['poll', 'push'],
        inputSchema: {
          type: 'object',
          properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
        },
        payloadSchema: {
          type: 'object',
          properties: { status: { type: 'string' } },
        },
      },
    ],
    nextCursor: 'page-2',
  },
  {
    resultType: 'complete',
    events: [
      {
        name: 'incident.created',
        delivery: ['webhook'],
        payloadSchema: { type: 'object' },
      },
    ],
  },
];
