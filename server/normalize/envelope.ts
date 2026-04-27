export class EnvelopeMalformedError extends Error {
  constructor(reason: string) {
    super(`Envelope malformed: ${reason}`);
    this.name = 'EnvelopeMalformedError';
  }
}

export type FlatEvent = {
  event: string;
  trace: string;
  business: unknown;
};

export function flatten(envelope: unknown): FlatEvent {
  if (!envelope || typeof envelope !== 'object') {
    throw new EnvelopeMalformedError('envelope is not an object');
  }
  const payload = (envelope as Record<string, unknown>).payload;
  if (!payload || typeof payload !== 'object') {
    throw new EnvelopeMalformedError('layer 1 (envelope.payload) missing');
  }
  const layer1 = payload as Record<string, unknown>;
  const event = layer1.event_name;
  const trace = layer1.correlation_id;
  if (typeof event !== 'string' || event === '') {
    throw new EnvelopeMalformedError('event_name missing or empty');
  }
  if (typeof trace !== 'string') {
    throw new EnvelopeMalformedError('correlation_id missing');
  }
  const layer2 = layer1.payload;
  if (!layer2 || typeof layer2 !== 'object') {
    throw new EnvelopeMalformedError('layer 2 (RaasMessage.data) missing');
  }
  const business = (layer2 as Record<string, unknown>).payload;
  if (business === undefined) {
    throw new EnvelopeMalformedError('layer 3 (business payload) missing');
  }
  return { event, trace, business };
}
