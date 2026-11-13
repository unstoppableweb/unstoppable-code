import { runCanopyTransportConformance } from '@canopy/core-transport';

import { createHttpFramedPair } from './fixtures/http-pair';

// Client-side HTTP binding conformance; see the fixture for what it proves.
runCanopyTransportConformance({
  name: 'http (client binding)',
  createPair: createHttpFramedPair,
  describe,
  it,
  todo: it.todo,
  byteWire: false,
  serverClose: false,
});
